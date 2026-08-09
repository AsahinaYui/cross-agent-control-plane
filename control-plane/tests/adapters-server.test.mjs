import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildClaudeCommand,
  buildCodexCommand,
  createRuntimeAdapter,
} from "../runtime-adapters.mjs";
import { createControlPlaneServer } from "../server.mjs";
import { ControlPlaneStore } from "../store.mjs";
import { ControlPlaneOrchestrator } from "../orchestrator.mjs";
import { createGitFixture, taskInput, tempDir } from "./helpers.mjs";

test("Claude and Codex adapters normalize their own fixtures without changing common fields", async () => {
  const claude = createRuntimeAdapter("claude-cli"),
    codex = createRuntimeAdapter("codex-cli");
  assert.equal((await claude.describe()).capabilities.structured_events, true);
  assert.equal((await codex.describe()).capabilities.structured_events, true);
  assert.equal((await claude.describe()).capabilities.resume_session, true);
  assert.equal((await codex.describe()).capabilities.resume_session, true);
  const cInit = claude.normalize({
    type: "system",
    subtype: "init",
    model: "claude-fixture",
  });
  assert.equal(cInit.event.type, "model.observed");
  assert.equal(cInit.actual_model, "claude-fixture");
  assert.equal(
    claude.normalize({
      type: "system",
      subtype: "init",
      model: "claude-fixture",
      session_id: "claude-session",
    }).external_session_id,
    "claude-session",
  );
  assert.equal(
    claude.normalize({ type: "result", subtype: "success", is_error: false })
      .terminal.completed,
    true,
  );
  const xMessage = codex.normalize({
    type: "item.completed",
    item: { type: "agent_message", text: "done" },
  });
  assert.deepEqual(xMessage.event.data, { channel: "progress", text: "done" });
  assert.equal(
    codex.normalize({ type: "thread.started", thread_id: "codex-session" })
      .external_session_id,
    "codex-session",
  );
  assert.equal(
    codex.normalize(
      { type: "thread.started", thread_id: "codex-session" },
      { requested_model: "deepseek-v4-flash" },
    ).actual_model,
    "deepseek-v4-flash",
  );
  assert.equal(
    codex.normalize({ type: "turn.completed" }).terminal.completed,
    true,
  );
});

test("read-only assignments use runtime-enforced read-only modes", () => {
  const input = {
    prompt: "Inspect and hand off",
    requested_model: "fixed-model",
    write_intent: false,
  };
  const codex = buildCodexCommand(input),
    claude = buildClaudeCommand(input);
  assert.equal(codex.includes("--ask-for-approval"), false);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "plan");
  assert.equal(
    buildCodexCommand({ ...input, write_intent: true })[
      codex.indexOf("--sandbox") + 1
    ],
    process.platform === "win32" ? "danger-full-access" : "workspace-write",
  );
  assert.equal(
    buildClaudeCommand({ ...input, write_intent: true })[
      claude.indexOf("--permission-mode") + 1
    ],
    "dontAsk",
  );
  const resumedCodex = buildCodexCommand({
      ...input,
      resume_session_id: "codex-session",
    }),
    resumedClaude = buildClaudeCommand({
      ...input,
      resume_session_id: "claude-session",
    });
  assert.deepEqual(
    resumedCodex.slice(
      resumedCodex.indexOf("exec"),
      resumedCodex.indexOf("exec") + 2,
    ),
    ["exec", "resume"],
  );
  assert.equal(
    resumedCodex[resumedCodex.indexOf("--sandbox") + 1],
    "read-only",
  );
  assert.equal(
    resumedCodex[resumedCodex.indexOf("codex-session")],
    "codex-session",
  );
  assert.equal(
    resumedClaude[resumedClaude.indexOf("--resume") + 1],
    "claude-session",
  );
});

test("control API honors the shared API key and supports versioned task creation", async () => {
  const state = tempDir("control-plane-http"),
    store = new ControlPlaneStore(state),
    orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    });
  const server = createControlPlaneServer({
    store,
    orchestrator,
    apiKey: "fixture-key",
    providerCatalog: () => [
      {
        key: "claude:fixture",
        id: "fixture",
        appType: "claude",
        configHash: "sha256:fixture",
      },
    ],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(),
    base = `http://127.0.0.1:${address.port}/api/control-plane/v1`;
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const headers = {
    "X-Session-API-Key": "fixture-key",
    "content-type": "application/json",
  };
  const created = await fetch(`${base}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(taskInput("e".repeat(40))),
  });
  assert.equal(created.status, 201);
  const tasks = await (await fetch(`${base}/tasks`, { headers })).json();
  assert.equal(tasks.items.length, 1);
  const providers = await (
    await fetch(`${base}/ccswitch/providers`, { headers })
  ).json();
  assert.equal(providers.source, "ccswitch");
  assert.equal(providers.items[0].id, "fixture");
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(state, { recursive: true, force: true });
});

test("quick start derives task metadata and launches from a repository path", async () => {
  const state = tempDir("control-plane-quick-start"),
    repository = await createGitFixture("quick-start-repo"),
    store = new ControlPlaneStore(state),
    orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(state, "worktrees"),
    }),
    server = createControlPlaneServer({ store, orchestrator });
  writeFileSync(join(repository.root, "LOCAL-NOTES.md"), "uncommitted\n");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(),
    base = `http://127.0.0.1:${address.port}/api/control-plane/v1`,
    response = await fetch(`${base}/quick-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository_root: repository.root,
        prompt: "Fix the loading state\nand summarize the change.",
        runtime_id: "fake",
        runtime_options: { mode: "success" },
      }),
    });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.task.title, "Fix the loading state");
  assert.equal(started.task.source.base_commit, repository.head);
  assert.equal(started.task.execution.preferred_runtime, "fake");
  assert.equal(started.repository.had_uncommitted_changes, true);
  assert.equal(started.run.task_id, started.task.task_id);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await (
      await fetch(`${base}/runs/${started.run.run_id}`)
    ).json();
    if (run.state === "review_ready") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(store.getRun(started.run.run_id).state, "review_ready");
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(state, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});
