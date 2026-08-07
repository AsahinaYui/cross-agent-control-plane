import { createHash, randomUUID } from "node:crypto";

export const SCHEMAS = Object.freeze({
  task: "cross-agent/task-spec/v1",
  executionPlan: "cross-agent/execution-plan/v1",
  agentSession: "cross-agent/agent-session/v1",
  assignment: "cross-agent/assignment/v1",
  handoff: "cross-agent/handoff/v1",
  missionWorkspace: "cross-agent/mission-workspace/v1",
  missionLease: "cross-agent/mission-lease/v1",
  event: "cross-agent/agent-event/v1",
  bundle: "cross-agent/evidence-bundle/v1",
  decision: "cross-agent/audit-decision/v1",
  correction: "cross-agent/correction-delta/v1",
});

export const RUN_TRANSITIONS = Object.freeze({
  created: ["preparing"],
  preparing: [
    "running",
    "cancel_requested",
    "blocked",
    "failed",
    "interrupted",
  ],
  running: [
    "completed",
    "waiting",
    "cancel_requested",
    "failed",
    "interrupted",
  ],
  waiting: ["running", "cancel_requested", "interrupted"],
  cancel_requested: ["canceled", "interrupted"],
  completed: ["verifying"],
  verifying: ["review_ready", "failed", "blocked"],
  review_ready: [],
  blocked: [],
  failed: [],
  canceled: [],
  interrupted: [],
});

export const TASK_TRANSITIONS = Object.freeze({
  draft: ["ready"],
  ready: ["running", "discarded"],
  running: ["verifying", "blocked", "discarded"],
  verifying: ["review_ready", "blocked", "discarded"],
  blocked: ["running", "discarded"],
  review_ready: ["accepted", "changes_requested", "rejected", "discarded"],
  changes_requested: ["running", "discarded"],
  accepted: ["merged", "discarded"],
  rejected: ["discarded"],
  merged: [],
  discarded: [],
});

export const nowIso = () => new Date().toISOString();
export const makeId = (prefix) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
}
export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const sha256 = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export function hashTaskSpec(spec) {
  const { spec_hash: _ignored, ...body } = spec;
  return sha256(canonicalJson(body));
}
export function hashEvidenceBundle(bundle) {
  const { manifest_sha256: _ignored, ...body } = bundle;
  return sha256(canonicalJson(body));
}
export function verifyEvidenceBundle(bundle) {
  return Boolean(
    bundle &&
    bundle.schema === SCHEMAS.bundle &&
    bundle.manifest_sha256 === hashEvidenceBundle(bundle),
  );
}
function requireString(value, path, errors) {
  if (typeof value !== "string" || !value.trim())
    errors.push(`${path} must be a non-empty string`);
}

export function validateTaskSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    return ["TaskSpec must be an object"];
  if (spec.schema !== SCHEMAS.task)
    errors.push(`schema must be ${SCHEMAS.task}`);
  requireString(spec.task_id, "task_id", errors);
  if (!Number.isInteger(spec.revision) || spec.revision < 1)
    errors.push("revision must be an integer >= 1");
  for (const path of ["created_at", "title", "goal"])
    requireString(spec[path], path, errors);
  requireString(spec.source?.repository_id, "source.repository_id", errors);
  requireString(spec.source?.base_commit, "source.base_commit", errors);
  if (!Array.isArray(spec.scope?.allow))
    errors.push("scope.allow must be an array");
  if (!Array.isArray(spec.scope?.deny))
    errors.push("scope.deny must be an array");
  if (!Array.isArray(spec.acceptance) || !spec.acceptance.length)
    errors.push("acceptance must not be empty");
  const criteria = new Set();
  for (const [index, criterion] of (spec.acceptance ?? []).entries()) {
    requireString(
      criterion?.criterion_id,
      `acceptance[${index}].criterion_id`,
      errors,
    );
    requireString(
      criterion?.statement,
      `acceptance[${index}].statement`,
      errors,
    );
    if (criteria.has(criterion?.criterion_id))
      errors.push(`duplicate criterion_id: ${criterion.criterion_id}`);
    criteria.add(criterion?.criterion_id);
  }
  if (!Array.isArray(spec.verification?.gates))
    errors.push("verification.gates must be an array");
  for (const [index, gate] of (spec.verification?.gates ?? []).entries()) {
    requireString(
      gate?.gate_id,
      `verification.gates[${index}].gate_id`,
      errors,
    );
    if (!Array.isArray(gate?.argv) && typeof gate?.command !== "string")
      errors.push(`verification.gates[${index}] needs argv or command`);
    if (
      gate?.timeout_seconds !== undefined &&
      (!Number.isFinite(gate.timeout_seconds) || gate.timeout_seconds <= 0)
    )
      errors.push(
        `verification.gates[${index}].timeout_seconds must be positive`,
      );
  }
  for (const action of ["commit", "merge", "push", "publish", "discard"])
    if (!(action in (spec.guardrails?.irreversible_actions ?? {})))
      errors.push(`guardrails.irreversible_actions.${action} is required`);
  requireString(
    spec.execution?.preferred_runtime,
    "execution.preferred_runtime",
    errors,
  );
  if (!Array.isArray(spec.execution?.required_capabilities))
    errors.push("execution.required_capabilities must be an array");
  requireString(spec.metadata?.task_class, "metadata.task_class", errors);
  if (!Array.isArray(spec.metadata?.labels))
    errors.push("metadata.labels must be an array");
  const expected = hashTaskSpec(spec);
  if (spec.spec_hash !== undefined && spec.spec_hash !== expected)
    errors.push(`spec_hash mismatch: expected ${expected}`);
  return errors;
}

export function finalizeTaskSpec(input) {
  const spec = structuredClone(input);
  spec.schema ??= SCHEMAS.task;
  spec.task_id ??= makeId("task");
  spec.revision ??= 1;
  spec.created_at ??= nowIso();
  spec.scope = { allow: ["**/*"], deny: [], ...(spec.scope ?? {}) };
  spec.verification = { gates: [], ...(spec.verification ?? {}) };
  spec.guardrails ??= {};
  spec.guardrails.irreversible_actions = {
    commit: "human_required",
    merge: "human_required",
    push: "human_required",
    publish: "human_required",
    discard: "human_required",
    ...(spec.guardrails.irreversible_actions ?? {}),
  };
  spec.execution = {
    preferred_runtime: "fake",
    required_capabilities: [],
    budget: {},
    ...(spec.execution ?? {}),
  };
  spec.metadata = {
    task_class: "software-change",
    labels: [],
    ...(spec.metadata ?? {}),
  };
  spec.spec_hash = hashTaskSpec(spec);
  const errors = validateTaskSpec(spec);
  if (errors.length)
    throw new Error(`Invalid TaskSpec:\n- ${errors.join("\n- ")}`);
  return spec;
}

export function assertTransition(graph, from, to, label) {
  if (!(graph[from] ?? []).includes(to))
    throw new Error(`Invalid ${label} transition: ${from} -> ${to}`);
}
