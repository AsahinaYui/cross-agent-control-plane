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
      coordinatorSurface ?? "codex-cli",
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
    surface: requireString(surface ?? "codex-cli", "surface"),
    role: "Coordinator",
  };
}