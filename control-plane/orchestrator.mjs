import { join, resolve } from "node:path";
import { makeId, nowIso } from "./protocol.mjs";
import { writeLease } from "./process.mjs";
import { createRuntimeAdapter } from "./runtime-adapters.mjs";
import { captureGitEvidence, createMissionWorktree, createIsolatedWorktree, inspectRepository } from "./worktree.mjs";
import { runVerificationMatrix } from "./verification.mjs";
import { evaluateScope } from "./scope.mjs";
import {
  checkDuration,
  checkInactivity,
  checkRepeatedFailure,
  checkBudget,
} from "./guards.mjs";

function assignmentPrompt(assignment, inboundHandoffs) {
  const permission = assignment.write_intent
    ? "You may modify project files in the shared mission worktree."
    : "This is a read-only assignment. Do not create, modify, or delete project files. Return your result as a handoff for the next assignment.";
  const handoffs = inboundHandoffs.length
    ? `\n\nInbound handoffs:\n${inboundHandoffs
        .map(
          (handoff) =>
            `--- ${handoff.summary} (${handoff.handoff_id}) ---\n${handoff.content}`,
        )
        .join("\n\n")}`
    : "";
  return `${permission}\n\n${assignment.prompt}${handoffs}`;
}

export class ControlPlaneOrchestrator {
  constructor({
    store,
    worktreesRoot,
    runtimeAdapterFactory = createRuntimeAdapter,
    providerResolver = null,
  }) {
    this.store = store;
    this.worktreesRoot = worktreesRoot;
    this.runtimeAdapterFactory = runtimeAdapterFactory;
    this.providerResolver = providerResolver;
    this.active = new Map();
    this.workspacePreparing = new Map();
  }
  async startTask({
    taskId,
    taskRevision,
    repositoryRoot,
    runtimeId,
    prompt,
    runtimeOptions,
    requestedModel,
    executable,
    parentRunId,
    correctionDeltaId,
    resumeSessionId,
  }) {
    const task = this.store.getTask(taskId, taskRevision);
    if (!task) throw new Error(`Unknown task: ${taskId}@${taskRevision}`);
    let correction = null;
    if (task.state === "changes_requested") {
      if (!parentRunId || !correctionDeltaId)
        throw new Error(
          "A changes_requested task requires parentRunId and correctionDeltaId",
        );
      correction = this.store.getCorrection(correctionDeltaId);
      if (
        !correction ||
        correction.task_id !== task.task_id ||
        correction.task_revision !== task.revision ||
        correction.parent_run_id !== parentRunId
      )
        throw new Error(
          "CorrectionDelta does not match the task and parent run",
        );
    }
    if (task.state === "draft")
      this.store.transitionTask(taskId, taskRevision, "ready");
    const runId = makeId("run"),
      adapter = this.runtimeAdapterFactory(runtimeId),
      descriptor = await adapter.describe();
    for (const capability of task.execution.required_capabilities)
      if (!descriptor.capabilities[capability])
        throw new Error(
          `${runtimeId} lacks required capability: ${capability}`,
        );
    if (resumeSessionId && !descriptor.capabilities.resume_session)
      throw new Error(`${runtimeId} does not support resume_session`);
    const worktree = await this.#ensureMissionWorkspace(task, repositoryRoot);
    const run = this.store.createRun({
      run_id: runId,
      task_id: taskId,
      task_revision: taskRevision,
      role: "Worker",
      runtime_id: runtimeId,
      adapter_version: descriptor.adapter_version,
      repository_root: repositoryRoot,
      ...worktree,
      parent_run_id: parentRunId,
      correction_delta_id: correctionDeltaId,
      resume_session_id: resumeSessionId,
      requested_model: requestedModel,
      expected_model: task.execution.expected_model,
      runtime_capabilities: descriptor.capabilities,
      assigned_actor: { kind: "runtime", id: runtimeId },
    });
    this.store.transitionRun(runId, "preparing");
    this.store.transitionTask(taskId, taskRevision, "running");
    const basePrompt = prompt ?? task.goal;
    const executionPrompt = correction
      ? `${basePrompt}\n\nCorrectionDelta (authoritative):\n${JSON.stringify(correction, null, 2)}`
      : basePrompt;
    const active = {
      adapter,
      completion: null,
      handle: null,
      cancelRequested: false,
    };
    this.active.set(runId, active);
    const completion = this.#execute({
      runId,
      task,
      adapter,
      worktree,
      prompt: executionPrompt,
      runtimeOptions,
      requestedModel,
      executable,
      resumeSessionId,
    });
    active.completion = completion;
    void completion.finally(() => this.active.delete(runId)).catch(() => {});
    return { run: this.store.getRun(runId), completion };
  }
  async startAssignment({
    assignmentId,
    coordinatorSessionId,
    repositoryRoot,
    runtimeOptions,
    executable,
  }) {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) throw new Error(`Unknown Assignment: ${assignmentId}`);
    if (assignment.state !== "assigned")
      throw new Error(
        `Assignment must be assigned, observed ${assignment.state}`,
      );
        // Check DAG dependencies before starting
    if (assignment.depends_on && assignment.depends_on.length > 0) {
      const plan = this.store.getExecutionPlan(assignment.task_id, assignment.plan_revision);
      if (plan) {
        const { blocked, reason } = await this.#checkDagDependencies(assignment);
        if (blocked) {
          this.store.transitionAssignment(assignmentId, "blocked");
          throw new Error(`Assignment blocked by dependency: ${reason}`);
        }
      }
    }
    const task = this.store.getTask(
        assignment.task_id,
        assignment.task_revision,
      ),
      session = this.store.getSession(assignment.session_id);
    if (!task || !session)
      throw new Error("Assignment task or AgentSession is missing");
    this.store.requireLease(task.task_id, "coordinator", coordinatorSessionId);
    const adapter = this.runtimeAdapterFactory(assignment.profile.runtime_id),
      descriptor = await adapter.describe();
    for (const capability of task.execution.required_capabilities)
      if (!descriptor.capabilities[capability])
        throw new Error(
          `${assignment.profile.runtime_id} lacks required capability: ${capability}`,
        );
    const runId = makeId("run"),
      worktree = await this.#resolveWorkspace({
        policy: assignment.workspace_policy ?? "mission",
        task,
        repositoryRoot,
        runId,
      }),
      inboundHandoffs = this.store.listHandoffs(task.task_id, {
        toStageId: assignment.stage_id,
      }),
      executionPrompt = assignmentPrompt(assignment, inboundHandoffs);
    let writeLease = null;
    if (assignment.write_intent)
      writeLease = this.store.acquireLease(
        task.task_id,
        "workspace_write",
        session.session_id,
        { assignment_id: assignmentId, ttl_seconds: 86400 },
      );
    try {
      const providerLaunch = this.providerResolver
          ? this.providerResolver.resolve(assignment.profile, {
              runId,
              sessionId: session.session_id,
            })
          : { env: {}, route: null },
        run = this.store.createRun({
          run_id: runId,
          task_id: task.task_id,
          task_revision: task.revision,
          role: assignment.role,
          runtime_id: assignment.profile.runtime_id,
          adapter_version: descriptor.adapter_version,
          repository_root: repositoryRoot,
          ...worktree,
          requested_model: assignment.profile.model_id,
          expected_model: assignment.profile.model_id,
          execution_profile: assignment.profile,
          provider_route: providerLaunch.route,
          resume_session_id: session.external_session_id,
          runtime_capabilities: descriptor.capabilities,
          assigned_actor: { kind: "session", id: session.session_id },
          assignment_id: assignmentId,
          write_intent: assignment.write_intent,
          input_handoff_ids: inboundHandoffs.map(
            (handoff) => handoff.handoff_id,
          ),
        });
      if (inboundHandoffs.length)
        this.store.appendEvent(runId, {
          actor: { role: "System", id: "control-plane" },
          source: { kind: "control-plane" },
          type: "assignment.handoff_received",
          summary: `Received ${inboundHandoffs.length} handoff${inboundHandoffs.length === 1 ? "" : "s"}`,
          data: {
            handoff_ids: inboundHandoffs.map((handoff) => handoff.handoff_id),
          },
        });
      this.store.bindAssignmentRun(assignmentId, runId);
      this.store.transitionRun(runId, "preparing");
      this.store.transitionAssignment(assignmentId, "running");
      if (task.state === "draft")
        this.store.transitionTask(task.task_id, task.revision, "ready");
      const currentTask = this.store.getTask(task.task_id, task.revision);
      if (["ready", "blocked", "changes_requested"].includes(currentTask.state))
        this.store.transitionTask(task.task_id, task.revision, "running");
      const active = {
        adapter,
        completion: null,
        handle: null,
        cancelRequested: false,
      };
      this.active.set(runId, active);
      const completion = this.#execute({
        runId,
        task,
        adapter,
        worktree,
        prompt: executionPrompt,
        runtimeOptions,
        requestedModel: assignment.profile.model_id,
        executable,
        expectedModel: assignment.profile.model_id,
        assignmentId,
        actor: { role: assignment.role, id: session.session_id },
        missionMode: true,
        runtimeEnv: providerLaunch.env,
        writeIntent: assignment.write_intent,
        resumeSessionId: session.external_session_id,
        sessionId: session.session_id,
      });
      active.completion = completion;
      void completion
        .finally(() => {
          this.active.delete(runId);
          this.providerResolver?.cleanup?.(runId);
          if (writeLease)
            this.store.releaseLease(
              task.task_id,
              "workspace_write",
              session.session_id,
            );
        })
        .catch(() => {});
      return {
        run,
        assignment: this.store.getAssignment(assignmentId),
        completion,
      };
    } catch (error) {
      if (runId) this.providerResolver?.cleanup?.(runId);
      if (writeLease)
        this.store.releaseLease(
          task.task_id,
          "workspace_write",
          session.session_id,
        );
      throw error;
    }
  }
  async #ensureMissionWorkspace(task, repositoryRoot) {
    const root = resolve(repositoryRoot),
      existing = this.store.getMissionWorkspace(task.task_id);
    if (existing) {
      if (existing.repository_root !== root)
        throw new Error(
          `MissionWorkspace repository mismatch: expected=${existing.repository_root}, actual=${root}`,
        );
      if (existing.base_commit !== task.source.base_commit)
        throw new Error("MissionWorkspace base commit mismatch");
      return existing;
    }
    const pending = this.workspacePreparing.get(task.task_id);
    if (pending) return pending;
    const preparation = (async () => {
      const worktree = await createMissionWorktree({
        repositoryRoot: root,
        baseCommit: task.source.base_commit,
        worktreesRoot: this.worktreesRoot,
        workspaceId: task.task_id,
      });
      return this.store.createMissionWorkspace(task.task_id, {
        task_revision: task.revision,
        repository_root: root,
        ...worktree,
      });
    })();
    this.workspacePreparing.set(task.task_id, preparation);
    try {
      return await preparation;
    } finally {
      this.workspacePreparing.delete(task.task_id);
    }
  }

  async #resolveWorkspace({ policy, task, repositoryRoot, runId }) {
    switch (policy) {
      case "shared": {
        const activeRuns = [...this.active.keys()];
        for (const activeRunId of activeRuns) {
          const activeRun = this.store.getRun(activeRunId);
          if (activeRun && activeRun.write_intent && activeRun.run_id !== runId)
            throw new Error("Shared workspace policy: concurrent writer detected");
        }
        const info = await inspectRepository(repositoryRoot);
        return {
          worktree_id: `shared_${task.task_id}`,
          worktree_path: info.repository_root,
          base_commit: info.head,
        };
      }
      case "isolated": {
        const worktree = await createIsolatedWorktree({
          repositoryRoot,
          baseCommit: task.source.base_commit,
          worktreesRoot: this.worktreesRoot,
          runId: runId ?? task.task_id,
        });
        return worktree;
      }
      case "auto": {
        const activeRuns = [...this.active.keys()];
        const hasConcurrentWriter = activeRuns.some((activeRunId) => {
          const activeRun = this.store.getRun(activeRunId);
          return activeRun && activeRun.write_intent;
        });
        if (hasConcurrentWriter) {
          return this.#resolveWorkspace({ policy: "isolated", task, repositoryRoot, runId });
        }
        return this.#ensureMissionWorkspace(task, repositoryRoot);
      }
      case "mission":
      default: {
        return this.#ensureMissionWorkspace(task, repositoryRoot);
      }
    }
  }

  async #checkDagDependencies(assignment) {
    const dependencyIds = assignment.depends_on ?? [];
    if (!dependencyIds.length) return { blocked: false };
    for (const depId of dependencyIds) {
      const depAssignments = this.store
        .listAssignments(assignment.task_id)
        .filter((a) => a.stage_id === depId);
      const completedDep = depAssignments.find((a) => a.state === "completed");
      if (!completedDep) return { blocked: true, reason: `Dependency ${depId} not yet completed` };
      const depRun = this.store.getRun(completedDep.run_id);
      if (depRun && depRun.state !== "completed") return { blocked: true, reason: `Dependency ${depId} run not completed` };
    }
    return { blocked: false };
  }

  async #execute({
    runId,
    task,
    adapter,
    worktree,
    prompt,
    runtimeOptions,
    requestedModel,
    executable,
    expectedModel = task.execution.expected_model,
    assignmentId = null,
    actor = { role: "Worker", id: adapter.runtimeId },
    missionMode = false,
    runtimeEnv = {},
    writeIntent = true,
    resumeSessionId = null,
    sessionId = null,
  }) {
    const raw = [],
      messages = [];
    let credible = false,
      actualModel = null,
      lineNumber = 0;
    const consumeLine = (stream, line) => {
      if (!line) return;
      lineNumber += 1;
      if (stream !== "stdout") return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const normalized = adapter.normalize(parsed, {
        requested_model: requestedModel,
      });
      if (normalized.external_session_id && sessionId)
        this.store.updateSessionExternalId(
          sessionId,
          normalized.external_session_id,
        );
      if (normalized.terminal) {
        credible = normalized.terminal.completed === true;
        return;
      }
      if (normalized.actual_model) actualModel = normalized.actual_model;
      if (!normalized.event) return;
      if (normalized.event.type === "agent.message")
        messages.push(normalized.event.data?.text ?? normalized.event.summary);
      this.store.appendEvent(runId, {
        actor,
        source: { kind: "runtime", raw_offset: { line: lineNumber } },
        normalizer: {
          name: adapter.runtimeId,
          version: adapter.adapterVersion,
        },
        ...normalized.event,
        extensions: { [adapter.runtimeId]: parsed },
      });
    };
    try {
      const handle = await adapter.start(
        {
          worktree_path: worktree.worktree_path,
          prompt,
          runtime_options: runtimeOptions,
          requested_model: requestedModel,
          executable,
          env: runtimeEnv,
          write_intent: writeIntent,
          resume_session_id: resumeSessionId,
        },
        {
          raw: (stream, chunk) => raw.push({ stream, chunk }),
          line: consumeLine,
        },
      );
      const active = this.active.get(runId);
      if (!active) throw new Error(`Run lost active state: ${runId}`);
      active.handle = handle;
      const leasePath = join(this.store.runsRoot, runId, "process-lease.json");
      writeLease(leasePath, {
        schema: "cross-agent/process-lease/v1",
        run_id: runId,
        pid: handle.pid,
        runtime_id: adapter.runtimeId,
        created_at: nowIso(),
      });
      this.store.updateRunProcess(runId, handle.pid, leasePath);
      if (active.cancelRequested) await adapter.cancel(handle);
      else this.store.transitionRun(runId, "running");
      let timedOut = false;
      const timeoutSeconds = task.execution.budget?.timeout_seconds;
      const timer =
        timeoutSeconds && !active.cancelRequested
          ? setTimeout(() => {
              timedOut = true;
              void adapter.cancel(handle);
            }, timeoutSeconds * 1000)
          : null;
      // Guard polling loop around adapter.wait
      let guardTriggered = false;
      let guardReason = null;
      let usageUnavailableRecorded = false;
      const guardAssignment = assignmentId
        ? this.store.getAssignment(assignmentId)
        : null;
      const guardPlan = guardAssignment
        ? this.store.getExecutionPlan(
            task.task_id,
            guardAssignment.plan_revision,
          )
        : null;
      const taskLimits = task.execution?.budget ?? {};
      const configuredLimits = {
        ...taskLimits,
        ...(guardPlan?.limits ?? {}),
      };
      const guardInterval = 5000; // poll every 5 seconds
      const guardPoll = setInterval(() => {
        if (guardTriggered) return;
        // Duration guard
        const planLimits = {
          max_duration_seconds:
            configuredLimits.max_duration_seconds ??
            configuredLimits.timeout_seconds ??
            null,
          inactivity_timeout_seconds:
            configuredLimits.inactivity_timeout_seconds ?? null,
          repeated_failure_limit:
            configuredLimits.repeated_failure_limit ?? null,
          max_tokens: configuredLimits.max_tokens ?? null,
          max_cost_usd: configuredLimits.max_cost_usd ?? null,
        };
        const taskRuns = this.store.listTaskRuns(task.task_id);
        if (planLimits.max_duration_seconds) {
          const dur = checkDuration(task.created_at, planLimits.max_duration_seconds);
          if (dur.exceeded) {
            guardTriggered = true;
            guardReason = { reason_code: "guard_duration_exceeded", reason: `max_duration=${planLimits.max_duration_seconds}s exceeded` };
            void adapter.cancel(handle);
          }
        }
        if (!guardTriggered && planLimits.inactivity_timeout_seconds) {
          const events = this.store.listEvents(runId);
          const lastEvent = events.length > 0 ? events[events.length - 1] : null;
          const lastActivity = lastEvent?.occurred_at ?? task.created_at;
          const inact = checkInactivity(lastActivity, planLimits.inactivity_timeout_seconds);
          if (inact.timed_out) {
            guardTriggered = true;
            guardReason = { reason_code: "guard_inactivity_timeout", reason: `inactivity=${planLimits.inactivity_timeout_seconds}s` };
            void adapter.cancel(handle);
          }
        }
        if (!guardTriggered && planLimits.repeated_failure_limit > 0) {
          const failedRuns = taskRuns.filter((r) => r.state === "failed" && r.run_id !== runId);
          const failures = failedRuns.map((r) => {
            const ev = this.store.listEvents(r.run_id).findLast((e) => e.type === "run.state_changed" && e.data.to === "failed");
            return { reason_code: ev?.data?.reason_code ?? "unknown" };
          });
          const rep = checkRepeatedFailure(failures, planLimits.repeated_failure_limit);
          if (rep.triggered) {
            guardTriggered = true;
            guardReason = { reason_code: "guard_repeated_failure", reason: `repeated_failure_limit=${planLimits.repeated_failure_limit}, count=${rep.count}, reason_code=${rep.reason_code}` };
            void adapter.cancel(handle);
          }
        }
        if (!guardTriggered && (planLimits.max_tokens || planLimits.max_cost_usd)) {
          const events = this.store.listEvents(runId);
          const usageEvents = events.filter((e) => e.type === "usage.observed");
          const accumulator = usageEvents.length > 0 ? {
            available: true,
            tokens: usageEvents.reduce((sum, e) => sum + (e.data?.usage?.total_tokens ?? 0), 0),
            cost_usd: usageEvents.reduce((sum, e) => sum + (e.data?.usage?.cost_usd ?? 0), 0),
          } : { available: false };
          const budget = checkBudget(accumulator, planLimits);
          if (budget.status === "unavailable" && !usageUnavailableRecorded) {
            this.store.appendEvent(runId, {
              actor: { role: "System", id: "control-plane" },
              source: { kind: "control-plane" },
              type: "guard.usage_unavailable",
              summary: "Usage data unavailable, budget guard skipped",
              data: {
                max_tokens: planLimits.max_tokens,
                max_cost_usd: planLimits.max_cost_usd,
              },
            });
            usageUnavailableRecorded = true;
          } else if (budget.exceeded) {
            guardTriggered = true;
            guardReason = { reason_code: "guard_budget_exceeded", reason: `budget: ${budget.reason}` };
            void adapter.cancel(handle);
          }
        }
      }, guardInterval);
      const result = await adapter.wait(handle);
      clearInterval(guardPoll);
      if (timer) clearTimeout(timer);
      if (guardTriggered && guardReason) {
        this.store.appendEvent(runId, {
          actor: { role: "System", id: "control-plane" },
          source: { kind: "control-plane" },
          type: "guard.triggered",
          summary: `Guard triggered: ${guardReason.reason_code}`,
          data: guardReason,
        });
        if (["running", "waiting", "cancel_requested"].includes(this.store.getRun(runId)?.state)) {
          this.store.transitionRun(runId, "failed", guardReason);
          if (missionMode) this.store.transitionAssignment(assignmentId, "failed");
          else this.store.transitionTask(task.task_id, task.revision, "blocked");
        }
        return this.store.getRun(runId);
      }
      const rawText = raw.map((x) => `[${x.stream}] ${x.chunk}`).join("");
      this.store.createArtifact(runId, {
        kind: "runtime_raw_events",
        media_type: "application/x-ndjson",
        source: "runtime",
        data: rawText,
        extension: "ndjson",
      });
      const current = this.store.getRun(runId);
      if (current.state === "cancel_requested") {
        this.store.transitionRun(runId, "canceled", {
          reason_code: timedOut ? "runtime_timeout" : "user_requested",
        });
        if (missionMode)
          this.store.transitionAssignment(assignmentId, "canceled");
        else this.store.transitionTask(task.task_id, task.revision, "blocked");
        return this.store.getRun(runId);
      }
      const modelMismatch = expectedModel && actualModel !== expectedModel;
      if (result.exit_code !== 0 || !credible || timedOut || modelMismatch) {
        const reasonCode = timedOut
          ? "runtime_timeout"
          : modelMismatch
            ? "model_mismatch"
            : result.exit_code !== 0
              ? "runtime_nonzero"
              : "missing_credible_result";
        this.store.transitionRun(runId, "failed", {
          reason_code: reasonCode,
          reason: modelMismatch
            ? `expected=${expectedModel}, actual=${actualModel ?? "unknown"}`
            : `exit=${result.exit_code}`,
        });
        if (missionMode)
          this.store.transitionAssignment(assignmentId, "failed");
        else this.store.transitionTask(task.task_id, task.revision, "blocked");
        return this.store.getRun(runId);
      }
      if (missionMode) {
        const gitEvidence = await captureGitEvidence(
          worktree.worktree_path,
          task.source.base_commit,
        );
        this.store.createArtifact(runId, {
          kind: "git_snapshot",
          media_type: "application/json",
          source: "workspace",
          data: gitEvidence,
          extension: "json",
        });
        const scope = evaluateScope(task.scope, gitEvidence.changed_files),
          scopeArtifact = this.store.createArtifact(runId, {
            kind: "scope_check",
            media_type: "application/json",
            source: "workspace",
            data: scope,
            extension: "json",
          });
        this.store.recordVerification(runId, {
          gate_id: "control-plane:scope",
          kind: "custom",
          required: true,
          status: scope.status,
          exit_code: scope.status === "passed" ? 0 : 1,
          observed_tests: null,
          result_artifact_id: scopeArtifact.artifact_id,
        });
        if (scope.status === "passed") {
          const assignment = this.store.getAssignment(assignmentId),
            plan = this.store.getExecutionPlan(
              task.task_id,
              assignment.plan_revision,
            ),
            stageIndex = plan.stages.findIndex(
              (stage) => stage.stage_id === assignment.stage_id,
            ),
            nextStage = stageIndex >= 0 ? plan.stages[stageIndex + 1] : null,
            content =
              messages.filter(Boolean).join("\n\n") ||
              `${assignment.role} completed without a textual final response.`;
          this.store.createHandoff(task.task_id, {
            task_revision: task.revision,
            from_assignment_id: assignmentId,
            to_stage_id: nextStage?.stage_id ?? null,
            summary: `${assignment.role} handoff`,
            content,
          });
          this.store.transitionRun(runId, "completed");
          this.store.transitionAssignment(assignmentId, "completed");
        } else {
          this.store.transitionRun(runId, "failed", {
            reason_code: "scope_violation",
          });
          this.store.transitionAssignment(assignmentId, "failed");
        }
        return this.store.getRun(runId);
      }
      this.store.transitionRun(runId, "completed");
      this.store.transitionTask(task.task_id, task.revision, "verifying");
      this.store.transitionRun(runId, "verifying");
      const gitEvidence = await captureGitEvidence(
        worktree.worktree_path,
        task.source.base_commit,
      );
      this.store.createArtifact(runId, {
        kind: "git_snapshot",
        media_type: "application/json",
        source: "workspace",
        data: gitEvidence,
        extension: "json",
      });
      const scope = evaluateScope(task.scope, gitEvidence.changed_files);
      const scopeArtifact = this.store.createArtifact(runId, {
        kind: "scope_check",
        media_type: "application/json",
        source: "workspace",
        data: scope,
        extension: "json",
      });
      this.store.recordVerification(runId, {
        gate_id: "control-plane:scope",
        kind: "custom",
        required: true,
        status: scope.status,
        exit_code: scope.status === "passed" ? 0 : 1,
        observed_tests: null,
        result_artifact_id: scopeArtifact.artifact_id,
      });
      const verification = await runVerificationMatrix({
        store: this.store,
        runId,
        taskSpec: task,
        worktreePath: worktree.worktree_path,
      });
      this.store.sealEvidenceBundle(runId);
      if (!verification.passed || scope.status !== "passed") {
        this.store.transitionRun(runId, "failed", {
          reason_code:
            scope.status !== "passed"
              ? "scope_violation"
              : "verification_failed",
        });
        this.store.transitionTask(task.task_id, task.revision, "blocked");
      } else {
        this.store.transitionRun(runId, "review_ready");
        this.store.transitionTask(task.task_id, task.revision, "review_ready");
      }
      return this.store.getRun(runId);
    } catch (error) {
      const run = this.store.getRun(runId);
      if (
        [
          "preparing",
          "running",
          "waiting",
          "cancel_requested",
          "verifying",
        ].includes(run?.state)
      )
        this.store.transitionRun(
          runId,
          run.state === "cancel_requested" ? "canceled" : "failed",
          { reason_code: "orchestrator_error", reason: error.message },
        );
      const currentTask = this.store.getTask(task.task_id, task.revision);
      const currentAssignment = assignmentId
        ? this.store.getAssignment(assignmentId)
        : null;
      if (missionMode) {
        if (["assigned", "running"].includes(currentAssignment?.state))
          this.store.transitionAssignment(assignmentId, "failed");
      } else if (["running", "verifying"].includes(currentTask?.state))
        this.store.transitionTask(task.task_id, task.revision, "blocked");
      throw error;
    }
  }
  async finalizeMission({ taskId, runId }) {
    const task = this.store.getTask(taskId);
    const run = this.store.getRun(runId);
    if (!task || !run || run.task_id !== taskId)
      throw new Error("Mission finalization requires a Task and Run from the same mission");
    if (task.state === "review_ready" && run.state === "review_ready")
      return run;
    if (run.state !== "completed")
      throw new Error(`Mission finalization requires a completed Run, observed ${run.state}`);
    if (!["running", "waiting"].includes(task.state))
      throw new Error(`Mission finalization requires a running Task, observed ${task.state}`);

    const assignment = run.context?.assignment_id
      ? this.store.getAssignment(run.context.assignment_id)
      : this.store
          .listAssignments(taskId)
          .find((item) => item.run_id === runId);
    const plan = this.store.getExecutionPlan(
      taskId,
      assignment?.plan_revision,
    );
    if (!plan) throw new Error("Mission finalization requires an ExecutionPlan");
    const assignments = this.store.listAssignments(taskId);
    const incomplete = plan.stages
      .filter((stage) => stage.executor_kind !== "coordinator")
      .filter(
        (stage) =>
          !assignments.some(
            (item) =>
              item.plan_revision === plan.revision &&
              item.stage_id === stage.stage_id &&
              item.state === "completed",
          ),
      );
    if (incomplete.length)
      throw new Error(
        `Mission has incomplete managed stages: ${incomplete.map((stage) => stage.stage_id).join(", ")}`,
      );

    this.store.transitionTask(taskId, task.revision, "verifying");
    this.store.transitionRun(runId, "verifying");
    const verification = await runVerificationMatrix({
      store: this.store,
      runId,
      taskSpec: task,
      worktreePath: run.worktree_path,
    });
    this.store.sealEvidenceBundle(runId);
    if (!verification.passed) {
      this.store.transitionRun(runId, "failed", {
        reason_code: "verification_failed",
      });
      this.store.transitionTask(taskId, task.revision, "blocked");
      return this.store.getRun(runId);
    }
    this.store.transitionRun(runId, "review_ready");
    this.store.transitionTask(taskId, task.revision, "review_ready");
    return this.store.getRun(runId);
  }
  async cancel(runId) {
    const active = this.active.get(runId);
    if (!active) throw new Error(`Run is not active: ${runId}`);
    if (active.cancelRequested) return;
    active.cancelRequested = true;
    this.store.transitionRun(runId, "cancel_requested", {
      reason_code: "user_requested",
    });
    if (active.handle) await active.adapter.cancel(active.handle);
  }
  closeSession(sessionId) {
    const session = this.store.closeSession(sessionId);
    this.providerResolver?.cleanupSession?.(sessionId);
    return session;
  }
  async reconcile() {
    const repaired = [];
    for (const run of this.store
      .listRuns()
      .filter((x) =>
        ["preparing", "running", "waiting", "cancel_requested"].includes(
          x.state,
        ),
      )) {
      const adapter = this.runtimeAdapterFactory(run.runtime_id),
        probe = await adapter.recover(run.lease_path);
      if (!probe.observed_process) {
        this.store.appendEvent(run.run_id, {
          actor: { role: "System", id: "control-plane" },
          source: { kind: "control-plane" },
          type: "recovery.event",
          summary: "Marked stale run interrupted",
          data: {
            action: "probe",
            prior_state: run.state,
            observed_process: false,
            outcome: "interrupted",
          },
        });
        this.store.transitionRun(run.run_id, "interrupted", {
          reason_code: "stale_lease",
        });
        repaired.push(run.run_id);
      }
    }
    return repaired;
  }
}
