import { join, resolve } from "node:path";
import { makeId, nowIso } from "./protocol.mjs";
import { writeLease } from "./process.mjs";
import { createRuntimeAdapter } from "./runtime-adapters.mjs";
import { captureGitEvidence, createMissionWorktree } from "./worktree.mjs";
import { runVerificationMatrix } from "./verification.mjs";
import { evaluateScope } from "./scope.mjs";

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
    const worktree = await this.#ensureMissionWorkspace(task, repositoryRoot);
    let writeLease = null,
      runId = null;
    if (assignment.write_intent)
      writeLease = this.store.acquireLease(
        task.task_id,
        "workspace_write",
        session.session_id,
        { assignment_id: assignmentId, ttl_seconds: 86400 },
      );
    try {
      runId = makeId("run");
      const providerLaunch = this.providerResolver
          ? this.providerResolver.resolve(assignment.profile, { runId })
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
          runtime_capabilities: descriptor.capabilities,
          assigned_actor: { kind: "session", id: session.session_id },
          assignment_id: assignmentId,
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
        prompt: assignment.prompt,
        runtimeOptions,
        requestedModel: assignment.profile.model_id,
        executable,
        expectedModel: assignment.profile.model_id,
        assignmentId,
        actor: { role: assignment.role, id: session.session_id },
        missionMode: true,
        runtimeEnv: providerLaunch.env,
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
  }) {
    const raw = [];
    try {
      const handle = await adapter.start(
        {
          worktree_path: worktree.worktree_path,
          prompt,
          runtime_options: runtimeOptions,
          requested_model: requestedModel,
          executable,
          env: runtimeEnv,
        },
        { raw: (stream, chunk) => raw.push({ stream, chunk }), line: () => {} },
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
      const result = await adapter.wait(handle);
      if (timer) clearTimeout(timer);
      const rawText = raw.map((x) => `[${x.stream}] ${x.chunk}`).join("");
      const rawArtifact = this.store.createArtifact(runId, {
        kind: "runtime_raw_events",
        media_type: "application/x-ndjson",
        source: "runtime",
        data: rawText,
        extension: "ndjson",
      });
      let credible = false,
        actualModel = null,
        lineNumber = 0;
      for (const entry of raw)
        for (const line of entry.chunk.split(/\r?\n/).filter(Boolean)) {
          lineNumber += 1;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const normalized = adapter.normalize(parsed);
          if (normalized.terminal) {
            credible = normalized.terminal.completed === true;
            continue;
          }
          if (normalized.actual_model) actualModel = normalized.actual_model;
          if (!normalized.event) continue;
          this.store.appendEvent(runId, {
            actor,
            source: {
              kind: "runtime",
              raw_artifact_id: rawArtifact.artifact_id,
              raw_offset: { line: lineNumber },
            },
            normalizer: {
              name: adapter.runtimeId,
              version: adapter.adapterVersion,
            },
            ...normalized.event,
            extensions: { [adapter.runtimeId]: parsed },
          });
        }
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
