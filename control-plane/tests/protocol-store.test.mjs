import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  finalizeTaskSpec,
  hashTaskSpec,
  verifyEvidenceBundle,
} from "../protocol.mjs";
import { ControlPlaneStore } from "../store.mjs";
import { taskInput, tempDir } from "./helpers.mjs";

test("TaskSpec hash is canonical and immutable by revision", () => {
  const a = finalizeTaskSpec(taskInput("a".repeat(40))),
    b = structuredClone(a);
  b.metadata = { labels: b.metadata.labels, task_class: b.metadata.task_class };
  assert.equal(hashTaskSpec(a), hashTaskSpec(b));
});

test("event log, artifacts, bundle and SQLite projection rebuild", () => {
  const root = tempDir("control-plane-store"),
    store = new ControlPlaneStore(root);
  const task = store.createTask(taskInput("b".repeat(40)));
  store.transitionTask(task.task_id, task.revision, "ready");
  const run = store.createRun({
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0.0",
    repository_root: root,
    worktree_id: "wt_fixture",
    worktree_path: root,
  });
  store.transitionRun(run.run_id, "preparing");
  store.transitionRun(run.run_id, "running");
  store.transitionRun(run.run_id, "completed");
  store.transitionRun(run.run_id, "verifying");
  const artifact = store.createArtifact(run.run_id, {
    kind: "test",
    media_type: "text/plain",
    data: "ok",
    extension: "txt",
  });
  store.recordVerification(run.run_id, {
    gate_id: "unit",
    status: "passed",
    exit_code: 0,
    observed_tests: 1,
    required: true,
    result_artifact_id: artifact.artifact_id,
  });
  const bundle = store.sealEvidenceBundle(run.run_id);
  assert.match(bundle.manifest_sha256, /^sha256:/);
  assert.equal(verifyEvidenceBundle(bundle), true);
  assert.equal(verifyEvidenceBundle({ ...bundle, role: "tampered" }), false);
  assert.throws(() => store.sealEvidenceBundle(run.run_id));
  const before = store.listEvents(run.run_id);
  store.rebuildIndex();
  const after = store.listEvents(run.run_id);
  assert.deepEqual(after, before);
  assert.equal(store.listArtifacts(run.run_id).length, 1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("audit decisions are terminal per run and changes_requested creates an immutable correction delta", () => {
  const root = tempDir("control-plane-correction"),
    store = new ControlPlaneStore(root);
  const task = store.createTask(taskInput("e".repeat(40)));
  store.transitionTask(task.task_id, task.revision, "ready");
  store.transitionTask(task.task_id, task.revision, "running");
  store.transitionTask(task.task_id, task.revision, "verifying");
  const run = store.createRun({
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0.0",
    repository_root: root,
    worktree_id: "wt_fixture",
    worktree_path: root,
  });
  store.transitionRun(run.run_id, "preparing");
  store.transitionRun(run.run_id, "running");
  store.transitionRun(run.run_id, "completed");
  store.transitionRun(run.run_id, "verifying");
  store.sealEvidenceBundle(run.run_id);
  store.transitionRun(run.run_id, "review_ready");
  store.transitionTask(task.task_id, task.revision, "review_ready");
  const decision = store.createAuditDecision({
    run_id: run.run_id,
    decision: "changes_requested",
    finding_ids: ["finding_1"],
  });
  assert.equal(store.getTask(task.task_id).state, "changes_requested");
  assert.throws(() =>
    store.createAuditDecision({ run_id: run.run_id, decision: "accepted" }),
  );
  const correction = store.createCorrectionDelta({
    task_id: task.task_id,
    task_revision: task.revision,
    parent_run_id: run.run_id,
    decision_id: decision.decision_id,
    instructions: ["Address finding_1"],
  });
  assert.equal(
    store.getCorrection(correction.correction_delta_id).source_bundle_id,
    decision.bundle_id,
  );
  assert.throws(() =>
    store.createCorrectionDelta({
      task_id: task.task_id,
      task_revision: task.revision,
      parent_run_id: run.run_id,
      decision_id: decision.decision_id,
    }),
  );
  store.rebuildIndex();
  assert.equal(store.listCorrections(task.task_id).length, 1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
