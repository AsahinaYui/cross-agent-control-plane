import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneStore } from "../store.mjs";
import { ControlPlaneOrchestrator } from "../orchestrator.mjs";
import { createGitFixture, taskInput, tempDir } from "./helpers.mjs";
import {
  parseWorkflowManifestText,
  normalizeWorkflowManifest,
  topologicalSort,
  resolveWorkspacePolicy,
  buildTaskInputFromWorkflow,
  buildExecutionPlanInputFromWorkflow,
  selectAttachment,
  coordinatorSessionInput,
} from "../workflow.mjs";

// ---------------------------------------------------------------------------
// Workflow manifest parsing
// ---------------------------------------------------------------------------

test("parseWorkflowManifestText rejects YAML", () => {
  assert.throws(
    () => parseWorkflowManifestText("version: 1\nsteps: []", "test.yaml"),
    /YAML manifests are intentionally unsupported/,
  );
});

test("parseWorkflowManifestText rejects empty", () => {
  assert.throws(
    () => parseWorkflowManifestText("", "empty.json"),
    /empty/,
  );
});

test("parseWorkflowManifestText rejects non-JSON", () => {
  assert.throws(
    () => parseWorkflowManifestText("not json", "bad.json"),
    /not valid JSON/,
  );
});

test("parseWorkflowManifestText rejects wrong version", () => {
  assert.throws(
    () => parseWorkflowManifestText(JSON.stringify({ version: 2, steps: [] }), "v2.json"),
    /version must be 1/,
  );
});

test("parseWorkflowManifestText rejects non-current-session coordinator", () => {
  assert.throws(
    () =>
      parseWorkflowManifestText(
        JSON.stringify({
          version: 1,
          coordinator: { mode: "mcp" },
          steps: [{ id: "s1", executor: "coordinator" }],
        }),
        "bad-coord.json",
      ),
    /coordinator.mode must be current-session/,
  );
});

test("parseWorkflowManifestText rejects empty steps", () => {
  assert.throws(
    () =>
      parseWorkflowManifestText(
        JSON.stringify({ version: 1, steps: [] }),
        "empty.json",
      ),
    /must not be empty/,
  );
});

test("parseWorkflowManifestText accepts minimal valid manifest", () => {
  const manifest = parseWorkflowManifestText(
    JSON.stringify({
      version: 1,
      steps: [{ id: "s1", executor: "coordinator" }],
    }),
    "minimal.json",
  );
  assert.equal(manifest.version, 1);
  assert.equal(manifest.workspace.policy, "mission");
  assert.equal(manifest.coordinator.mode, "current-session");
  assert.equal(manifest.steps.length, 1);
  assert.equal(manifest.steps[0].id, "s1");
  assert.equal(manifest.steps[0].executor, "coordinator");
});

test("parseWorkflowManifestText accepts managed step with runtime", () => {
  const manifest = parseWorkflowManifestText(
    JSON.stringify({
      version: 1,
      steps: [
        {
          id: "impl",
          runtime: "codex-cli",
          provider: "ccswitch/deepseek",
          model: "deepseek-v4-flash",
          responsibility: "Implement the feature",
          writes: true,
        },
      ],
    }),
    "managed.json",
  );
  assert.equal(manifest.steps.length, 1);
  const step = manifest.steps[0];
  assert.equal(step.executor, "managed");
  assert.equal(step.runtime, "codex-cli");
  assert.equal(step.provider.source, "ccswitch");
  assert.equal(step.provider.id, "deepseek");
  assert.equal(step.model, "deepseek-v4-flash");
  assert.equal(step.writes, true);
  assert.equal(step.responsibility, "Implement the feature");
});

test("parseWorkflowManifestText enforces acyclic dependencies", () => {
  assert.throws(
    () =>
      parseWorkflowManifestText(
        JSON.stringify({
          version: 1,
          steps: [
            { id: "a", depends_on: ["b"], executor: "coordinator" },
            { id: "b", depends_on: ["a"], executor: "coordinator" },
          ],
        }),
        "cycle.json",
      ),
    /acyclic/,
  );
});

test("parseWorkflowManifestText enforces dependency existence", () => {
  assert.throws(
    () =>
      parseWorkflowManifestText(
        JSON.stringify({
          version: 1,
          steps: [
            { id: "a", depends_on: ["nonexistent"], executor: "coordinator" },
          ],
        }),
        "missing-dep.json",
      ),
    /references unknown step/,
  );
});

test("parseWorkflowManifestText accepts depends_on ordering", () => {
  const manifest = parseWorkflowManifestText(
    JSON.stringify({
      version: 1,
      steps: [
        { id: "a", executor: "coordinator" },
        { id: "b", depends_on: ["a"], executor: "coordinator" },
        { id: "c", depends_on: ["a", "b"], executor: "coordinator" },
      ],
    }),
    "dag.json",
  );
  assert.equal(manifest.steps.length, 3);
});

test("parseWorkflowManifestText accepts limits", () => {
  const manifest = parseWorkflowManifestText(
    JSON.stringify({
      version: 1,
      limits: {
        concurrency: 2,
        max_duration_seconds: 3600,
        inactivity_timeout_seconds: 600,
        repeated_failure_limit: 3,
        max_tokens: 100000,
        max_cost_usd: 5.0,
      },
      steps: [{ id: "s1", executor: "coordinator" }],
    }),
    "limits.json",
  );
  assert.equal(manifest.limits.concurrency, 2);
  assert.equal(manifest.limits.max_duration_seconds, 3600);
  assert.equal(manifest.limits.inactivity_timeout_seconds, 600);
  assert.equal(manifest.limits.repeated_failure_limit, 3);
  assert.equal(manifest.limits.max_tokens, 100000);
  assert.equal(manifest.limits.max_cost_usd, 5.0);
});

test("parseWorkflowManifestText accepts workspace policies", () => {
  for (const policy of ["shared", "mission", "isolated", "auto"]) {
    const manifest = parseWorkflowManifestText(
      JSON.stringify({
        version: 1,
        workspace: { policy },
        steps: [{ id: "s1", executor: "coordinator" }],
      }),
      `${policy}.json`,
    );
    assert.equal(manifest.workspace.policy, policy);
  }
});

test("parseWorkflowManifestText rejects invalid workspace policy", () => {
  assert.throws(
    () =>
      parseWorkflowManifestText(
        JSON.stringify({
          version: 1,
          workspace: { policy: "invalid" },
          steps: [{ id: "s1", executor: "coordinator" }],
        }),
        "bad-policy.json",
      ),
    /must be one of/,
  );
});

// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------

test("topologicalSort preserves order for independent steps", () => {
  const steps = [
    { id: "a", depends_on: [] },
    { id: "b", depends_on: [] },
    { id: "c", depends_on: [] },
  ];
  const sorted = topologicalSort(steps);
  assert.equal(sorted.length, 3);
  assert.equal(sorted[0].id, "a");
  assert.equal(sorted[1].id, "b");
  assert.equal(sorted[2].id, "c");
});

test("topologicalSort respects dependency ordering", () => {
  const steps = [
    { id: "b", depends_on: ["a"] },
    { id: "c", depends_on: ["a", "b"] },
    { id: "a", depends_on: [] },
  ];
  const sorted = topologicalSort(steps);
  const positions = new Map(sorted.map((s, i) => [s.id, i]));
  assert.ok(positions.get("a") < positions.get("b"));
  assert.ok(positions.get("b") < positions.get("c"));
});

// ---------------------------------------------------------------------------
// resolveWorkspacePolicy
// ---------------------------------------------------------------------------

test("resolveWorkspacePolicy defaults to mission", () => {
  assert.equal(resolveWorkspacePolicy([{ workspace_policy: "mission" }]), "mission");
});

test("resolveWorkspacePolicy escalates to isolated", () => {
  assert.equal(
    resolveWorkspacePolicy([
      { workspace_policy: "mission" },
      { workspace_policy: "isolated" },
    ]),
    "isolated",
  );
});

test("resolveWorkspacePolicy prioritizes isolated over shared", () => {
  assert.equal(
    resolveWorkspacePolicy([
      { workspace_policy: "shared" },
      { workspace_policy: "isolated" },
    ]),
    "isolated",
  );
});

// ---------------------------------------------------------------------------
// Task terminal transitions (AuditDecision)
// ---------------------------------------------------------------------------

function transitionTaskToReviewReady(store, taskId, revision, runId) {
  store.transitionTask(taskId, revision, "ready");
  store.transitionTask(taskId, revision, "running");
  store.transitionTask(taskId, revision, "verifying");
  store.transitionTask(taskId, revision, "review_ready");
}

function transitionRunToReviewReady(store, runId) {
  store.transitionRun(runId, "preparing");
  store.transitionRun(runId, "running");
  store.transitionRun(runId, "completed");
  store.transitionRun(runId, "verifying");
  store.transitionRun(runId, "review_ready");
}

test("audit decision transitions task to accepted", () => {
  const state = tempDir("audit-accepted");
  const store = new ControlPlaneStore(state);
  const task = store.createTask(taskInput("a".repeat(40)));
  // Transition task through valid states
  transitionTaskToReviewReady(store, task.task_id, task.revision, "run-audit-accepted");
  const run = store.createRun({
    run_id: "run-audit-accepted",
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  transitionRunToReviewReady(store, run.run_id);
  // Create the bundle
  store.sealEvidenceBundle(run.run_id);
  // Create audit decision
  const decision = store.createAuditDecision({
    run_id: run.run_id,
    decision: "accepted",
    task_id: task.task_id,
    task_revision: task.revision,
    finding_ids: [],
  });
  assert.equal(decision.decision, "accepted");
  const updatedTask = store.getTask(task.task_id);
  assert.equal(updatedTask.state, "accepted");
  store.close();
  rmSync(state, { recursive: true, force: true });
});

test("audit decision transitions task to changes_requested", () => {
  const state = tempDir("audit-changes");
  const store = new ControlPlaneStore(state);
  const task = store.createTask(taskInput("b".repeat(40)));
  transitionTaskToReviewReady(store, task.task_id, task.revision, "run-audit-changes");
  const run = store.createRun({
    run_id: "run-audit-changes",
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  transitionRunToReviewReady(store, run.run_id);
  store.sealEvidenceBundle(run.run_id);
  const decision = store.createAuditDecision({
    run_id: run.run_id,
    decision: "changes_requested",
    task_id: task.task_id,
    task_revision: task.revision,
    finding_ids: ["finding_1"],
  });
  assert.equal(decision.decision, "changes_requested");
  const updatedTask = store.getTask(task.task_id);
  assert.equal(updatedTask.state, "changes_requested");
  store.close();
  rmSync(state, { recursive: true, force: true });
});

test("audit decision transitions task to rejected", () => {
  const state = tempDir("audit-rejected");
  const store = new ControlPlaneStore(state);
  const task = store.createTask(taskInput("c".repeat(40)));
  transitionTaskToReviewReady(store, task.task_id, task.revision, "run-audit-rejected");
  const run = store.createRun({
    run_id: "run-audit-rejected",
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  transitionRunToReviewReady(store, run.run_id);
  store.sealEvidenceBundle(run.run_id);
  const decision = store.createAuditDecision({
    run_id: run.run_id,
    decision: "rejected",
    task_id: task.task_id,
    task_revision: task.revision,
    finding_ids: [],
  });
  assert.equal(decision.decision, "rejected");
  const updatedTask = store.getTask(task.task_id);
  assert.equal(updatedTask.state, "rejected");
  store.close();
  rmSync(state, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildTaskInputFromWorkflow and buildExecutionPlanInputFromWorkflow
// ---------------------------------------------------------------------------

test("buildTaskInputFromWorkflow produces valid task input", () => {
  const raw = {
    version: 1,
    workspace: { policy: "mission" },
    coordinator: { mode: "current-session" },
    limits: { concurrency: 1, max_duration_seconds: 1800 },
    steps: [{ id: "impl", executor: "coordinator" }],
  };
  const workflow = normalizeWorkflowManifest(raw);
  const input = buildTaskInputFromWorkflow({
    workflow,
    goal: "Test the workflow",
    repositoryRoot: "/tmp/test-repo",
    baseCommit: "abc123",
  });
  assert.equal(input.title, "Test the workflow");
  assert.equal(input.goal, "Test the workflow");
  assert.equal(input.source.repository_id, "test-repo");
  assert.equal(input.source.base_commit, "abc123");
  assert.ok(Array.isArray(input.acceptance));
  assert.ok(Array.isArray(input.verification.gates));
  assert.equal(input.metadata.labels[0], "workflow");
});

test("buildExecutionPlanInputFromWorkflow produces valid plan input", () => {
  const raw = {
    version: 1,
    workspace: { policy: "mission" },
    coordinator: { mode: "current-session" },
    limits: { concurrency: 1, max_duration_seconds: 1800, repeated_failure_limit: 2 },
    steps: [
      {
        id: "impl",
        runtime: "codex-cli",
        provider: "ccswitch/deepseek",
        model: "deepseek-v4-flash",
        responsibility: "Implement",
        writes: true,
        depends_on: [],
      },
    ],
  };
  const workflow = normalizeWorkflowManifest(raw);
  const input = buildExecutionPlanInputFromWorkflow({
    workflow,
    coordinatorSurface: "terminal",
  });
  assert.equal(input.fallback_policy, "disabled");
  assert.equal(input.concurrency_limit, 1);
  assert.equal(input.workspace_policy, "mission");
  assert.equal(input.stages.length, 1);
  assert.equal(input.stages[0].stage_id, "impl");
  assert.equal(input.stages[0].executor_kind, "managed");
  assert.equal(input.stages[0].write_intent, true);
  assert.equal(input.stages[0].profile.runtime_id, "codex-cli");
  assert.equal(input.stages[0].profile.provider_id, "deepseek");
  assert.equal(input.stages[0].profile.model_id, "deepseek-v4-flash");
});

// ---------------------------------------------------------------------------
// cap CLI command tests (via daemon-less HTTP API)
// ---------------------------------------------------------------------------

test("cap attach and inspectRepository", async () => {
  const repo = await createGitFixture("cap-attach");
  const { inspectRepository } = await import("../worktree.mjs");
  const info = await inspectRepository(repo.root);
  assert.ok(info.repository_root);
  assert.ok(info.head);
  assert.equal(info.clean, true);
  rmSync(repo.root, { recursive: true, force: true });
});

test("cap run with workflow produces task and plan", async () => {
  const repo = await createGitFixture("cap-run");
  const state = tempDir("cap-run-state");
  const store = new ControlPlaneStore(state);

  const raw = {
    version: 1,
    workspace: { policy: "mission" },
    coordinator: { mode: "current-session" },
    steps: [{ id: "direction", executor: "coordinator" }],
  };
  const workflow = normalizeWorkflowManifest(raw);
  const taskInputData = buildTaskInputFromWorkflow({
    workflow,
    goal: "Cap run test",
    repositoryRoot: repo.root,
    baseCommit: repo.head,
  });
  const task = store.createTask(taskInputData);
  assert.equal(task.state, "draft");
  assert.ok(task.task_id);

  const planInput = buildExecutionPlanInputFromWorkflow({
    workflow,
    coordinatorSurface: "terminal",
  });
  const plan = store.createExecutionPlan(task.task_id, planInput);
  assert.equal(plan.stages.length, 1);
  assert.equal(plan.stages[0].stage_id, "direction");

  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("cap decide via HTTP API", async () => {
  const repo = await createGitFixture("cap-decide-api");
  const state = tempDir("cap-decide-api-state");
  const store = new ControlPlaneStore(state);
  const task = store.createTask(taskInput(repo.head));
  transitionTaskToReviewReady(store, task.task_id, task.revision, "run-cap-decide");

  const run = store.createRun({
    run_id: "run-cap-decide",
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  transitionRunToReviewReady(store, run.run_id);
  store.sealEvidenceBundle(run.run_id);

  const decision = store.createAuditDecision({
    run_id: run.run_id,
    decision: "accepted",
    task_id: task.task_id,
    task_revision: task.revision,
    finding_ids: [],
  });
  assert.equal(decision.decision, "accepted");
  const updatedTask = store.getTask(task.task_id);
  assert.equal(updatedTask.state, "accepted");

  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("cancel stops run and transitions correctly", async () => {
  const repo = await createGitFixture("cap-cancel");
  const state = tempDir("cap-cancel-state");
  const store = new ControlPlaneStore(state);
  const task = store.createTask(taskInput(repo.head));

  const run = store.createRun({
    run_id: "run-cap-cancel",
    task_id: task.task_id,
    task_revision: task.revision,
    runtime_id: "fake",
    adapter_version: "1.0",
    repository_root: state,
    worktree_id: "wt",
    worktree_path: state,
  });
  store.transitionRun(run.run_id, "preparing");
  store.transitionRun(run.run_id, "running");

  // Cancel via transition (simulates orchestrator.cancel)
  store.transitionRun(run.run_id, "cancel_requested", { reason_code: "user_requested" });
  store.transitionRun(run.run_id, "canceled");

  assert.equal(store.getRun(run.run_id).state, "canceled");
  const events = store.listEvents(run.run_id);
  const cancelEvent = events.find((e) => e.type === "run.state_changed" && e.data.to === "canceled");
  assert.ok(cancelEvent);

  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Managed fake-runtime integration test (workflow run with terminal + activity)
// ---------------------------------------------------------------------------

test("managed fake-runtime workflow produces terminal run with activity", async () => {
  const repo = await createGitFixture("managed-integration"),
    state = tempDir("managed-integration-state"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repo.head));
  const planInput = {
    fallback_policy: "disabled",
    coordinator_surface: "terminal",
    concurrency_limit: 1,
    workspace_policy: "mission",
    limits: { max_duration_seconds: 30, repeated_failure_limit: 2 },
    stages: [
      {
        stage_id: "impl",
        role: "Worker",
        responsibility: "Implement the feature",
        executor_kind: "managed",
        write_intent: true,
        depends_on: [],
        workspace_policy: "mission",
        timeout_seconds: null,
        profile: {
          profile_id: "wf-impl",
          runtime_id: "fake",
          provider_id: "ccswitch/deepseek",
          model_id: "deterministic-fake-v1",
          billing_channel: "external-api",
          provider_source: "ccswitch",
          ccswitch_app_type: "codex",
          provider_config_hash: "sha256:workflow",
        },
      },
    ],
  };
  store.createExecutionPlan(task.task_id, planInput);
  // Create coordinator session
  const coordinatorSession = store.attachSession(task.task_id, {
    profile_id: "current-session-coordinator",
    runtime_id: "current-session",
    provider_id: "surface-owned",
    model_id: "surface-owned",
    billing_channel: "surface-owned",
    surface: "terminal",
    role: "Coordinator",
  });
  // Acquire coordinator lease
  store.acquireLease(task.task_id, "coordinator", coordinatorSession.session_id, {
    assignment_id: null,
    ttl_seconds: 86400,
  });
  // Create managed session
  const managedSession = store.attachSession(task.task_id, {
    profile_id: "wf-impl",
    runtime_id: "fake",
    provider_id: "ccswitch/deepseek",
    model_id: "deterministic-fake-v1",
    billing_channel: "external-api",
    provider_source: "ccswitch",
    ccswitch_app_type: "codex",
    provider_config_hash: "sha256:workflow",
    surface: "managed-control-plane",
    role: "Worker",
  });
  // Create assignment with session bound
  const assignment = store.createAssignment(task.task_id, {
    stage_id: "impl",
    role: "Worker",
    prompt: "Implement the feature",
    write_intent: true,
    depends_on: [],
    workspace_policy: "mission",
    executor_kind: "managed",
    session_id: managedSession.session_id,
    profile: {
      profile_id: "wf-impl",
      runtime_id: "fake",
      provider_id: "ccswitch/deepseek",
      model_id: "deterministic-fake-v1",
      billing_channel: "external-api",
      provider_source: "ccswitch",
      ccswitch_app_type: "codex",
      provider_config_hash: "sha256:workflow",
    },
  });
  assert.equal(assignment.state, "assigned");
  // Start the assignment run
  const orchestrator = new ControlPlaneOrchestrator({
    store,
    worktreesRoot: join(state, "worktrees"),
  });
  const started = await orchestrator.startAssignment({
    assignmentId: assignment.assignment_id,
    coordinatorSessionId: coordinatorSession.session_id,
    repositoryRoot: repo.root,
    runtimeOptions: { mode: "success" },
  });
  const run = await started.completion;
  assert.equal(run.state, "completed");
  assert.equal(store.getTask(task.task_id).state, "running");
  // Verify activity was recorded
  const events = store.listEvents(run.run_id);
  assert.ok(events.length > 0, "Run should have events");
  const activityEvents = events.filter((e) => e.type === "run.state_changed" || e.type === "agent.message");
  assert.ok(activityEvents.length > 0, "Run should have activity events");
  // Mission mode runs do not seal evidence bundles (that is for human review flow)
  // Verify the assignment completed
  const updatedAssignment = store.getAssignment(assignment.assignment_id);
  assert.equal(updatedAssignment.state, "completed");
  const reviewReadyRun = await orchestrator.finalizeMission({
    taskId: task.task_id,
    runId: run.run_id,
  });
  assert.equal(reviewReadyRun.state, "review_ready");
  assert.equal(store.getTask(task.task_id).state, "review_ready");
  const decision = store.createAuditDecision({
    run_id: reviewReadyRun.run_id,
    decision: "accepted",
    task_id: task.task_id,
    task_revision: task.revision,
    finding_ids: [],
  });
  assert.equal(decision.decision, "accepted");
  assert.equal(store.getTask(task.task_id).state, "accepted");
  store.close();
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// selectAttachment - reusable behavior
// ---------------------------------------------------------------------------

test("selectAttachment picks greatest valid timestamp", () => {
  const repo = "/tmp/test-repo";
  const older = { repository_root: repo, surface: "codex-cli", timestamp: "2024-01-01T00:00:00.000Z" };
  const newer = { repository_root: repo, surface: "editor", timestamp: "2024-06-15T00:00:00.000Z" };
  const result = selectAttachment([older, newer], repo);
  assert.equal(result.surface, "editor");
  assert.equal(result.timestamp, "2024-06-15T00:00:00.000Z");
});

test("selectAttachment ignores malformed records", () => {
  const repo = "/tmp/test-repo";
  const result = selectAttachment([
    null,
    { surface: "no-repo" },
    { repository_root: repo, surface: "terminal", timestamp: "2024-01-01T00:00:00.000Z" },
  ], repo);
  assert.equal(result.surface, "terminal");
});

test("selectAttachment returns null when no match", () => {
  const result = selectAttachment([{ repository_root: "/other", surface: "editor", timestamp: "2024-01-01T00:00:00.000Z" }], "/tmp/repo");
  assert.equal(result, null);
});

test("selectAttachment ignores invalid timestamp", () => {
  const repo = "/tmp/test-repo";
  const result = selectAttachment([
    { repository_root: repo, surface: "terminal", timestamp: "not-a-date" },
    { repository_root: repo, surface: "editor", timestamp: "2024-06-15T00:00:00.000Z" },
  ], repo);
  assert.equal(result.surface, "editor");
});

// ---------------------------------------------------------------------------
// Attachment surface propagation through workflow builders
// ---------------------------------------------------------------------------

test("buildExecutionPlanInputFromWorkflow propagates coordinatorSurface", () => {
  const raw = {
    version: 1,
    steps: [{ id: "s1", executor: "coordinator" }],
  };
  const workflow = normalizeWorkflowManifest(raw);
  const plan = buildExecutionPlanInputFromWorkflow({ workflow, coordinatorSurface: "codex-desktop" });
  assert.equal(plan.coordinator_surface, "codex-desktop");
});

test("buildExecutionPlanInputFromWorkflow defaults to terminal", () => {
  const raw = {
    version: 1,
    steps: [{ id: "s1", executor: "coordinator" }],
  };
  const workflow = normalizeWorkflowManifest(raw);
  const plan = buildExecutionPlanInputFromWorkflow({ workflow });
  assert.equal(plan.coordinator_surface, "terminal");
});

test("coordinatorSessionInput propagates surface", () => {
  const input = coordinatorSessionInput("editor");
  assert.equal(input.surface, "editor");
});

test("coordinatorSessionInput defaults to terminal", () => {
  const input = coordinatorSessionInput();
  assert.equal(input.surface, "terminal");
});

// ---------------------------------------------------------------------------
// executeWorkflowScheduler - behavioral tests
// ---------------------------------------------------------------------------

test("executeWorkflowScheduler handles coordinator-only steps", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  const steps = [
    { id: "a", executor: "coordinator", depends_on: [], role: "Coordinator", responsibility: "Plan", writes: false, workspace_policy: "mission", timeout_seconds: null, runtime: null, provider: null, model: null },
    { id: "b", executor: "coordinator", depends_on: ["a"], role: "Coordinator", responsibility: "Review", writes: false, workspace_policy: "mission", timeout_seconds: null, runtime: null, provider: null, model: null },
  ];
  const result = await executeWorkflowScheduler({
    api: null, taskId: "test", sortedSteps: steps,
    managedSessionIds: new Map(), coordinatorSessionId: "ses",
    limits: { concurrency: 1 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, false);
  assert.equal(result.terminalRunId, null);
  assert.deepEqual(result.results.map(r => r.result), ["completed", "completed"]);
});

test("executeWorkflowScheduler respects concurrency limit and measures peak", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  let activeCount = 0;
  let peakActive = 0;
  const settled = new Set();
  const fakeApi = (method, path, body) => {
    if (method === "POST" && path.includes("/assignments") && !path.includes("/runs"))
      return Promise.resolve({ assignment_id: `asn_${Date.now()}` });
    if (method === "POST" && path.includes("/runs")) {
      activeCount++;
      peakActive = Math.max(peakActive, activeCount);
      return Promise.resolve({ run: { run_id: `run_${Date.now()}` } });
    }
    if (method === "GET" && path.includes("/runs/")) {
      activeCount--;
      return Promise.resolve({ state: "completed" });
    }
    return Promise.resolve({});
  };
  const steps = [
    { id: "s1", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "Step 1", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "s2", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "Step 2", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "s3", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "Step 3", writes: false, workspace_policy: "mission", timeout_seconds: null },
  ];
  const mids = new Map();
  for (const s of steps) mids.set(s.id, `ses-${s.id}`);
  const result = await executeWorkflowScheduler({
    api: fakeApi, taskId: "test-concurrency", sortedSteps: steps,
    managedSessionIds: mids, coordinatorSessionId: "ses",
    limits: { concurrency: 2 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, false);
  assert.ok(result.terminalRunId);
  assert.ok(peakActive <= 2, `Peak active ${peakActive} exceeded concurrency limit 2`);
  assert.ok(peakActive >= 2, `Peak active ${peakActive} was below expected parallelism 2`);
});

test("executeWorkflowScheduler fan-in proves dependency waits", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  const launchOrder = [];
  const stepRunIds = new Map();
  const fakeApi = (method, path, body) => {
    if (method === "POST" && path.includes("/assignments") && !path.includes("/runs")) {
      const sid = body?.stage_id || "unknown";
      return Promise.resolve({ assignment_id: `asn_${sid}` });
    }
    if (method === "POST" && path.includes("/runs")) {
      const asnId = path.split("/assignments/")[1]?.split("/")[0] || "unknown";
      const sid = asnId.replace("asn_", "");
      launchOrder.push(sid);
      const runId = `run_${sid}`;
      stepRunIds.set(sid, runId);
      return Promise.resolve({ run: { run_id: runId } });
    }
    if (method === "GET" && path.includes("/runs/"))
      return Promise.resolve({ state: "completed" });
    return Promise.resolve({});
  };
  const steps = [
    { id: "a", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "A", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "b", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "B", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "c", executor: "managed", depends_on: ["a", "b"], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "C", writes: false, workspace_policy: "mission", timeout_seconds: null },
  ];
  const mids = new Map();
  for (const s of steps) mids.set(s.id, `ses-${s.id}`);
  const result = await executeWorkflowScheduler({
    api: fakeApi, taskId: "test-fanin2", sortedSteps: steps,
    managedSessionIds: mids, coordinatorSessionId: "ses",
    limits: { concurrency: 3 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, false);
  // a and b must launch before c
  const cIdx = launchOrder.indexOf("c");
  const aIdx = launchOrder.indexOf("a");
  const bIdx = launchOrder.indexOf("b");
  assert.ok(aIdx >= 0 && bIdx >= 0 && cIdx >= 0, "All steps must launch");
  assert.ok(aIdx < cIdx, "a must launch before c");
  assert.ok(bIdx < cIdx, "b must launch before c");
});

test("executeWorkflowScheduler transitive blocking a->b->c", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  const launchedSteps = [];
  const fakeApi = (method, path, body) => {
    if (method === "POST" && path.includes("/assignments") && !path.includes("/runs")) {
      const sid = body?.stage_id || "unknown";
      return Promise.resolve({ assignment_id: `asn_${sid}` });
    }
    if (method === "POST" && path.includes("/runs")) {
      const asnId = path.split("/assignments/")[1]?.split("/")[0] || "unknown";
      const sid = asnId.replace("asn_", "");
      launchedSteps.push(sid);
      return Promise.resolve({ run: { run_id: `run_${sid}` } });
    }
    if (method === "GET" && path.includes("/runs/"))
      return Promise.resolve({ state: "failed" });
    return Promise.resolve({});
  };
  const steps = [
    { id: "a", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "A", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "b", executor: "managed", depends_on: ["a"], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "B", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "c", executor: "managed", depends_on: ["b"], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "C", writes: false, workspace_policy: "mission", timeout_seconds: null },
  ];
  const mids = new Map();
  for (const s of steps) mids.set(s.id, `ses-${s.id}`);
  const result = await executeWorkflowScheduler({
    api: fakeApi, taskId: "test-transitive-chain", sortedSteps: steps,
    managedSessionIds: mids, coordinatorSessionId: "ses",
    limits: { concurrency: 1 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, true);
  assert.equal(result.terminalRunId, null, "Failed workflow must have no terminal run");
  // Only a should have been launched
  assert.deepEqual(launchedSteps, ["a"], "Only step a should be launched");
  // b and c must be explicitly blocked
  const bResult = result.results.find(r => r.stepId === "b");
  const cResult = result.results.find(r => r.stepId === "c");
  assert.equal(bResult.result, "blocked", "b must be explicitly blocked");
  assert.equal(cResult.result, "blocked", "c must be explicitly blocked");
  // a must be failed
  const aResult = result.results.find(r => r.stepId === "a");
  assert.equal(aResult.result, "failed", "a must be failed");
});

test("executeWorkflowScheduler sibling settlement", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  const pollResults = {};
  const stepOrder = [];
  const fakeApi = (method, path, body) => {
    if (method === "POST" && path.includes("/assignments") && !path.includes("/runs")) {
      const sid = body?.stage_id || "unknown";
      return Promise.resolve({ assignment_id: `asn_${sid}` });
    }
    if (method === "POST" && path.includes("/runs")) {
      const asnId = path.split("/assignments/")[1]?.split("/")[0] || "unknown";
      const sid = asnId.replace("asn_", "");
      stepOrder.push(sid);
      pollResults[sid] = "running";
      return Promise.resolve({ run: { run_id: `run_${sid}` } });
    }
    if (method === "GET" && path.includes("/runs/")) {
      const runId = path.split("/runs/")[1];
      const stepId = runId.replace("run_", "");
      // s1 fails, s2 succeeds
      if (stepId === "s1") {
        pollResults[stepId] = "failed";
        return Promise.resolve({ state: "failed" });
      }
      if (stepId === "s2") {
        pollResults[stepId] = "completed";
        return Promise.resolve({ state: "completed" });
      }
      return Promise.resolve({ state: "completed" });
    }
    return Promise.resolve({});
  };
  const steps = [
    { id: "s1", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "S1", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "s2", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "S2", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "s3", executor: "managed", depends_on: ["s2"], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "S3", writes: false, workspace_policy: "mission", timeout_seconds: null },
  ];
  const mids = new Map();
  for (const s of steps) mids.set(s.id, `ses-${s.id}`);
  const result = await executeWorkflowScheduler({
    api: fakeApi, taskId: "test-sibling-settle", sortedSteps: steps,
    managedSessionIds: mids, coordinatorSessionId: "ses",
    limits: { concurrency: 3 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, true, "Workflow should have failure");
  assert.equal(result.terminalRunId, null, "Failed workflow must have no terminal run");
  // Both s1 and s2 must have been launched
  assert.ok(stepOrder.includes("s1"), "s1 must be launched");
  assert.ok(stepOrder.includes("s2"), "s2 must be launched");
  // s2 must be polled to completion (sibling settlement)
  assert.equal(pollResults["s2"], "completed", "s2 must be polled to completion");
  // s3 must be completed (depends on s2 which succeeded)
  const s3Result = result.results.find(r => r.stepId === "s3");
  assert.equal(s3Result.result, "completed", "s3 must complete since s2 succeeded");
  // s1 must be failed
  const s1Result = result.results.find(r => r.stepId === "s1");
  assert.equal(s1Result.result, "failed", "s1 must be failed");
  // s2 must be completed
  const s2Result = result.results.find(r => r.stepId === "s2");
  assert.equal(s2Result.result, "completed", "s2 must be completed");
  // No forbidden descendant launches
  assert.equal(stepOrder.length, 3, "Only 3 steps should be launched (s1, s2, s3)");
});

test("executeWorkflowScheduler late-ready Coordinator steps", async () => {
  const { executeWorkflowScheduler } = await import("../workflow.mjs");
  const fakeApi = (method, path, body) => {
    if (method === "POST" && path.includes("/assignments") && !path.includes("/runs"))
      return Promise.resolve({ assignment_id: `asn_${Date.now()}` });
    if (method === "POST" && path.includes("/runs"))
      return Promise.resolve({ run: { run_id: `run_${Date.now()}` } });
    if (method === "GET" && path.includes("/runs/"))
      return Promise.resolve({ state: "completed" });
    return Promise.resolve({});
  };
  const steps = [
    { id: "impl", executor: "managed", depends_on: [], runtime: "fake", provider: { id: "test", source: "test", billing_channel: "test", ccswitch_app_type: null, provider_config_hash: null }, model: "test", role: "Worker", responsibility: "Implement", writes: false, workspace_policy: "mission", timeout_seconds: null },
    { id: "review", executor: "coordinator", depends_on: ["impl"], role: "Coordinator", responsibility: "Review", writes: false, workspace_policy: "mission", timeout_seconds: null, runtime: null, provider: null, model: null },
  ];
  const mids = new Map();
  mids.set("impl", "ses-impl");
  const result = await executeWorkflowScheduler({
    api: fakeApi, taskId: "test-late-coord", sortedSteps: steps,
    managedSessionIds: mids, coordinatorSessionId: "ses",
    limits: { concurrency: 1 }, info: { repository_root: "/tmp" },
  });
  assert.equal(result.hasFailure, false);
  assert.ok(result.terminalRunId);
});
