import { basename } from "node:path";

const WORKFLOW_VERSION = 1;
const WORKSPACE_POLICIES = new Set(["shared", "mission", "isolated", "auto"]);
const PROVIDER_SOURCES = new Set(["runtime-native", "ccswitch", "test"]);

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function optionalPositiveNumber(value, path) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${path} must be a positive number`);
  return value;
}

function optionalPositiveInteger(value, path) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${path} must be a positive integer`);
  return value;
}

function normalizeWorkspacePolicy(value, path) {
  const policy = value ?? "mission";
  if (!WORKSPACE_POLICIES.has(policy))
    throw new Error(`${path} must be one of shared, mission, isolated, auto`);
  return policy;
}

function normalizeProvider(value, path) {
  if (typeof value === "string") {
    if (value.startsWith("ccswitch/")) {
      return {
        source: "ccswitch",
        id: value.slice("ccswitch/".length),
        billing_channel: "external-api",
        ccswitch_app_type: "codex",
        provider_config_hash: "sha256:workflow",
      };
    }
    return {
      source: "runtime-native",
      id: value,
      billing_channel: "runtime-managed",
      ccswitch_app_type: null,
      provider_config_hash: null,
    };
  }
  const provider = requireObject(value ?? {}, path);
  const source = provider.source ?? "runtime-native";
  if (!PROVIDER_SOURCES.has(source))
    throw new Error(`${path}.source is invalid`);
  return {
    source,
    id: requireString(
      provider.id ?? provider.route ?? "surface-route",
      `${path}.id`,
    ),
    billing_channel: requireString(
      provider.billing_channel ??
        (source === "ccswitch" ? "external-api" : "runtime-managed"),
      `${path}.billing_channel`,
    ),
    ccswitch_app_type:
      source === "ccswitch"
        ? requireString(
            provider.ccswitch_app_type ?? "codex",
            `${path}.ccswitch_app_type`,
          )
        : null,
    provider_config_hash:
      source === "ccswitch"
        ? requireString(
            provider.provider_config_hash ?? "sha256:workflow",
            `${path}.provider_config_hash`,
          )
        : null,
  };
}

function normalizeLimits(value = {}) {
  return {
    concurrency:
      optionalPositiveInteger(value.concurrency ?? 1, "limits.concurrency") ??
      1,
    max_duration_seconds: optionalPositiveNumber(
      value.max_duration_seconds,
      "limits.max_duration_seconds",
    ),
    inactivity_timeout_seconds: optionalPositiveNumber(
      value.inactivity_timeout_seconds,
      "limits.inactivity_timeout_seconds",
    ),
    repeated_failure_limit:
      optionalPositiveInteger(
        value.repeated_failure_limit,
        "limits.repeated_failure_limit",
      ) ?? 2,
    max_tokens: optionalPositiveNumber(value.max_tokens, "limits.max_tokens"),
    max_cost_usd: optionalPositiveNumber(
      value.max_cost_usd,
      "limits.max_cost_usd",
    ),
  };
}

function normalizeStep(step, index, defaultWorkspacePolicy) {
  const input = requireObject(step, `steps[${index}]`);
  const id = requireString(input.id ?? input.stage_id, `steps[${index}].id`);
  const responsibility = requireString(
    input.responsibility ?? input.prompt ?? input.role ?? id,
    `steps[${index}].responsibility`,
  );
  const role = requireString(input.role ?? id, `steps[${index}].role`);
  const dependsOn = Array.isArray(input.depends_on)
    ? input.depends_on.map((value, depIndex) =>
        requireString(value, `steps[${index}].depends_on[${depIndex}]`),
      )
    : [];
  const timeoutSeconds = optionalPositiveNumber(
    input.timeout_seconds,
    `steps[${index}].timeout_seconds`,
  );
  const workspacePolicy = normalizeWorkspacePolicy(
    input.workspace_policy ?? defaultWorkspacePolicy,
    `steps[${index}].workspace_policy`,
  );
  if (input.executor === "coordinator") {
    return {
      id,
      role,
      responsibility,
      executor: "coordinator",
      depends_on: dependsOn,
      writes: input.writes === true,
      timeout_seconds: timeoutSeconds,
      workspace_policy: workspacePolicy,
      runtime: null,
      provider: null,
      model: null,
    };
  }
  return {
    id,
    role,
    responsibility,
    executor: "managed",
    depends_on: dependsOn,
    writes: input.writes === true,
    timeout_seconds: timeoutSeconds,
    workspace_policy: workspacePolicy,
    runtime: requireString(input.runtime, `steps[${index}].runtime`),
    provider: normalizeProvider(
      input.provider ?? input.runtime,
      `steps[${index}].provider`,
    ),
    model: requireString(
      input.model ?? input.requested_model ?? "configured-model",
      `steps[${index}].model`,
    ),
  };
}

function assertAcyclicSteps(steps) {
  for (const [index, step] of steps.entries())
    for (const dependency of step.depends_on)
      if (!steps.find((s) => s.id === dependency))
        throw new Error(
          `steps.${step.id}.depends_on references unknown step: ${dependency}`,
        );
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (stepId) => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId))
      throw new Error(`workflow dependencies must be acyclic: ${stepId}`);
    visiting.add(stepId);
    for (const dependency of stepsById.get(stepId).depends_on) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function defaultAcceptance(goal) {
  return [
    {
      criterion_id: "requested_outcome",
      statement: goal,
    },
  ];
}

function defaultTitle(goal) {
  return (
    goal
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Workflow task"
  ).slice(0, 96);
}

export function parseWorkflowManifestText(text, source = "workflow.json") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error(`${source} is empty`);
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (/^\s*version\s*:/m.test(trimmed))
      throw new Error(
        `${source} must be JSON for P0; YAML manifests are intentionally unsupported`,
      );
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  return normalizeWorkflowManifest(parsed);
}

export function normalizeWorkflowManifest(input) {
  const workflow = requireObject(input, "workflow");
  if (workflow.version !== WORKFLOW_VERSION)
    throw new Error(`workflow.version must be ${WORKFLOW_VERSION}`);
  const defaultWorkspacePolicy = normalizeWorkspacePolicy(
    workflow.workspace?.policy ?? "mission",
    "workspace.policy",
  );
  const coordinator = requireObject(
    workflow.coordinator ?? { mode: "current-session" },
    "coordinator",
  );
  if (coordinator.mode !== "current-session")
    throw new Error("coordinator.mode must be current-session in P0");
  const limits = normalizeLimits(workflow.limits ?? {});
  const steps = (workflow.steps ?? []).map((step, index) =>
    normalizeStep(step, index, defaultWorkspacePolicy),
  );
  if (!steps.length) throw new Error("workflow.steps must not be empty");
  assertAcyclicSteps(steps);
  return {
    version: WORKFLOW_VERSION,
    workspace: { policy: defaultWorkspacePolicy },
    coordinator: { mode: "current-session" },
    limits,
    task: workflow.task ? requireObject(workflow.task, "task") : {},
    steps,
  };
}

export function topologicalSort(steps) {
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set();
  const result = [];
  const visit = (stepId) => {
    if (visited.has(stepId)) return;
    visited.add(stepId);
    const step = stepsById.get(stepId);
    for (const dep of step.depends_on) visit(dep);
    result.push(step);
  };
  for (const step of steps) visit(step.id);
  return result;
}

export function resolveWorkspacePolicy(steps) {
  const policies = steps.map((s) => s.workspace_policy);
  if (policies.some((p) => p === "isolated")) return "isolated";
  if (policies.some((p) => p === "auto")) return "auto";
  if (policies.some((p) => p === "shared")) return "shared";
  return "mission";
}

export function buildTaskInputFromWorkflow({
  workflow,
  goal,
  repositoryRoot,
  baseCommit,
}) {
  const normalizedGoal = requireString(goal, "goal");
  const task = workflow.task ?? {};
  return {
    title: requireString(task.title ?? defaultTitle(normalizedGoal), "task.title"),
    goal: normalizedGoal,
    source: {
      repository_id: basename(repositoryRoot),
      base_commit: requireString(baseCommit, "baseCommit"),
    },
    scope: task.scope ?? { allow: ["**/*"], deny: [] },
    acceptance: task.acceptance ?? defaultAcceptance(normalizedGoal),
    verification: task.verification ?? { gates: [] },
    guardrails: {
      irreversible_actions: {
        commit: "human_required",
        merge: "human_required",
        push: "human_required",
        publish: "human_required",
        discard: "human_required",
        ...(task.guardrails?.irreversible_actions ?? {}),
      },
    },
    execution: {
      preferred_runtime:
        workflow.steps.find((step) => step.executor === "managed")?.runtime ??
        "fake",
      required_capabilities: ["structured_events"],
      budget: {
        timeout_seconds: workflow.limits.max_duration_seconds ?? undefined,
      },
    },
    metadata: {
      task_class: task.metadata?.task_class ?? "software-change",
      labels: [
        "workflow",
        ...(Array.isArray(task.metadata?.labels) ? task.metadata.labels : []),
      ],
      repository_root: repositoryRoot,
    },
  };
}

export function buildExecutionPlanInputFromWorkflow({
  workflow,
  coordinatorSurface,
}) {
  return {
    fallback_policy: "disabled",
    coordinator_surface: requireString(
      coordinatorSurface ?? "terminal",
      "coordinatorSurface",
    ),
    concurrency_limit: workflow.limits.concurrency,
    workspace_policy: workflow.workspace.policy,
    limits: {
      max_duration_seconds: workflow.limits.max_duration_seconds,
      inactivity_timeout_seconds: workflow.limits.inactivity_timeout_seconds,
      repeated_failure_limit: workflow.limits.repeated_failure_limit,
      max_tokens: workflow.limits.max_tokens,
      max_cost_usd: workflow.limits.max_cost_usd,
    },
    stages: workflow.steps.map((step) => ({
      stage_id: step.id,
      role: step.role,
      responsibility: step.responsibility,
      executor_kind: step.executor === "coordinator" ? "coordinator" : "managed",
      write_intent: step.writes === true,
      depends_on: step.depends_on,
      workspace_policy: step.workspace_policy,
      timeout_seconds: step.timeout_seconds,
      profile:
        step.executor === "managed"
          ? {
              profile_id: `wf-${step.id}`,
              runtime_id: step.runtime,
              provider_id: step.provider.id,
              model_id: step.model,
              billing_channel: step.provider.billing_channel,
              provider_source: step.provider.source,
              ccswitch_app_type: step.provider.ccswitch_app_type,
              provider_config_hash: step.provider.provider_config_hash,
            }
          : null,
    })),
  };
}

export function managedSessionInputFromStep(step) {
  return {
    profile_id: step.profile.profile_id,
    runtime_id: step.profile.runtime_id,
    provider_id: step.profile.provider_id,
    model_id: step.profile.model_id,
    billing_channel: step.profile.billing_channel,
    provider_source: step.profile.provider_source,
    ccswitch_app_type: step.profile.ccswitch_app_type,
    provider_config_hash: step.profile.provider_config_hash,
    surface: "managed-control-plane",
    role: step.role,
  };
}

export function coordinatorSessionInput(surface) {
  return {
    profile_id: "current-session-coordinator",
    runtime_id: "current-session",
    provider_id: "surface-owned",
    model_id: "surface-owned",
    billing_channel: "surface-owned",
    surface: requireString(surface ?? "terminal", "surface"),
    role: "Coordinator",
  };
}

// ---------------------------------------------------------------------------
// Attachment selector -- greatest valid timestamp for a repository
// ---------------------------------------------------------------------------

export function selectAttachment(records, repositoryRoot) {
  let best = null;
  let bestTs = -1;
  for (const att of records) {
    if (!att || typeof att !== "object") continue;
    if (att.repository_root !== repositoryRoot) continue;
    const ts = Date.parse(att.timestamp);
    if (Number.isNaN(ts)) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = att;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Bounded DAG scheduler
// ---------------------------------------------------------------------------

export async function executeWorkflowScheduler({
  api,
  taskId,
  sortedSteps,
  managedSessionIds,
  coordinatorSessionId,
  limits,
  info,
}) {
  const completed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const active = new Map(); // stepId -> runId
  const stepRuns = new Map(); // stepId -> { runId, state }
  const concurrency = limits.concurrency ?? 1;
  const stepById = new Map(sortedSteps.map((s) => [s.id, s]));

  // Compute full transitive descendant closure for each step
  const descendantsCache = new Map();
  const getDescendants = (stepId) => {
    if (descendantsCache.has(stepId)) return descendantsCache.get(stepId);
    const result = [];
    for (const s of sortedSteps) {
      if (s.depends_on.includes(stepId)) {
        result.push(s.id);
        result.push(...getDescendants(s.id));
      }
    }
    descendantsCache.set(stepId, result);
    return result;
  };

  const isDescendantOfFailed = (stepId) =>
    stepById.get(stepId).depends_on.some((dep) => failed.has(dep) || blocked.has(dep));

  const isReady = (step) => {
    if (completed.has(step.id) || failed.has(step.id) || blocked.has(step.id) || active.has(step.id)) return false;
    return step.depends_on.every((dep) => completed.has(dep)) && !isDescendantOfFailed(step.id);
  };

  const allDone = () => sortedSteps.every((s) => completed.has(s.id) || failed.has(s.id) || blocked.has(s.id));

  const failAndBlock = (stepId) => {
    if (failed.has(stepId) || blocked.has(stepId)) return;
    failed.add(stepId);
    // Transitively block all descendants -- never launch them
    for (const did of getDescendants(stepId)) {
      if (!completed.has(did) && !failed.has(did) && !active.has(did)) {
        blocked.add(did);
      }
    }
  };

  while (!allDone()) {
    // Complete ready coordinator steps without launching a runtime
    for (const step of sortedSteps) {
      if (!isReady(step) || step.executor !== "coordinator") continue;
      completed.add(step.id);
    }

    // Launch ready managed steps within concurrency limit
    for (const step of sortedSteps) {
      if (!isReady(step) || step.executor !== "managed") continue;
      if (active.size >= concurrency) break;

      const sessionId = managedSessionIds.get(step.id);
      if (!sessionId) { failAndBlock(step.id); continue; }

      let assignment;
      try {
        assignment = await api("POST", `/api/control-plane/v1/tasks/${taskId}/assignments`, {
          stage_id: step.id,
          role: step.role,
          prompt: step.responsibility,
          write_intent: step.writes,
          depends_on: step.depends_on,
          workspace_policy: step.workspace_policy,
          timeout_seconds: step.timeout_seconds,
          executor_kind: "managed",
          session_id: sessionId,
          profile: {
            profile_id: `wf-${step.id}`,
            runtime_id: step.runtime,
            provider_id: step.provider.id,
            model_id: step.model,
            billing_channel: step.provider.billing_channel,
            provider_source: step.provider.source,
            ccswitch_app_type: step.provider.ccswitch_app_type,
            provider_config_hash: step.provider.provider_config_hash,
          },
        });
      } catch { failAndBlock(step.id); continue; }

      let started;
      try {
        started = await api("POST",
          `/api/control-plane/v1/tasks/${taskId}/assignments/${assignment.assignment_id}/runs`,
          { coordinator_session_id: coordinatorSessionId, repository_root: info.repository_root },
        );
      } catch { failAndBlock(step.id); continue; }

      active.set(step.id, started.run.run_id);
      stepRuns.set(step.id, { runId: started.run.run_id, state: "running" });
    }

    // If nothing active, check if we're done or stuck
    if (active.size === 0) {
      if (allDone()) break;
      const anyReady = sortedSteps.some(isReady);
      if (!anyReady) break;
    }

    // Poll active runs -- keep siblings alive while they settle
    if (active.size > 0) {
      const settled = [];
      for (const [stepId, runId] of active) {
        let run;
        try { run = await api("GET", `/api/control-plane/v1/runs/${runId}`); }
        catch { run = { state: "failed" }; }
        if (["completed", "review_ready", "failed", "blocked", "canceled", "interrupted"].includes(run.state)) {
          if (run.state === "completed" || run.state === "review_ready") {
            completed.add(stepId);
            stepRuns.set(stepId, { runId, state: run.state });
          } else {
            failAndBlock(stepId);
          }
          settled.push(stepId);
        }
      }
      for (const stepId of settled) active.delete(stepId);
    }

    if (active.size > 0) await new Promise((r) => setTimeout(r, 200));
  }

  // Wait for still-active runs to settle (defensive, shouldn't happen after loop)
  if (active.size > 0) {
    const entries = [...active.entries()];
    for (const [stepId, runId] of entries) {
      try {
        const deadline = Date.now() + 300000;
        const terminalStates = new Set(["completed", "review_ready", "failed", "blocked", "canceled", "interrupted"]);
        let run;
        while (Date.now() < deadline) {
          run = await api("GET", `/api/control-plane/v1/runs/${runId}`);
          if (terminalStates.has(run.state)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!run || !terminalStates.has(run.state)) throw new Error("timeout");
        if (run.state === "completed" || run.state === "review_ready") {
          completed.add(stepId);
          stepRuns.set(stepId, { runId, state: run.state });
        } else {
          failAndBlock(stepId);
        }
      } catch { failAndBlock(stepId); }
    }
  }

  // Build per-step results in stable topological order
  const results = [];
  for (const step of sortedSteps) {
    if (completed.has(step.id)) {
      const sr = stepRuns.get(step.id);
      results.push({ stepId: step.id, result: "completed", runId: sr?.runId ?? null });
    } else if (failed.has(step.id)) {
      results.push({ stepId: step.id, result: "failed", runId: null });
    } else if (blocked.has(step.id)) {
      results.push({ stepId: step.id, result: "blocked", runId: null });
    }
  }

  const hasFailure = results.some((r) => r.result === "failed" || r.result === "blocked");
  // Only return a non-null terminalRunId when the entire workflow succeeded
  let terminalRunId = null;
  if (!hasFailure) {
    for (const step of sortedSteps) {
      if (step.executor === "managed" && completed.has(step.id)) {
        const sr = stepRuns.get(step.id);
        if (sr) terminalRunId = sr.runId;
      }
    }
  }

  return { hasFailure, terminalRunId, results };
}
