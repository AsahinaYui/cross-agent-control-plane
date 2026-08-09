import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ControlPlaneOrchestrator } from "../orchestrator.mjs";
import { createRuntimeAdapter } from "../runtime-adapters.mjs";
import { createControlPlaneServer } from "../server.mjs";
import { ControlPlaneStore } from "../store.mjs";
import { createGitFixture, taskInput, tempDir } from "./helpers.mjs";

const workerProfile = {
  profile_id: "deepseek-implementation",
  runtime_id: "fake",
  provider_id: "local-test-provider",
  model_id: "deterministic-fake-v1",
  billing_channel: "external-api",
};

function planInput(modelId = workerProfile.model_id) {
  return {
    fallback_policy: "disabled",
    coordinator_surface: "codex-desktop",
    stages: [
      {
        stage_id: "implementation",
        role: "Implementer",
        responsibility: "Implement the approved task direction",
        write_intent: true,
        profile: { ...workerProfile, model_id: modelId },
      },
    ],
  };
}

test("execution plans pin profiles and assignments retain their plan snapshot", async () => {
  const state = tempDir("mission-plan"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput("a".repeat(40)));
  assert.throws(
    () =>
      store.createExecutionPlan(task.task_id, {
        ...planInput(),
        fallback_policy: "automatic",
      }),
    /fallback_policy must be disabled/,
  );
  const first = store.createExecutionPlan(task.task_id, planInput()),
    session = store.attachSession(task.task_id, {
      ...workerProfile,
      surface: "claude-desktop",
      role: "Implementer",
    }),
    assignment = store.createAssignment(task.task_id, {
      stage_id: "implementation",
      session_id: session.session_id,
      prompt: "Implement the task",
    });
  store.updateSessionExternalId(session.session_id, "external-session-1");
  assert.equal(
    store.getSession(session.session_id).external_session_id,
    "external-session-1",
  );
  assert.throws(
    () =>
      store.updateSessionExternalId(session.session_id, "different-session"),
    /external identity changed/,
  );
  assert.equal(first.revision, 1);
  assert.equal(first.coordinator_surface, "codex-desktop");
  assert.equal(
    first.stages[0].responsibility,
    "Implement the approved task direction",
  );
  assert.equal(assignment.profile.model_id, "deterministic-fake-v1");
  assert.throws(
    () => store.createExecutionPlan(task.task_id, planInput("replacement")),
    /change_reason/,
  );
  const second = store.createExecutionPlan(task.task_id, {
    ...planInput("replacement"),
    change_reason: "Explicit user-approved model change",
  });
  assert.equal(second.revision, 2);
  assert.equal(
    store.getAssignment(assignment.assignment_id).profile.model_id,
    "deterministic-fake-v1",
  );
  assert.throws(
    () =>
      store.createAssignment(task.task_id, {
        plan_revision: second.revision,
        stage_id: "implementation",
        session_id: session.session_id,
        prompt: "Must not silently reuse the old session",
      }),
    /Pinned profile mismatch for model_id/,
  );
  store.close();
  rmSync(state, { recursive: true, force: true });
});

test("assignment runs reuse one mission worktree and enforce leases", async () => {
  const repository = await createGitFixture("mission-shared-worktree"),
    state = tempDir("mission-shared-worktree"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repository.head)),
    starts = [],
    orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
      runtimeAdapterFactory(runtimeId) {
        const adapter = createRuntimeAdapter(runtimeId),
          start = adapter.start.bind(adapter),
          normalize = adapter.normalize.bind(adapter);
        adapter.start = (input, sinks) => {
          starts.push(structuredClone(input));
          return start(input, sinks);
        };
        adapter.normalize = (parsed) => ({
          ...normalize(parsed),
          ...(parsed.type === "model.observed"
            ? { external_session_id: "fake-external-session" }
            : {}),
        });
        return adapter;
      },
    });
  store.createExecutionPlan(task.task_id, planInput());
  const coordinator = store.attachSession(task.task_id, {
      profile_id: "gpt-coordinator",
      runtime_id: "fake",
      provider_id: "official-subscription",
      model_id: "gpt-5.6-sol",
      billing_channel: "subscription",
      surface: "codex-desktop",
      role: "Coordinator",
    }),
    worker = store.attachSession(task.task_id, {
      ...workerProfile,
      surface: "external-api",
      role: "Implementer",
    });
  store.acquireLease(task.task_id, "coordinator", coordinator.session_id, {
    ttl_seconds: 300,
  });
  assert.throws(
    () =>
      store.acquireLease(task.task_id, "coordinator", worker.session_id, {
        ttl_seconds: 300,
      }),
    /lease is held/,
  );
  store.acquireLease(task.task_id, "workspace_write", worker.session_id, {
    assignment_id: "assignment-a",
    ttl_seconds: 300,
  });
  assert.throws(
    () =>
      store.acquireLease(task.task_id, "workspace_write", worker.session_id, {
        assignment_id: "assignment-b",
        ttl_seconds: 300,
      }),
    /held for assignment assignment-a/,
  );
  store.releaseLease(task.task_id, "workspace_write", worker.session_id);

  const firstAssignment = store.createAssignment(task.task_id, {
      stage_id: "implementation",
      session_id: worker.session_id,
      prompt: "First implementation pass",
    }),
    first = await orchestrator.startAssignment({
      assignmentId: firstAssignment.assignment_id,
      coordinatorSessionId: coordinator.session_id,
      repositoryRoot: repository.root,
    }),
    firstRun = await first.completion,
    firstWorkspace = store.getMissionWorkspace(task.task_id);
  assert.equal(firstRun.state, "completed");
  assert.equal(
    store.getAssignment(firstAssignment.assignment_id).state,
    "completed",
  );
  assert.equal(store.getLease(task.task_id, "workspace_write"), null);
  assert.equal(starts[0].resume_session_id, null);
  assert.equal(
    store.getSession(worker.session_id).external_session_id,
    "fake-external-session",
  );

  const secondAssignment = store.createAssignment(task.task_id, {
      stage_id: "implementation",
      session_id: worker.session_id,
    }),
    second = await orchestrator.startAssignment({
      assignmentId: secondAssignment.assignment_id,
      coordinatorSessionId: coordinator.session_id,
      repositoryRoot: repository.root,
    }),
    secondRun = await second.completion;
  assert.equal(starts[1].resume_session_id, "fake-external-session");
  assert.equal(secondRun.state, "completed");
  assert.equal(
    secondRun.worktree_path,
    firstRun.worktree_path,
    "a correction assignment must reuse the mission worktree",
  );
  assert.equal(
    secondAssignment.prompt,
    "Implement the approved task direction",
    "an assignment may inherit the pinned stage responsibility",
  );
  assert.equal(
    store.getMissionWorkspace(task.task_id).worktree_path,
    firstWorkspace.worktree_path,
  );
  const activity = store.getTaskActivity(task.task_id);
  assert.equal(activity.assignments.length, 2);
  assert.equal(activity.handoffs.length, 2);
  assert.equal(activity.runs.length, 2);
  assert.equal(activity.workspace.worktree_path, firstWorkspace.worktree_path);

  const rebuilt = store.rebuildIndex();
  assert.equal(rebuilt.sessions, 2);
  assert.equal(rebuilt.assignments, 2);
  assert.equal(rebuilt.handoffs, 2);
  assert.equal(store.getExecutionPlan(task.task_id).revision, 1);
  assert.equal(store.getMissionWorkspace(task.task_id).task_id, task.task_id);
  store.close();
  rmSync(repository.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("a read-only assignment hands its result to the next stage outside the worktree", async () => {
  const repository = await createGitFixture("mission-handoff"),
    state = tempDir("mission-handoff"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repository.head)),
    starts = [],
    orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
      runtimeAdapterFactory(runtimeId) {
        const adapter = createRuntimeAdapter(runtimeId),
          start = adapter.start.bind(adapter);
        adapter.start = (input, sinks) => {
          starts.push(structuredClone(input));
          return start(input, sinks);
        };
        return adapter;
      },
    }),
    directionProfile = { ...workerProfile, profile_id: "direction" },
    implementationProfile = {
      ...workerProfile,
      profile_id: "implementation",
    };
  store.createExecutionPlan(task.task_id, {
    fallback_policy: "disabled",
    coordinator_surface: "codex-desktop",
    stages: [
      {
        stage_id: "direction",
        role: "Direction",
        responsibility: "Analyze the task and hand off an implementation plan",
        write_intent: false,
        profile: directionProfile,
      },
      {
        stage_id: "implementation",
        role: "Implementation",
        responsibility: "Implement the approved direction",
        write_intent: true,
        profile: implementationProfile,
      },
    ],
  });
  const coordinator = store.attachSession(task.task_id, {
      profile_id: "coordinator",
      runtime_id: "fake",
      provider_id: "coordinator",
      model_id: "deterministic-fake-v1",
      billing_channel: "subscription",
      surface: "codex-desktop",
      role: "Coordinator",
    }),
    directionSession = store.attachSession(task.task_id, {
      ...directionProfile,
      surface: "codex-cli",
      role: "Direction",
    }),
    implementationSession = store.attachSession(task.task_id, {
      ...implementationProfile,
      surface: "claude-cli",
      role: "Implementation",
    });
  store.acquireLease(task.task_id, "coordinator", coordinator.session_id, {
    ttl_seconds: 300,
  });
  const direction = store.createAssignment(task.task_id, {
      stage_id: "direction",
      session_id: directionSession.session_id,
    }),
    first = await orchestrator.startAssignment({
      assignmentId: direction.assignment_id,
      coordinatorSessionId: coordinator.session_id,
      repositoryRoot: repository.root,
    });
  await first.completion;
  const handoff = store.listHandoffs(task.task_id)[0];
  assert.equal(handoff.from_assignment_id, direction.assignment_id);
  assert.equal(handoff.to_stage_id, "implementation");
  assert.match(handoff.content, /Fake worker started/);
  assert.equal(starts[0].write_intent, false);

  const implementation = store.createAssignment(task.task_id, {
      stage_id: "implementation",
      session_id: implementationSession.session_id,
    }),
    second = await orchestrator.startAssignment({
      assignmentId: implementation.assignment_id,
      coordinatorSessionId: coordinator.session_id,
      repositoryRoot: repository.root,
    });
  assert.deepEqual(second.run.context.input_handoff_ids, [handoff.handoff_id]);
  assert.match(starts[1].prompt, new RegExp(handoff.handoff_id));
  assert.match(starts[1].prompt, /Fake worker started/);
  assert.equal(starts[1].write_intent, true);
  await second.completion;

  store.close();
  rmSync(repository.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

test("headless API exposes plan, session, lease, assignment, and activity", async () => {
  const repository = await createGitFixture("mission-http"),
    state = tempDir("mission-http"),
    store = new ControlPlaneStore(state),
    task = store.createTask(taskInput(repository.head)),
    orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    server = createControlPlaneServer({ store, orchestrator });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/tasks/${task.task_id}`,
    request = (path, value) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
  assert.equal((await request("/execution-plan", planInput())).status, 201);
  const coordinator = await (
      await request("/sessions", {
        profile_id: "coordinator",
        runtime_id: "fake",
        provider_id: "official",
        model_id: "gpt-5.6-sol",
        billing_channel: "subscription",
        surface: "openhands",
        role: "Coordinator",
      })
    ).json(),
    worker = await (
      await request("/sessions", {
        ...workerProfile,
        surface: "external-api",
        role: "Implementer",
      })
    ).json();
  assert.equal(
    (
      await request("/leases/coordinator/acquire", {
        session_id: coordinator.session_id,
        ttl_seconds: 300,
      })
    ).status,
    200,
  );
  const assignment = await (
    await request("/assignments", {
      stage_id: "implementation",
      session_id: worker.session_id,
      prompt: "Run through the headless API",
    })
  ).json();
  const started = await (
    await request(`/assignments/${assignment.assignment_id}/runs`, {
      coordinator_session_id: coordinator.session_id,
      repository_root: repository.root,
    })
  ).json();
  assert.equal(
    started.run.context.model_identity.expected_model,
    workerProfile.model_id,
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getAssignment(assignment.assignment_id).state === "completed")
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const activity = await (await fetch(`${base}/activity`)).json();
  assert.equal(activity.execution_plan.fallback_policy, "disabled");
  assert.equal(activity.assignments[0].state, "completed");
  assert.equal(activity.handoffs.length, 1);
  assert.equal(
    (await (await fetch(`${base}/handoffs`)).json()).items.length,
    1,
  );
  assert.equal(activity.workspace.task_id, task.task_id);
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(repository.root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});
