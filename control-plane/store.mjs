import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id,sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id,created_at);
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
      assigned_actor: input.assigned_actor ?? {
        kind: "runtime",
        id: input.runtime_id,
      },
      runtime_capabilities: input.runtime_capabilities ?? {},
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
      bundle = this.getBundle(input.run_id);
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
      "DELETE FROM corrections;DELETE FROM audit_decisions;DELETE FROM bundles;DELETE FROM verification_results;DELETE FROM artifacts;DELETE FROM events;DELETE FROM runs;DELETE FROM tasks;",
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
    };
  }
}
