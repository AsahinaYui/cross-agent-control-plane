import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ControlPlaneStore } from "../store.mjs";
import { ControlPlaneOrchestrator } from "../orchestrator.mjs";
import { runVerificationMatrix } from "../verification.mjs";
import { createGitFixture, taskInput, tempDir } from "./helpers.mjs";
import { writeLease } from "../process.mjs";

test("fake runtime reaches review_ready with sealed evidence", async () => {
  const repo = await createGitFixture(),
    state = tempDir("control-plane-state"),
    store = new ControlPlaneStore(state);
  const task = store.createTask(
    taskInput(repo.head, [
      {
        gate_id: "node",
        kind: "test",
        argv: [process.execPath, "-e", "console.log('1 test passed')"],
        required: true,
        min_tests: 1,
        parser: "generic",
        timeout_seconds: 10,
      },
    ]),
  );
  const orchestrator = new ControlPlaneOrchestrator({
    store,
    worktreesRoot: join(state, "worktrees"),
  });
  const started = await orchestrator.startTask({
    taskId: task.task_id,
    taskRevision: task.revision,
    repositoryRoot: repo.root,
    runtimeId: "fake",
    runtimeOptions: { mode: "success" },
  });
  const run = await started.completion;
  assert.equal(run.state, "review_ready");
  assert.ok(store.getBundle(run.run_id));
  assert.equal(store.getTask(task.task_id).state, "review_ready");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("zero-test false green fails a required gate", async () => {
  const state = tempDir("zero-test"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput("c".repeat(40)));
  const run = store.createRun({
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  const matrix = await runVerificationMatrix({
    store,
    runId: run.run_id,
    taskSpec: {
      ...task,
      verification: {
        gates: [
          {
            gate_id: "zero",
            argv: [process.execPath, "-e", "console.log('0 tests passed')"],
            required: true,
            min_tests: 1,
            parser: "generic",
          },
        ],
      },
    },
    worktreePath: state,
  });
  assert.equal(matrix.passed, false);
  assert.equal(matrix.results[0].observed_tests, 0);
  store.close();
  rmSync(state, { recursive: true, force: true });
});

for (const mode of ["malformed", "denied", "nonzero"])
  test(`fake ${mode} result fails deterministically`, async () => {
    const repo = await createGitFixture(`failure-${mode}`),
      state = tempDir(`failure-${mode}`),
      store = new ControlPlaneStore(state),
      task = store.createTask(taskInput(repo.head));
    const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    });
    const started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      runtimeOptions: { mode },
    });
    const run = await started.completion;
    assert.equal(run.state, "failed");
    assert.equal(store.getTask(task.task_id).state, "blocked");
    assert.equal(
      store
        .listArtifacts(run.run_id)
        .some((a) => a.kind === "runtime_raw_events"),
      true,
    );
    store.close();
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

test("model identity mismatch is a failed run", async () => {
  const repo = await createGitFixture("model-mismatch"),
    state = tempDir("model-mismatch"),
    store = new ControlPlaneStore(state),
    input = taskInput(repo.head);
  input.execution.expected_model = "different-model";
  const task = store.createTask(input);
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
    });
  assert.equal((await started.completion).state, "failed");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("cancel stops the owned process tree and preserves the task", async () => {
  const repo = await createGitFixture("cancel-run"),
    state = tempDir("cancel-run"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repo.head));
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      runtimeOptions: { mode: "hang" },
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await orchestrator.cancel(started.run.run_id);
  const run = await started.completion;
  assert.equal(run.state, "canceled");
  assert.equal(store.getTask(task.task_id).state, "blocked");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("cancel requested before the runtime handle exists is honored", async () => {
  const repo = await createGitFixture("early-cancel-run"),
    state = tempDir("early-cancel-run"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repo.head));
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let finish;
  const runtimeCompletion = new Promise((resolve) => {
    finish = resolve;
  });
  let cancelCalled = false;
  const adapter = {
    runtimeId: "slow-fake",
    adapterVersion: "1.0.0",
    async describe() {
      return {
        runtime_id: this.runtimeId,
        adapter_version: this.adapterVersion,
        capabilities: { structured_events: true },
      };
    },
    async start() {
      await startGate;
      return { pid: process.pid, completion: runtimeCompletion };
    },
    async wait(handle) {
      return handle.completion;
    },
    async cancel() {
      cancelCalled = true;
      finish({ exit_code: 143, stdout: "", stderr: "canceled" });
    },
    normalize() {
      return {};
    },
  };
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
      runtimeAdapterFactory: () => adapter,
    }),
    started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "slow-fake",
    });
  await orchestrator.cancel(started.run.run_id);
  releaseStart();
  const run = await started.completion;
  assert.equal(cancelCalled, true);
  assert.equal(run.state, "canceled");
  assert.equal(store.getTask(task.task_id).state, "blocked");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("stale lease recovery marks an active run interrupted", async () => {
  const state = tempDir("recovery"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput("d".repeat(40)));
  store.transitionTask(task.task_id, task.revision, "ready");
  const run = store.createRun({
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  store.transitionRun(run.run_id, "preparing");
  store.transitionRun(run.run_id, "running");
  const lease = join(state, "dead-lease.json");
  writeLease(lease, { run_id: run.run_id, pid: 99999999 });
  store.updateRunProcess(run.run_id, 99999999, lease);
  const orchestrator = new ControlPlaneOrchestrator({
    store,
    worktreesRoot: join(state, "worktrees"),
  });
  assert.deepEqual(await orchestrator.reconcile(), [run.run_id]);
  assert.equal(store.getRun(run.run_id).state, "interrupted");
  store.close();
  rmSync(state, { recursive: true, force: true });
});

test("runtime timeout is recorded as a failed run", async () => {
  const repo = await createGitFixture("timeout-run"),
    state = tempDir("timeout-run"),
    store = new ControlPlaneStore(state),
    input = taskInput(repo.head);
  input.execution.budget.timeout_seconds = 0.1;
  const task = store.createTask(input);
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      runtimeOptions: { mode: "hang" },
    });
  const run = await started.completion,
    terminalEvent = store
      .listEvents(run.run_id)
      .findLast(
        (event) =>
          event.type === "run.state_changed" && event.data.to === "failed",
      );
  assert.equal(run.state, "failed");
  assert.equal(terminalEvent.data.reason_code, "runtime_timeout");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("scope violations cannot reach review_ready", async () => {
  const repo = await createGitFixture("scope-run"),
    state = tempDir("scope-run"),
    store = new ControlPlaneStore(state),
    input = taskInput(repo.head);
  input.scope = { allow: ["src/**"], deny: [] };
  const task = store.createTask(input);
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    started = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      runtimeOptions: { mode: "scope-violation" },
    });
  const run = await started.completion,
    scope = store
      .listVerification(run.run_id)
      .find((result) => result.gate_id === "control-plane:scope"),
    terminalEvent = store
      .listEvents(run.run_id)
      .findLast(
        (event) =>
          event.type === "run.state_changed" && event.data.to === "failed",
      );
  assert.equal(run.state, "failed");
  assert.equal(scope.status, "failed");
  assert.equal(terminalEvent.data.reason_code, "scope_violation");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("a correction run preserves parent, delta, and model identity", async () => {
  const repo = await createGitFixture("correction-run"),
    state = tempDir("correction-run"),
    store = new ControlPlaneStore(state),
    input = taskInput(repo.head);
  input.execution.expected_model = "deterministic-fake-v1";
  const task = store.createTask(input);
  const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    first = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      requestedModel: "deterministic-fake-v1",
    }),
    firstRun = await first.completion;
  const decision = store.createAuditDecision({
      run_id: firstRun.run_id,
      decision: "changes_requested",
      finding_ids: ["finding_1"],
    }),
    correction = store.createCorrectionDelta({
      task_id: task.task_id,
      task_revision: task.revision,
      parent_run_id: firstRun.run_id,
      decision_id: decision.decision_id,
      instructions: ["Apply the correction"],
    });
  const second = await orchestrator.startTask({
      taskId: task.task_id,
      taskRevision: task.revision,
      repositoryRoot: repo.root,
      runtimeId: "fake",
      requestedModel: "deterministic-fake-v1",
      parentRunId: firstRun.run_id,
      correctionDeltaId: correction.correction_delta_id,
    }),
    secondRun = await second.completion;
  assert.equal(secondRun.state, "review_ready");
  assert.equal(secondRun.context.parent_run_id, firstRun.run_id);
  assert.equal(
    secondRun.context.correction_delta_id,
    correction.correction_delta_id,
  );
  assert.equal(
    secondRun.context.model_identity.requested_model,
    "deterministic-fake-v1",
  );
  assert.equal(
    store.getBundle(secondRun.run_id).runtime.observed_model,
    "deterministic-fake-v1",
  );
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});
