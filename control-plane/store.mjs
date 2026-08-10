import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMAS,
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  assertTransition,
  finalizeTaskSpec,
  hashEvidenceBundle,
  makeId,
  nowIso,
  sha256,
  verifyEvidenceBundle,
} from "./protocol.mjs";
import {
  assertAssignmentTransition,
  assertSessionMatchesProfile,
  finalizeAgentSession,
  finalizeAssignment,
  finalizeExecutionPlan,
  finalizeHandoff,
  makeMissionLease,
} from "./collaboration.mjs";

const ensureDir = (path) => (mkdirSync(path, { recursive: true }), path);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function atomicJson(path, value) {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}
function childPath(root, ...parts) {
  const base = resolve(root);
  const candidate = resolve(root, ...parts);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`))
    throw new Error("Path escapes control-plane root");
  return candidate;
}

export class ControlPlaneStore {
  constructor(root) {
    this.root = resolve(root);
    this.tasksRoot = ensureDir(join(this.root, "tasks"));
    this.runsRoot = ensureDir(join(this.root, "runs"));
    this.decisionsRoot = ensureDir(join(this.root, "decisions"));
    this.correctionsRoot = ensureDir(join(this.root, "corrections"));
    this.plansRoot = ensureDir(join(this.root, "execution-plans"));
    this.sessionsRoot = ensureDir(join(this.root, "sessions"));
    this.assignmentsRoot = ensureDir(join(this.root, "assignments"));
    this.handoffsRoot = ensureDir(join(this.root, "handoffs"));
    this.workspacesRoot = ensureDir(join(this.root, "mission-workspaces"));
    this.db = new DatabaseSync(join(this.root, "index.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.#initSchema();
  }
  close() {
    this.db.close();
  }
  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks(task_id TEXT,revision INTEGER,spec_hash TEXT,title TEXT,state TEXT,created_at TEXT,task_class TEXT,spec_path TEXT,PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,role TEXT,runtime_id TEXT,adapter_version TEXT,state TEXT,repository_root TEXT,worktree_path TEXT,artifact_root TEXT,parent_run_id TEXT,correction_delta_id TEXT,resume_session_id TEXT,created_at TEXT,updated_at TEXT,process_id INTEGER,lease_path TEXT);
      CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,run_id TEXT,task_id TEXT,sequence INTEGER,occurred_at TEXT,recorded_at TEXT,role TEXT,actor_id TEXT,source_kind TEXT,type TEXT,summary TEXT,event_json TEXT,UNIQUE(run_id,sequence));
      CREATE TABLE IF NOT EXISTS artifacts(artifact_id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,media_type TEXT,sha256 TEXT,bytes INTEGER,relative_path TEXT,source TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS verification_results(run_id TEXT,gate_id TEXT,status TEXT,exit_code INTEGER,observed_tests INTEGER,required INTEGER,artifact_id TEXT,result_json TEXT,PRIMARY KEY(run_id,gate_id));
      CREATE TABLE IF NOT EXISTS bundles(bundle_id TEXT PRIMARY KEY,run_id TEXT UNIQUE,task_id TEXT,manifest_sha256 TEXT,path TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS audit_decisions(decision_id TEXT PRIMARY KEY,run_id TEXT,task_id TEXT,bundle_id TEXT,decision TEXT,path TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS corrections(correction_delta_id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,parent_run_id TEXT,decision_id TEXT UNIQUE,source_bundle_id TEXT,path TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS execution_plans(task_id TEXT,revision INTEGER,plan_hash TEXT,path TEXT,created_at TEXT,PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS agent_sessions(session_id TEXT PRIMARY KEY,task_id TEXT,surface TEXT,role TEXT,runtime_id TEXT,provider_id TEXT,model_id TEXT,billing_channel TEXT,state TEXT,external_session_id TEXT,path TEXT,created_at TEXT,updated_at TEXT,last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS assignments(assignment_id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,plan_revision INTEGER,stage_id TEXT,role TEXT,state TEXT,session_id TEXT,run_id TEXT,write_intent INTEGER,path TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS handoffs(handoff_id TEXT PRIMARY KEY,task_id TEXT,task_revision INTEGER,plan_revision INTEGER,from_assignment_id TEXT,from_run_id TEXT,to_stage_id TEXT,path TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS mission_workspaces(task_id TEXT PRIMARY KEY,repository_root TEXT,worktree_id TEXT,worktree_path TEXT,base_commit TEXT,path TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS mission_leases(task_id TEXT,lease_kind TEXT,holder_session_id TEXT,assignment_id TEXT,expires_at TEXT,path TEXT,updated_at TEXT,PRIMARY KEY(task_id,lease_kind));
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_task ON agent_sessions(task_id,updated_at);
      CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments(task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_handoffs_task ON handoffs(task_id,created_at);
    `);
  }

  createTask(input) {
    const spec = finalizeTaskSpec(input);
    const path = childPath(
      this.tasksRoot,
      spec.task_id,
      "revisions",
      `${spec.revision}.json`,
    );
    if (existsSync(path))
      throw new Error(
        `TaskSpec revision already exists: ${spec.task_id}@${spec.revision}`,
      );
    atomicJson(path, spec);
    atomicJson(childPath(this.tasksRoot, spec.task_id, "state.json"), {
      task_id: spec.task_id,
      revision: spec.revision,
      state: "draft",
      updated_at: spec.created_at,
    });
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)")
      .run(
        spec.task_id,
        spec.revision,
        spec.spec_hash,
        spec.title,
        "draft",
        spec.created_at,
        spec.metadata.task_class,
        path,
      );
    return { ...spec, state: "draft" };
  }
  getTask(taskId, revision) {
    const row = revision
      ? this.db
          .prepare("SELECT * FROM tasks WHERE task_id=? AND revision=?")
          .get(taskId, revision)
      : this.db
          .prepare(
            "SELECT * FROM tasks WHERE task_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(taskId);
    return row ? { ...readJson(row.spec_path), state: row.state } : null;
  }
  listTasks() {
    return this.db
      .prepare(
        "SELECT t.* FROM tasks t JOIN (SELECT task_id,MAX(revision) revision FROM tasks GROUP BY task_id) x ON x.task_id=t.task_id AND x.revision=t.revision ORDER BY t.created_at DESC",
      )
      .all()
      .map((row) => ({ ...readJson(row.spec_path), state: row.state }));
  }
  transitionTask(taskId, revision, to) {
    const row = this.db
      .prepare("SELECT state FROM tasks WHERE task_id=? AND revision=?")
      .get(taskId, revision);
    if (!row) throw new Error(`Unknown task: ${taskId}@${revision}`);
    assertTransition(TASK_TRANSITIONS, row.state, to, "task");
    this.db
      .prepare("UPDATE tasks SET state=? WHERE task_id=? AND revision=?")
      .run(to, taskId, revision);
    atomicJson(childPath(this.tasksRoot, taskId, "state.json"), {
      task_id: taskId,
      revision,
      state: to,
      updated_at: nowIso(),
    });
    return { from: row.state, to };
  }

  createExecutionPlan(taskId, input) {
    const task = this.getTask(taskId, input.task_revision),
      latest = this.getExecutionPlan(taskId),
      plan = finalizeExecutionPlan({
        task,
        input,
        latestRevision: latest?.revision ?? 0,
      }),
      path = childPath(this.plansRoot, taskId, `${plan.revision}.json`);
    atomicJson(path, plan);
    this.db
      .prepare("INSERT INTO execution_plans VALUES(?,?,?,?,?)")
      .run(taskId, plan.revision, plan.plan_hash, path, plan.created_at);
    return plan;
  }
  getExecutionPlan(taskId, revision) {
    const row = revision
      ? this.db
          .prepare(
            "SELECT path FROM execution_plans WHERE task_id=? AND revision=?",
          )
          .get(taskId, revision)
      : this.db
          .prepare(
            "SELECT path FROM execution_plans WHERE task_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(taskId);
    return row ? readJson(row.path) : null;
  }
  listExecutionPlans(taskId) {
    return this.db
      .prepare(
        "SELECT path FROM execution_plans WHERE task_id=? ORDER BY revision",
      )
      .all(taskId)
      .map((row) => readJson(row.path));
  }

  attachSession(taskId, input) {
    const task = this.getTask(taskId, input.task_revision),
      session = finalizeAgentSession({ task, input }),
      path = childPath(this.sessionsRoot, `${session.session_id}.json`);
    if (this.getSession(session.session_id))
      throw new Error(`AgentSession already exists: ${session.session_id}`);
    atomicJson(path, session);
    this.db
      .prepare("INSERT INTO agent_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        session.session_id,
        taskId,
        session.surface,
        session.role,
        session.runtime_id,
        session.provider_id,
        session.model_id,
        session.billing_channel,
        session.state,
        session.external_session_id,
        path,
        session.created_at,
        session.updated_at,
        session.last_seen_at,
      );
    return session;
  }
  getSession(sessionId) {
    const row = this.db
      .prepare("SELECT path FROM agent_sessions WHERE session_id=?")
      .get(sessionId);
    return row ? readJson(row.path) : null;
  }
  listSessions(taskId) {
    return this.db
      .prepare(
        "SELECT path FROM agent_sessions WHERE task_id=? ORDER BY created_at",
      )
      .all(taskId)
      .map((row) => readJson(row.path));
  }
  heartbeatSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session || session.state !== "attached")
      throw new Error(`Unknown attached AgentSession: ${sessionId}`);
    session.last_seen_at = nowIso();
    session.updated_at = session.last_seen_at;
    const path = childPath(this.sessionsRoot, `${sessionId}.json`);
    atomicJson(path, session);
    this.db
      .prepare(
        "UPDATE agent_sessions SET updated_at=?,last_seen_at=? WHERE session_id=?",
      )
      .run(session.updated_at, session.last_seen_at, sessionId);
    return session;
  }
  updateSessionExternalId(sessionId, externalSessionId) {
    const session = this.getSession(sessionId);
    if (!session || session.state !== "attached")
      throw new Error(`Unknown attached AgentSession: ${sessionId}`);
    if (typeof externalSessionId !== "string" || !externalSessionId.trim())
      throw new Error("externalSessionId must be a non-empty string");
    if (
      session.external_session_id &&
      session.external_session_id !== externalSessionId
    )
      throw new Error(
        `AgentSession external identity changed: expected=${session.external_session_id}, actual=${externalSessionId}`,
      );
    session.external_session_id = externalSessionId;
    session.last_seen_at = nowIso();
    session.updated_at = session.last_seen_at;
    const path = childPath(this.sessionsRoot, `${sessionId}.json`);
    atomicJson(path, session);
    this.db
      .prepare(
        "UPDATE agent_sessions SET external_session_id=?,updated_at=?,last_seen_at=? WHERE session_id=?",
      )
      .run(
        session.external_session_id,
        session.updated_at,
        session.last_seen_at,
        sessionId,
      );
    return session;
  }
  closeSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Unknown AgentSession: ${sessionId}`);
    session.state = "closed";
    session.updated_at = nowIso();
    const path = childPath(this.sessionsRoot, `${sessionId}.json`);
    atomicJson(path, session);
    this.db
      .prepare(
        "UPDATE agent_sessions SET state=?,updated_at=? WHERE session_id=?",
      )
      .run(session.state, session.updated_at, sessionId);
    for (const lease of this.listLeases(session.task_id))
      if (lease.holder_session_id === sessionId)
        this.releaseLease(session.task_id, lease.lease_kind, sessionId);
    return session;
  }

  createAssignment(taskId, input) {
    const task = this.getTask(taskId, input.task_revision),
      plan = this.getExecutionPlan(taskId, input.plan_revision);
    if (!plan) throw new Error(`ExecutionPlan not found for task: ${taskId}`);
    const stage = plan.stages.find((item) => item.stage_id === input.stage_id);
    if (!stage)
      throw new Error(`Unknown ExecutionPlan stage: ${input.stage_id}`);
    const session = input.session_id ? this.getSession(input.session_id) : null;
    if (session && session.task_id !== taskId)
      throw new Error("AgentSession belongs to a different task");
    const assignment = finalizeAssignment({
        task,
        plan,
        stage,
        input,
        session,
      }),
      path = childPath(
        this.assignmentsRoot,
        `${assignment.assignment_id}.json`,
      );
    atomicJson(path, assignment);
    this.db
      .prepare("INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        assignment.assignment_id,
        taskId,
        assignment.task_revision,
        assignment.plan_revision,
        assignment.stage_id,
        assignment.role,
        assignment.state,
        assignment.session_id,
        assignment.run_id,
        assignment.write_intent ? 1 : 0,
        path,
        assignment.created_at,
        assignment.updated_at,
      );
    return assignment;
  }
  getAssignment(assignmentId) {
    const row = this.db
      .prepare("SELECT path FROM assignments WHERE assignment_id=?")
      .get(assignmentId);
    return row ? readJson(row.path) : null;
  }
  listAssignments(taskId) {
    return this.db
      .prepare(
        "SELECT path FROM assignments WHERE task_id=? ORDER BY created_at",
      )
      .all(taskId)
      .map((row) => readJson(row.path));
  }
  assignSession(assignmentId, sessionId) {
    const assignment = this.getAssignment(assignmentId),
      session = this.getSession(sessionId);
    if (!assignment) throw new Error(`Unknown Assignment: ${assignmentId}`);
    if (session?.task_id !== assignment.task_id)
      throw new Error("AgentSession belongs to a different task");
    assertSessionMatchesProfile(session, assignment.profile);
    if (!["queued", "blocked", "assigned"].includes(assignment.state))
      throw new Error(`Cannot assign session while ${assignment.state}`);
    if (assignment.state !== "assigned")
      assertAssignmentTransition(assignment.state, "assigned");
    assignment.session_id = sessionId;
    assignment.state = "assigned";
    assignment.updated_at = nowIso();
    this.#writeAssignment(assignment);
    return assignment;
  }
  transitionAssignment(assignmentId, to) {
    const assignment = this.getAssignment(assignmentId);
    if (!assignment) throw new Error(`Unknown Assignment: ${assignmentId}`);
    assertAssignmentTransition(assignment.state, to);
    assignment.state = to;
    assignment.updated_at = nowIso();
    this.#writeAssignment(assignment);
    return assignment;
  }
  bindAssignmentRun(assignmentId, runId) {
    const assignment = this.getAssignment(assignmentId);
    if (!assignment) throw new Error(`Unknown Assignment: ${assignmentId}`);
    if (assignment.run_id && assignment.run_id !== runId)
      throw new Error(`Assignment already bound to run: ${assignment.run_id}`);
    assignment.run_id = runId;
    assignment.updated_at = nowIso();
    this.#writeAssignment(assignment);
    return assignment;
  }
  #writeAssignment(assignment) {
    const path = childPath(
      this.assignmentsRoot,
      `${assignment.assignment_id}.json`,
    );
    atomicJson(path, assignment);
    this.db
      .prepare(
        "UPDATE assignments SET state=?,session_id=?,run_id=?,path=?,updated_at=? WHERE assignment_id=?",
      )
      .run(
        assignment.state,
        assignment.session_id,
        assignment.run_id,
        path,
        assignment.updated_at,
        assignment.assignment_id,
      );
  }

  createHandoff(taskId, input) {
    const task = this.getTask(taskId, input.task_revision),
      assignment = this.getAssignment(input.from_assignment_id),
      run = assignment?.run_id ? this.getRun(assignment.run_id) : null,
      handoff = finalizeHandoff({ task, input, assignment, run }),
      path = childPath(this.handoffsRoot, `${handoff.handoff_id}.json`);
    if (this.getHandoff(handoff.handoff_id))
      throw new Error(`Handoff already exists: ${handoff.handoff_id}`);
    atomicJson(path, handoff);
    this.db
      .prepare("INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        handoff.handoff_id,
        handoff.task_id,
        handoff.task_revision,
        handoff.plan_revision,
        handoff.from_assignment_id,
        handoff.from_run_id,
        handoff.to_stage_id,
        path,
        handoff.created_at,
      );
    if (handoff.from_run_id)
      this.appendEvent(handoff.from_run_id, {
        actor: { role: assignment.role, id: assignment.session_id },
        source: { kind: "control-plane" },
        type: "assignment.handoff_created",
        summary: handoff.summary,
        data: {
          handoff_id: handoff.handoff_id,
          to_stage_id: handoff.to_stage_id,
        },
      });
    return handoff;
  }
  getHandoff(handoffId) {
    const row = this.db
      .prepare("SELECT path FROM handoffs WHERE handoff_id=?")
      .get(handoffId);
    return row ? readJson(row.path) : null;
  }
  listHandoffs(taskId, { toStageId } = {}) {
    const rows = toStageId
      ? this.db
          .prepare(
            "SELECT path FROM handoffs WHERE task_id=? AND to_stage_id=? ORDER BY created_at",
          )
          .all(taskId, toStageId)
      : this.db
          .prepare(
            "SELECT path FROM handoffs WHERE task_id=? ORDER BY created_at",
          )
          .all(taskId);
    return rows.map((row) => readJson(row.path));
  }

  createMissionWorkspace(taskId, input) {
    const task = this.getTask(taskId, input.task_revision);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const existing = this.getMissionWorkspace(taskId);
    if (existing) return existing;
    const workspace = {
      schema: SCHEMAS.missionWorkspace,
      task_id: taskId,
      repository_root: resolve(input.repository_root),
      worktree_id: input.worktree_id,
      worktree_path: resolve(input.worktree_path),
      base_commit: input.base_commit,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (workspace.base_commit !== task.source.base_commit)
      throw new Error("MissionWorkspace base commit does not match task");
    const path = childPath(this.workspacesRoot, `${taskId}.json`);
    atomicJson(path, workspace);
    this.db
      .prepare("INSERT INTO mission_workspaces VALUES(?,?,?,?,?,?,?,?)")
      .run(
        taskId,
        workspace.repository_root,
        workspace.worktree_id,
        workspace.worktree_path,
        workspace.base_commit,
        path,
        workspace.created_at,
        workspace.updated_at,
      );
    return workspace;
  }
  getMissionWorkspace(taskId) {
    const row = this.db
      .prepare("SELECT path FROM mission_workspaces WHERE task_id=?")
      .get(taskId);
    return row ? readJson(row.path) : null;
  }

  acquireLease(taskId, kind, sessionId, options = {}) {
    const task = this.getTask(taskId),
      session = this.getSession(sessionId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (session?.task_id !== taskId || session.state !== "attached")
      throw new Error("Mission lease requires an attached task session");
    const existing = this.getLease(taskId, kind);
    if (
      existing &&
      Date.parse(existing.expires_at) > Date.now() &&
      existing.holder_session_id !== sessionId
    )
      throw new Error(`${kind} lease is held by ${existing.holder_session_id}`);
    if (
      existing &&
      kind === "workspace_write" &&
      Date.parse(existing.expires_at) > Date.now() &&
      existing.assignment_id !== (options.assignment_id ?? null)
    )
      throw new Error(
        `workspace_write lease is held for assignment ${existing.assignment_id}`,
      );
    const lease = makeMissionLease({
        taskId,
        kind,
        sessionId,
        assignmentId: options.assignment_id,
        ttlSeconds: options.ttl_seconds ?? 300,
      }),
      path = childPath(this.tasksRoot, taskId, "leases", `${kind}.json`);
    atomicJson(path, lease);
    this.db
      .prepare("INSERT OR REPLACE INTO mission_leases VALUES(?,?,?,?,?,?,?)")
      .run(
        taskId,
        kind,
        sessionId,
        lease.assignment_id,
        lease.expires_at,
        path,
        lease.updated_at,
      );
    return lease;
  }
  getLease(taskId, kind) {
    const row = this.db
      .prepare(
        "SELECT path FROM mission_leases WHERE task_id=? AND lease_kind=?",
      )
      .get(taskId, kind);
    return row ? readJson(row.path) : null;
  }
  listLeases(taskId) {
    return this.db
      .prepare("SELECT path FROM mission_leases WHERE task_id=?")
      .all(taskId)
      .map((row) => readJson(row.path))
      .filter((lease) => Date.parse(lease.expires_at) > Date.now());
  }
  requireLease(taskId, kind, sessionId) {
    const lease = this.getLease(taskId, kind);
    if (
      !lease ||
      lease.holder_session_id !== sessionId ||
      Date.parse(lease.expires_at) <= Date.now()
    )
      throw new Error(`Active ${kind} lease required for ${sessionId}`);
    return lease;
  }
  releaseLease(taskId, kind, sessionId) {
    const lease = this.getLease(taskId, kind);
    if (!lease) return null;
    if (lease.holder_session_id !== sessionId)
      throw new Error(`${kind} lease is held by another session`);
    const row = this.db
      .prepare(
        "SELECT path FROM mission_leases WHERE task_id=? AND lease_kind=?",
      )
      .get(taskId, kind);
    this.db
      .prepare("DELETE FROM mission_leases WHERE task_id=? AND lease_kind=?")
      .run(taskId, kind);
    if (row?.path) rmSync(row.path, { force: true });
    return lease;
  }

  getTaskActivity(taskId, eventLimit = 100) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const runs = this.listRuns().filter((run) => run.task_id === taskId),
      events = this.db
        .prepare(
          "SELECT event_json FROM events WHERE task_id=? ORDER BY recorded_at DESC LIMIT ?",
        )
        .all(taskId, eventLimit)
        .map((row) => JSON.parse(row.event_json));
    return {
      task,
      execution_plan: this.getExecutionPlan(taskId),
      workspace: this.getMissionWorkspace(taskId),
      leases: this.listLeases(taskId),
      sessions: this.listSessions(taskId),
      assignments: this.listAssignments(taskId),
      handoffs: this.listHandoffs(taskId),
      runs,
      events,
    };
  }

  createRun(input) {
    const task = this.getTask(input.task_id, input.task_revision);
    if (!task)
      throw new Error(`Unknown task: ${input.task_id}@${input.task_revision}`);
    const runId = input.run_id ?? makeId("run");
    const artifactRoot = ensureDir(
      childPath(this.runsRoot, runId, "artifacts"),
    );
    const context = {
      schema: "cross-agent/run-context/v1",
      run_id: runId,
      task_id: task.task_id,
      task_revision: task.revision,
      role: input.role ?? "Worker",
      runtime_id: input.runtime_id,
      adapter_version: input.adapter_version,
      repository_root: resolve(input.repository_root),
      worktree_id: input.worktree_id ?? null,
      worktree_path: input.worktree_path ? resolve(input.worktree_path) : null,
      base_commit: task.source.base_commit,
      artifact_root: artifactRoot,
      parent_run_id: input.parent_run_id ?? null,
      correction_delta_id: input.correction_delta_id ?? null,
      resume_session_id: input.resume_session_id ?? null,
      model_identity: {
        requested_model: input.requested_model ?? null,
        expected_model:
          input.expected_model ?? task.execution.expected_model ?? null,
      },
      execution_profile: input.execution_profile
        ? structuredClone(input.execution_profile)
        : null,
      provider_route: input.provider_route
        ? structuredClone(input.provider_route)
        : null,
      assigned_actor: input.assigned_actor ?? {
        kind: "runtime",
        id: input.runtime_id,
      },
      runtime_capabilities: input.runtime_capabilities ?? {},
      assignment_id: input.assignment_id ?? null,
      write_intent: input.write_intent ?? null,
      input_handoff_ids: input.input_handoff_ids ?? [],
      workflow_step_id: input.workflow_step_id ?? null,
      workspace_policy: input.workspace_policy ?? null,
      audit_bundle_run_id: input.audit_bundle_run_id ?? null,
      created_at: nowIso(),
    };
    atomicJson(childPath(this.runsRoot, runId, "run-context.json"), context);
    atomicJson(childPath(this.runsRoot, runId, "state.json"), {
      run_id: runId,
      state: "created",
      updated_at: context.created_at,
      process_id: null,
      lease_path: null,
    });
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        runId,
        task.task_id,
        task.revision,
        context.role,
        context.runtime_id,
        context.adapter_version,
        "created",
        context.repository_root,
        context.worktree_path,
        artifactRoot,
        context.parent_run_id,
        context.correction_delta_id,
        context.resume_session_id,
        context.created_at,
        context.created_at,
        null,
        null,
      );
    this.appendEvent(runId, {
      actor: { role: "System", id: "control-plane" },
      source: { kind: "control-plane" },
      type: "run.state_changed",
      summary: "Run created",
      data: { from: null, to: "created" },
    });
    return this.getRun(runId);
  }
  getRun(runId) {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId);
    return row
      ? {
          ...row,
          context: readJson(
            childPath(this.runsRoot, runId, "run-context.json"),
          ),
        }
      : null;
  }
  listRuns() {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all();
  }
  listTaskRuns(taskId) {
    return this.listRuns().filter((run) => run.task_id === taskId);
  }
  updateRunProcess(runId, processId, leasePath) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const updatedAt = nowIso();
    this.db
      .prepare(
        "UPDATE runs SET process_id=?,lease_path=?,updated_at=? WHERE run_id=?",
      )
      .run(processId, leasePath, updatedAt, runId);
    atomicJson(childPath(this.runsRoot, runId, "state.json"), {
      run_id: runId,
      state: run.state,
      updated_at: updatedAt,
      process_id: processId,
      lease_path: leasePath,
    });
  }
  transitionRun(runId, to, details = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    assertTransition(RUN_TRANSITIONS, run.state, to, "run");
    const event = this.appendEvent(runId, {
      actor: details.actor ?? { role: "System", id: "control-plane" },
      source: { kind: details.source_kind ?? "control-plane" },
      type: "run.state_changed",
      summary: details.summary ?? `Run ${run.state} -> ${to}`,
      data: {
        from: run.state,
        to,
        reason_code: details.reason_code,
        reason: details.reason,
        command_id: details.command_id,
      },
    });
    const updatedAt = nowIso();
    this.db
      .prepare("UPDATE runs SET state=?,updated_at=? WHERE run_id=?")
      .run(to, updatedAt, runId);
    atomicJson(childPath(this.runsRoot, runId, "state.json"), {
      run_id: runId,
      state: to,
      updated_at: updatedAt,
      process_id: run.process_id,
      lease_path: run.lease_path,
    });
    return event;
  }
  appendEvent(runId, input) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const sequence = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence),0)+1 next FROM events WHERE run_id=?",
        )
        .get(runId).next,
    );
    const recordedAt = nowIso();
    const event = {
      schema: SCHEMAS.event,
      event_id: input.event_id ?? makeId("evt"),
      run_id: runId,
      task_id: run.task_id,
      sequence,
      occurred_at: input.occurred_at ?? recordedAt,
      recorded_at: recordedAt,
      actor: input.actor,
      source: input.source,
      normalizer: input.normalizer ?? { name: "native", version: "1.0.0" },
      type: input.type,
      summary: input.summary,
      data: input.data ?? {},
      ...(input.extensions ? { extensions: input.extensions } : {}),
    };
    appendFileSync(
      childPath(this.runsRoot, runId, "events.ndjson"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event.event_id,
        runId,
        run.task_id,
        sequence,
        event.occurred_at,
        event.recorded_at,
        event.actor.role,
        event.actor.id,
        event.source.kind,
        event.type,
        event.summary,
        JSON.stringify(event),
      );
    return event;
  }
  listEvents(runId) {
    return this.db
      .prepare("SELECT event_json FROM events WHERE run_id=? ORDER BY sequence")
      .all(runId)
      .map((row) => JSON.parse(row.event_json));
  }

  createArtifact(
    runId,
    {
      kind,
      media_type = "application/octet-stream",
      source = "control-plane",
      data,
      extension = "bin",
    },
  ) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
        );
    const artifactId = makeId("art");
    const fileName = `${artifactId}.${extension.replace(/^\./, "")}`;
    writeFileSync(childPath(run.artifact_root, fileName), buffer);
    const metadata = {
      artifact_id: artifactId,
      run_id: runId,
      kind,
      media_type,
      sha256: sha256(buffer),
      bytes: buffer.byteLength,
      relative_path: `artifacts/${fileName}`,
      source,
      created_at: nowIso(),
    };
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        metadata.artifact_id,
        runId,
        kind,
        media_type,
        metadata.sha256,
        metadata.bytes,
        metadata.relative_path,
        source,
        metadata.created_at,
      );
    atomicJson(
      childPath(this.runsRoot, runId, "artifact-index.json"),
      this.listArtifacts(runId),
    );
    this.appendEvent(runId, {
      actor: { role: "System", id: "control-plane" },
      source: { kind: "control-plane" },
      type: "artifact.created",
      summary: `Created ${kind} artifact`,
      data: metadata,
    });
    return metadata;
  }
  listArtifacts(runId) {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at")
      .all(runId);
  }
  getArtifactPath(runId, artifactId) {
    const row = this.db
      .prepare(
        "SELECT relative_path FROM artifacts WHERE run_id=? AND artifact_id=?",
      )
      .get(runId, artifactId);
    return row ? childPath(this.runsRoot, runId, row.relative_path) : null;
  }
  recordVerification(runId, result) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO verification_results VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        runId,
        result.gate_id,
        result.status,
        result.exit_code,
        result.observed_tests ?? null,
        result.required ? 1 : 0,
        result.result_artifact_id,
        JSON.stringify(result),
      );
    atomicJson(
      childPath(this.runsRoot, runId, "verification-index.json"),
      this.listVerification(runId),
    );
    this.appendEvent(runId, {
      actor: { role: "Verifier", id: "control-plane-verifier" },
      source: { kind: "verifier" },
      type: "verification.result",
      summary: `${result.gate_id}: ${result.status}`,
      data: {
        gate_id: result.gate_id,
        status: result.status,
        result_artifact_id: result.result_artifact_id,
      },
    });
  }
  listVerification(runId) {
    return this.db
      .prepare(
        "SELECT result_json FROM verification_results WHERE run_id=? ORDER BY gate_id",
      )
      .all(runId)
      .map((row) => JSON.parse(row.result_json));
  }

  sealEvidenceBundle(runId, extra = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (this.db.prepare("SELECT 1 FROM bundles WHERE run_id=?").get(runId))
      throw new Error(`EvidenceBundle already sealed for ${runId}`);
    const task = this.getTask(run.task_id, run.task_revision);
    const modelEvent = this.listEvents(runId).findLast(
      (event) => event.type === "model.observed",
    );
    const bundle = {
      schema: SCHEMAS.bundle,
      bundle_id: makeId("bun"),
      task_id: run.task_id,
      task_revision: run.task_revision,
      spec_hash: task.spec_hash,
      run_id: runId,
      role: run.role,
      runtime: {
        runtime_id: run.runtime_id,
        adapter_version: run.adapter_version,
        model_identity: run.context.model_identity ?? null,
        observed_model: modelEvent?.data?.runtime?.actual_model ?? null,
      },
      base_commit: run.context.base_commit,
      worktree_id: run.context.worktree_id,
      created_at: nowIso(),
      verification: this.listVerification(runId),
      criterion_evidence: extra.criterion_evidence ?? [],
      failures_and_recovery: extra.failures_and_recovery ?? [],
      worker_self_report: extra.worker_self_report ?? null,
      artifacts: this.listArtifacts(runId),
    };
    bundle.manifest_sha256 = hashEvidenceBundle(bundle);
    const path = childPath(this.runsRoot, runId, "evidence-bundle.json");
    atomicJson(path, bundle);
    this.db
      .prepare("INSERT INTO bundles VALUES(?,?,?,?,?,?)")
      .run(
        bundle.bundle_id,
        runId,
        run.task_id,
        bundle.manifest_sha256,
        path,
        bundle.created_at,
      );
    return bundle;
  }
  getBundle(runId) {
    const row = this.db
      .prepare("SELECT path FROM bundles WHERE run_id=?")
      .get(runId);
    return row ? readJson(row.path) : null;
  }
  verifyBundle(runId) {
    const bundle = this.getBundle(runId);
    return bundle ? verifyEvidenceBundle(bundle) : false;
  }
  createAuditDecision(input) {
    if (
      !["accepted", "changes_requested", "rejected", "discarded"].includes(
        input.decision,
      )
    )
      throw new Error(`Invalid audit decision: ${input.decision}`);
    const run = this.getRun(input.run_id),
      bundleRunId =
        input.bundle_run_id ??
        run?.context?.audit_bundle_run_id ??
        input.run_id,
      bundle = bundleRunId ? this.getBundle(bundleRunId) : null;
    if (!run || !bundle)
      throw new Error(
        "AuditDecision requires an existing run and sealed EvidenceBundle",
      );
    const task = this.getTask(run.task_id, run.task_revision);
    if (run.state !== "review_ready" || task?.state !== "review_ready")
      throw new Error("AuditDecision requires run and task in review_ready");
    if (this.listDecisions(run.run_id).length)
      throw new Error(`AuditDecision already exists for ${run.run_id}`);
    assertTransition(TASK_TRANSITIONS, task.state, input.decision, "task");
    const decision = {
      schema: SCHEMAS.decision,
      decision_id: makeId("dec"),
      task_id: run.task_id,
      task_revision: run.task_revision,
      run_id: run.run_id,
      bundle_id: bundle.bundle_id,
      actor: input.actor ?? { role: "Auditor", id: "human-review" },
      decision: input.decision,
      criterion_results: input.criterion_results ?? [],
      finding_ids: input.finding_ids ?? [],
      created_at: nowIso(),
    };
    const path = childPath(this.decisionsRoot, `${decision.decision_id}.json`);
    atomicJson(path, decision);
    this.db
      .prepare("INSERT INTO audit_decisions VALUES(?,?,?,?,?,?,?)")
      .run(
        decision.decision_id,
        run.run_id,
        run.task_id,
        bundle.bundle_id,
        decision.decision,
        path,
        decision.created_at,
      );
    this.transitionTask(run.task_id, run.task_revision, input.decision);
    return decision;
  }
  listDecisions(runId) {
    return this.db
      .prepare(
        "SELECT path FROM audit_decisions WHERE run_id=? ORDER BY created_at",
      )
      .all(runId)
      .map((row) => readJson(row.path));
  }

  createCorrectionDelta(input) {
    const task = this.getTask(input.task_id, input.task_revision);
    if (!task || task.state !== "changes_requested")
      throw new Error("CorrectionDelta requires a task in changes_requested");
    const decisions = this.listDecisions(input.parent_run_id),
      decision = input.decision_id
        ? decisions.find((item) => item.decision_id === input.decision_id)
        : decisions.at(-1);
    if (
      !decision ||
      decision.decision !== "changes_requested" ||
      decision.task_id !== task.task_id ||
      decision.task_revision !== task.revision
    )
      throw new Error(
        "CorrectionDelta requires the matching changes_requested AuditDecision",
      );
    if (
      this.db
        .prepare("SELECT 1 FROM corrections WHERE decision_id=?")
        .get(decision.decision_id)
    )
      throw new Error(
        `CorrectionDelta already exists for ${decision.decision_id}`,
      );
    const correction = {
      schema: SCHEMAS.correction,
      correction_delta_id: makeId("cor"),
      task_id: task.task_id,
      task_revision: task.revision,
      parent_run_id: input.parent_run_id,
      decision_id: decision.decision_id,
      source_bundle_id: decision.bundle_id,
      actor: input.actor ?? { role: "Planner", id: "control-plane-planner" },
      finding_ids: input.finding_ids ?? decision.finding_ids,
      instructions: input.instructions ?? [],
      acceptance_adjustments: input.acceptance_adjustments ?? [],
      created_at: nowIso(),
    };
    const path = childPath(
      this.correctionsRoot,
      `${correction.correction_delta_id}.json`,
    );
    atomicJson(path, correction);
    this.db
      .prepare("INSERT INTO corrections VALUES(?,?,?,?,?,?,?,?)")
      .run(
        correction.correction_delta_id,
        correction.task_id,
        correction.task_revision,
        correction.parent_run_id,
        correction.decision_id,
        correction.source_bundle_id,
        path,
        correction.created_at,
      );
    return correction;
  }
  getCorrection(correctionDeltaId) {
    const row = this.db
      .prepare("SELECT path FROM corrections WHERE correction_delta_id=?")
      .get(correctionDeltaId);
    return row ? readJson(row.path) : null;
  }
  listCorrections(taskId) {
    return this.db
      .prepare(
        "SELECT path FROM corrections WHERE task_id=? ORDER BY created_at",
      )
      .all(taskId)
      .map((row) => readJson(row.path));
  }

  rebuildIndex() {
    this.db.exec(
      "DELETE FROM mission_leases;DELETE FROM mission_workspaces;DELETE FROM handoffs;DELETE FROM assignments;DELETE FROM agent_sessions;DELETE FROM execution_plans;DELETE FROM corrections;DELETE FROM audit_decisions;DELETE FROM bundles;DELETE FROM verification_results;DELETE FROM artifacts;DELETE FROM events;DELETE FROM runs;DELETE FROM tasks;",
    );
    for (const taskId of readdirSync(this.tasksRoot, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)) {
      const revisions = childPath(this.tasksRoot, taskId, "revisions");
      if (!existsSync(revisions)) continue;
      const statePath = childPath(this.tasksRoot, taskId, "state.json"),
        state = existsSync(statePath)
          ? readJson(statePath)
          : { state: "draft" };
      for (const file of readdirSync(revisions).filter((x) =>
        x.endsWith(".json"),
      )) {
        const path = join(revisions, file),
          spec = readJson(path);
        this.db
          .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)")
          .run(
            spec.task_id,
            spec.revision,
            spec.spec_hash,
            spec.title,
            state.revision === spec.revision ? state.state : "draft",
            spec.created_at,
            spec.metadata.task_class,
            path,
          );
      }
    }
    for (const runId of readdirSync(this.runsRoot, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)) {
      const contextPath = childPath(this.runsRoot, runId, "run-context.json");
      if (!existsSync(contextPath)) continue;
      const context = readJson(contextPath),
        statePath = childPath(this.runsRoot, runId, "state.json"),
        state = existsSync(statePath)
          ? readJson(statePath)
          : { state: "interrupted", updated_at: nowIso() };
      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          runId,
          context.task_id,
          context.task_revision,
          context.role,
          context.runtime_id,
          context.adapter_version,
          state.state,
          context.repository_root,
          context.worktree_path,
          context.artifact_root,
          context.parent_run_id,
          context.correction_delta_id,
          context.resume_session_id,
          context.created_at,
          state.updated_at,
          state.process_id ?? null,
          state.lease_path ?? null,
        );
      const events = childPath(this.runsRoot, runId, "events.ndjson");
      if (existsSync(events))
        for (const line of readFileSync(events, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)) {
          const e = JSON.parse(line);
          this.db
            .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              e.event_id,
              e.run_id,
              e.task_id,
              e.sequence,
              e.occurred_at,
              e.recorded_at,
              e.actor.role,
              e.actor.id,
              e.source.kind,
              e.type,
              e.summary,
              line,
            );
        }
      const artifacts = childPath(this.runsRoot, runId, "artifact-index.json");
      if (existsSync(artifacts))
        for (const a of readJson(artifacts))
          this.db
            .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)")
            .run(
              a.artifact_id,
              runId,
              a.kind,
              a.media_type,
              a.sha256,
              a.bytes,
              a.relative_path,
              a.source,
              a.created_at,
            );
      const verification = childPath(
        this.runsRoot,
        runId,
        "verification-index.json",
      );
      if (existsSync(verification))
        for (const v of readJson(verification))
          this.db
            .prepare("INSERT INTO verification_results VALUES(?,?,?,?,?,?,?,?)")
            .run(
              runId,
              v.gate_id,
              v.status,
              v.exit_code,
              v.observed_tests ?? null,
              v.required ? 1 : 0,
              v.result_artifact_id,
              JSON.stringify(v),
            );
      const bundlePath = childPath(
        this.runsRoot,
        runId,
        "evidence-bundle.json",
      );
      if (existsSync(bundlePath)) {
        const b = readJson(bundlePath);
        this.db
          .prepare("INSERT INTO bundles VALUES(?,?,?,?,?,?)")
          .run(
            b.bundle_id,
            runId,
            b.task_id,
            b.manifest_sha256,
            bundlePath,
            b.created_at,
          );
      }
    }
    for (const file of readdirSync(this.decisionsRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.decisionsRoot, file),
        d = readJson(path);
      this.db
        .prepare("INSERT INTO audit_decisions VALUES(?,?,?,?,?,?,?)")
        .run(
          d.decision_id,
          d.run_id,
          d.task_id,
          d.bundle_id,
          d.decision,
          path,
          d.created_at,
        );
    }
    for (const file of readdirSync(this.correctionsRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.correctionsRoot, file),
        c = readJson(path);
      this.db
        .prepare("INSERT INTO corrections VALUES(?,?,?,?,?,?,?,?)")
        .run(
          c.correction_delta_id,
          c.task_id,
          c.task_revision,
          c.parent_run_id,
          c.decision_id,
          c.source_bundle_id,
          path,
          c.created_at,
        );
    }
    for (const taskId of readdirSync(this.plansRoot, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)) {
      const root = childPath(this.plansRoot, taskId);
      for (const file of readdirSync(root).filter((x) => x.endsWith(".json"))) {
        const path = join(root, file),
          plan = readJson(path);
        this.db
          .prepare("INSERT INTO execution_plans VALUES(?,?,?,?,?)")
          .run(taskId, plan.revision, plan.plan_hash, path, plan.created_at);
      }
    }
    for (const file of readdirSync(this.sessionsRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.sessionsRoot, file),
        session = readJson(path);
      this.db
        .prepare(
          "INSERT INTO agent_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          session.session_id,
          session.task_id,
          session.surface,
          session.role,
          session.runtime_id,
          session.provider_id,
          session.model_id,
          session.billing_channel,
          session.state,
          session.external_session_id,
          path,
          session.created_at,
          session.updated_at,
          session.last_seen_at,
        );
    }
    for (const file of readdirSync(this.assignmentsRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.assignmentsRoot, file),
        assignment = readJson(path);
      this.db
        .prepare("INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          assignment.assignment_id,
          assignment.task_id,
          assignment.task_revision,
          assignment.plan_revision,
          assignment.stage_id,
          assignment.role,
          assignment.state,
          assignment.session_id,
          assignment.run_id,
          assignment.write_intent ? 1 : 0,
          path,
          assignment.created_at,
          assignment.updated_at,
        );
    }
    for (const file of readdirSync(this.handoffsRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.handoffsRoot, file),
        handoff = readJson(path);
      this.db
        .prepare("INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          handoff.handoff_id,
          handoff.task_id,
          handoff.task_revision,
          handoff.plan_revision,
          handoff.from_assignment_id,
          handoff.from_run_id,
          handoff.to_stage_id,
          path,
          handoff.created_at,
        );
    }
    for (const file of readdirSync(this.workspacesRoot).filter((x) =>
      x.endsWith(".json"),
    )) {
      const path = join(this.workspacesRoot, file),
        workspace = readJson(path);
      this.db
        .prepare("INSERT INTO mission_workspaces VALUES(?,?,?,?,?,?,?,?)")
        .run(
          workspace.task_id,
          workspace.repository_root,
          workspace.worktree_id,
          workspace.worktree_path,
          workspace.base_commit,
          path,
          workspace.created_at,
          workspace.updated_at,
        );
    }
    for (const task of this.listTasks()) {
      const leasesRoot = childPath(this.tasksRoot, task.task_id, "leases");
      if (!existsSync(leasesRoot)) continue;
      for (const file of readdirSync(leasesRoot).filter((x) =>
        x.endsWith(".json"),
      )) {
        const path = join(leasesRoot, file),
          lease = readJson(path);
        this.db
          .prepare("INSERT INTO mission_leases VALUES(?,?,?,?,?,?,?)")
          .run(
            lease.task_id,
            lease.lease_kind,
            lease.holder_session_id,
            lease.assignment_id,
            lease.expires_at,
            path,
            lease.updated_at,
          );
      }
    }
    return {
      tasks: Number(
        this.db.prepare("SELECT COUNT(*) count FROM tasks").get().count,
      ),
      runs: Number(
        this.db.prepare("SELECT COUNT(*) count FROM runs").get().count,
      ),
      events: Number(
        this.db.prepare("SELECT COUNT(*) count FROM events").get().count,
      ),
      sessions: Number(
        this.db.prepare("SELECT COUNT(*) count FROM agent_sessions").get()
          .count,
      ),
      assignments: Number(
        this.db.prepare("SELECT COUNT(*) count FROM assignments").get().count,
      ),
      handoffs: Number(
        this.db.prepare("SELECT COUNT(*) count FROM handoffs").get().count,
      ),
    };
  }
}
