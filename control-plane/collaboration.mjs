import { SCHEMAS, canonicalJson, makeId, nowIso, sha256 } from "./protocol.mjs";

const ASSIGNMENT_TRANSITIONS = Object.freeze({
  queued: ["assigned", "canceled"],
  assigned: ["running", "canceled", "blocked"],
  running: ["completed", "failed", "canceled", "blocked"],
  blocked: ["assigned", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
});

function requiredString(value, path) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

export function normalizeProfile(input, path = "profile") {
  const providerSource = input?.provider_source ?? "runtime-native";
  if (!["ccswitch", "runtime-native", "test"].includes(providerSource))
    throw new Error(`${path}.provider_source is invalid`);
  const profile = {
    profile_id: requiredString(input?.profile_id, `${path}.profile_id`),
    runtime_id: requiredString(input?.runtime_id, `${path}.runtime_id`),
    provider_id: requiredString(input?.provider_id, `${path}.provider_id`),
    model_id: requiredString(input?.model_id, `${path}.model_id`),
    billing_channel: requiredString(
      input?.billing_channel,
      `${path}.billing_channel`,
    ),
    provider_source: providerSource,
    ccswitch_app_type:
      providerSource === "ccswitch"
        ? requiredString(input?.ccswitch_app_type, `${path}.ccswitch_app_type`)
        : null,
    provider_config_hash:
      providerSource === "ccswitch"
        ? requiredString(
            input?.provider_config_hash,
            `${path}.provider_config_hash`,
          )
        : null,
  };
  if (input?.fallback_policy && input.fallback_policy !== "disabled")
    throw new Error(`${path}.fallback_policy must be disabled`);
  return { ...profile, fallback_policy: "disabled" };
}

export function finalizeExecutionPlan({ task, input, latestRevision = 0 }) {
  if (!task) throw new Error("ExecutionPlan requires an existing task");
  if (!Array.isArray(input?.stages) || input.stages.length === 0)
    throw new Error("ExecutionPlan stages must not be empty");
  if (input.fallback_policy && input.fallback_policy !== "disabled")
    throw new Error("ExecutionPlan fallback_policy must be disabled");
  const revision = input.revision ?? latestRevision + 1;
  if (revision !== latestRevision + 1)
    throw new Error(`ExecutionPlan revision must be ${latestRevision + 1}`);
  if (latestRevision > 0) requiredString(input.change_reason, "change_reason");
  const stageIds = new Set();
  const stages = input.stages.map((stage, index) => {
    const stageId = requiredString(
      stage?.stage_id,
      `stages[${index}].stage_id`,
    );
    if (stageIds.has(stageId))
      throw new Error(`Duplicate ExecutionPlan stage_id: ${stageId}`);
    stageIds.add(stageId);
    return {
      stage_id: stageId,
      role: requiredString(stage?.role, `stages[${index}].role`),
      responsibility: requiredString(
        stage?.responsibility ?? stage?.role,
        `stages[${index}].responsibility`,
      ),
      profile: normalizeProfile(stage?.profile, `stages[${index}].profile`),
      write_intent: stage?.write_intent === true,
    };
  });
  const plan = {
    schema: SCHEMAS.executionPlan,
    task_id: task.task_id,
    task_revision: task.revision,
    revision,
    fallback_policy: "disabled",
    coordinator_surface: requiredString(
      input.coordinator_surface ?? "codex-desktop",
      "coordinator_surface",
    ),
    stages,
    change_reason: input.change_reason ?? null,
    created_at: nowIso(),
  };
  plan.plan_hash = sha256(canonicalJson(plan));
  return plan;
}

export function finalizeAgentSession({ task, input }) {
  if (!task) throw new Error("AgentSession requires an existing task");
  const profile = normalizeProfile(input, "session");
  return {
    schema: SCHEMAS.agentSession,
    session_id: input.session_id ?? makeId("ses"),
    task_id: task.task_id,
    surface: requiredString(input.surface, "surface"),
    role: requiredString(input.role ?? "Worker", "role"),
    ...profile,
    external_session_id: input.external_session_id ?? null,
    capabilities: input.capabilities ?? {},
    state: "attached",
    created_at: nowIso(),
    updated_at: nowIso(),
    last_seen_at: nowIso(),
  };
}

export function assertSessionMatchesProfile(session, profile) {
  if (!session || session.state !== "attached")
    throw new Error("Assignment requires an attached AgentSession");
  for (const key of [
    "runtime_id",
    "provider_id",
    "model_id",
    "billing_channel",
    "provider_source",
    "ccswitch_app_type",
    "provider_config_hash",
  ])
    if (session[key] !== profile[key])
      throw new Error(
        `Pinned profile mismatch for ${key}: expected=${profile[key]}, actual=${session[key]}`,
      );
}

export function finalizeAssignment({ task, plan, stage, input, session }) {
  if (!task || !plan || !stage)
    throw new Error("Assignment requires a task, ExecutionPlan, and stage");
  if (session) assertSessionMatchesProfile(session, stage.profile);
  return {
    schema: SCHEMAS.assignment,
    assignment_id: input.assignment_id ?? makeId("asn"),
    task_id: task.task_id,
    task_revision: task.revision,
    plan_revision: plan.revision,
    stage_id: stage.stage_id,
    role: stage.role,
    profile: structuredClone(stage.profile),
    prompt: requiredString(input.prompt ?? stage.responsibility, "prompt"),
    write_intent: input.write_intent ?? stage.write_intent,
    parent_assignment_id: input.parent_assignment_id ?? null,
    session_id: session?.session_id ?? null,
    run_id: null,
    state: session ? "assigned" : "queued",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function assertAssignmentTransition(from, to) {
  if (!(ASSIGNMENT_TRANSITIONS[from] ?? []).includes(to))
    throw new Error(`Invalid assignment transition: ${from} -> ${to}`);
}

export function makeMissionLease({
  taskId,
  kind,
  sessionId,
  assignmentId,
  ttlSeconds,
}) {
  if (!["coordinator", "workspace_write"].includes(kind))
    throw new Error(`Invalid mission lease kind: ${kind}`);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 86400)
    throw new Error("ttl_seconds must be an integer between 5 and 86400");
  const now = Date.now();
  return {
    schema: SCHEMAS.missionLease,
    task_id: taskId,
    lease_kind: kind,
    holder_session_id: sessionId,
    assignment_id: assignmentId ?? null,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
}
