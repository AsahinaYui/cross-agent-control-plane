import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRuntimeAdapter } from "../runtime-adapters.mjs";
import { createControlPlaneServer } from "../server.mjs";
import { ControlPlaneStore } from "../store.mjs";
import { ControlPlaneOrchestrator } from "../orchestrator.mjs";
import { taskInput, tempDir } from "./helpers.mjs";

test("Claude and Codex adapters normalize their own fixtures without changing common fields", async () => {
  const claude = createRuntimeAdapter("claude-cli"),
    codex = createRuntimeAdapter("codex-cli");
  assert.equal((await claude.describe()).capabilities.structured_events, true);
  assert.equal((await codex.describe()).capabilities.structured_events, true);
  const cInit = claude.normalize({
    type: "system",
    subtype: "init",
    model: "claude-fixture",
  });
  assert.equal(cInit.event.type, "model.observed");
  assert.equal(cInit.actual_model, "claude-fixture");
  assert.equal(
    claude.normalize({ type: "result", subtype: "success", is_error: false })
      .terminal.completed,
    true,
  );
  const xMessage = codex.normalize({
    type: "item.completed",
    item: { type: "agent_message", text: "done" },
  });
  assert.deepEqual(xMessage.event.data, { channel: "progress" });
  assert.equal(
    codex.normalize({ type: "turn.completed" }).terminal.completed,
    true,
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
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(state, { recursive: true, force: true });
});
