#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createControlPlaneServer } from "./server.mjs";
import { ControlPlaneOrchestrator } from "./orchestrator.mjs";
import { ControlPlaneStore } from "./store.mjs";
import { CcSwitchProviderResolver } from "./ccswitch.mjs";
import {
  parseWorkflowManifestText,
  topologicalSort,
  resolveWorkspacePolicy,
  buildTaskInputFromWorkflow,
  buildExecutionPlanInputFromWorkflow,
} from "./workflow.mjs";
import { inspectRepository } from "./worktree.mjs";
import { makeId, nowIso } from "./protocol.mjs";

const CAP_DIR = process.env.CAP_DIR || join(homedir(), ".openhands", "cap");
const DEFAULT_PORT = 4899;
const CTL = `http://127.0.0.1:${DEFAULT_PORT}`;

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Daemon management
// ---------------------------------------------------------------------------

function statePath() {
  return join(CAP_DIR, "state");
}

function isRunning() {
  try {
    const raw = readFileSync(join(CAP_DIR, "daemon.pid"), "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid)) {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    /* not running */
  }
  return false;
}

function writePid() {
  ensureDir(CAP_DIR);
  writeFileSync(join(CAP_DIR, "daemon.pid"), String(process.pid), "utf8");
}

async function startDaemon(overlay) {
  if (isRunning()) {
    console.error("Control plane daemon is already running.");
    return;
  }
  writePid();
  const store = new ControlPlaneStore(statePath());
  const providerResolver = new CcSwitchProviderResolver();
  const orchestrator = new ControlPlaneOrchestrator({
    store,
    worktreesRoot: join(CAP_DIR, "worktrees"),
    providerResolver,
  });
  const server = createControlPlaneServer({
    store,
    orchestrator,
    providerCatalog: () => providerResolver.catalog(),
  });
  await new Promise((resolve) => server.listen(DEFAULT_PORT, resolve));
  console.error(`Control plane daemon listening on http://127.0.0.1:${DEFAULT_PORT}`);
  if (overlay) {
    console.error("Overlay mode requested but not yet implemented in P0 CLI.");
  }
  // Keep alive
  process.on("SIGINT", () => {
    store.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    store.close();
    process.exit(0);
  });
  // Stay resident
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const url = new URL(path, CTL);
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function pollTaskCompletion(taskId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api("GET", `/api/control-plane/v1/tasks/${taskId}`);
    if (["review_ready", "accepted", "rejected", "failed", "canceled", "blocked", "changes_requested"].includes(task.state)) {
      return task;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`);
}

async function pollRunCompletion(runId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set([
    "completed",
    "review_ready",
    "failed",
    "blocked",
    "canceled",
    "interrupted",
  ]);
  while (Date.now() < deadline) {
    const run = await api("GET", `/api/control-plane/v1/runs/${runId}`);
    if (terminal.has(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdUp(args) {
  const overlay = args.includes("--overlay");
  if (isRunning()) {
    console.log(`Control plane daemon is already running at ${CTL}`);
    return;
  }
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "__daemon", ...(overlay ? ["--overlay"] : [])],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await api("GET", "/api/control-plane/v1/health");
      console.log(`Control plane daemon listening at ${CTL}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Control plane daemon did not become healthy within 10 seconds");
}

async function cmdAttach(args) {
  const repository = args[0] || process.cwd();
  const surface = args.includes("--surface") ? args[args.indexOf("--surface") + 1] : "codex-cli";
  const info = await inspectRepository(resolve(repository));
  const attachment = {
    repository_root: info.repository_root,
    head: info.head,
    surface,
    timestamp: nowIso(),
  };
  ensureDir(join(CAP_DIR, "attachments"));
  const id = makeId("att");
  writeFileSync(
    join(CAP_DIR, "attachments", `${id}.json`),
    JSON.stringify(attachment, null, 2) + "\n",
    "utf8",
  );
  console.log(JSON.stringify({ id, ...attachment }, null, 2));
}

async function cmdRun(args) {
  const workflowIndex = args.indexOf("--workflow");
  if (workflowIndex === -1) {
    throw new Error("--workflow <file> is required");
  }
  const workflowPath = resolve(args[workflowIndex + 1]);
  if (!existsSync(workflowPath)) throw new Error(`Workflow file not found: ${workflowPath}`);
  const goal = args.slice(workflowIndex + 2).join(" ") || "Run workflow";
  const raw = readFileSync(workflowPath, "utf8");
  const workflow = parseWorkflowManifestText(raw, workflowPath);
  const repository = resolve(process.cwd());
  const info = await inspectRepository(repository);
  const taskInput = buildTaskInputFromWorkflow({
    workflow,
    goal,
    repositoryRoot: info.repository_root,
    baseCommit: info.head,
  });
  const task = await api("POST", "/api/control-plane/v1/tasks", taskInput);
  const planInput = buildExecutionPlanInputFromWorkflow({
    workflow,
    coordinatorSurface: "codex-cli",
  });
  await api(
    "POST",
    `/api/control-plane/v1/tasks/${task.task_id}/execution-plan`,
    planInput,
  );
  // Create coordinator session and register it
  const coordinatorSession = await api(
    "POST",
    `/api/control-plane/v1/tasks/${task.task_id}/sessions`,
    {
      profile_id: "current-session-coordinator",
      runtime_id: "current-session",
      provider_id: "surface-owned",
      model_id: "surface-owned",
      billing_channel: "surface-owned",
      surface: "codex-cli",
      role: "Coordinator",
    },
  );
  // Acquire coordinator lease
  await api(
    "POST",
    `/api/control-plane/v1/tasks/${task.task_id}/leases/coordinator/acquire`,
    {
      kind: "coordinator",
      session_id: coordinatorSession.session_id,
      ttl_seconds: 86400,
    },
  );
  // Create sessions for each managed step
  const sorted = topologicalSort(workflow.steps);
  const managedSessionIds = new Map();
  for (const step of sorted) {
    if (step.executor === "managed") {
      const session = await api(
        "POST",
        `/api/control-plane/v1/tasks/${task.task_id}/sessions`,
        {
          profile_id: `wf-${step.id}`,
          runtime_id: step.runtime,
          provider_id: step.provider.id,
          model_id: step.model,
          billing_channel: step.provider.billing_channel,
          provider_source: step.provider.source,
          ccswitch_app_type: step.provider.ccswitch_app_type,
          provider_config_hash: step.provider.provider_config_hash,
          surface: "managed-control-plane",
          role: step.role,
        },
      );
      managedSessionIds.set(step.id, session.session_id);
    }
  }
  // Create assignments for each step - assign managed sessions immediately
  let lastCompletedRunId = null;
  for (const step of sorted) {
    const assignmentInput = {
      stage_id: step.id,
      role: step.role,
      prompt: step.responsibility,
      write_intent: step.writes,
      depends_on: step.depends_on,
      workspace_policy: step.workspace_policy,
      timeout_seconds: step.timeout_seconds,
      executor_kind: step.executor === "coordinator" ? "coordinator" : "managed",
    };
    if (step.executor === "managed") {
      const sessionId = managedSessionIds.get(step.id);
      assignmentInput.session_id = sessionId;
      assignmentInput.profile = {
        profile_id: `wf-${step.id}`,
        runtime_id: step.runtime,
        provider_id: step.provider.id,
        model_id: step.model,
        billing_channel: step.provider.billing_channel,
        provider_source: step.provider.source,
        ccswitch_app_type: step.provider.ccswitch_app_type,
        provider_config_hash: step.provider.provider_config_hash,
      };
    } else {
      assignmentInput.profile = null;
    }
    const assignment = await api(
      "POST",
      `/api/control-plane/v1/tasks/${task.task_id}/assignments`,
      assignmentInput,
    );
    if (step.executor === "managed") {
      // Start a managed run via the assignments/runs endpoint with coordinator_session_id
      const started = await api(
        "POST",
        `/api/control-plane/v1/tasks/${task.task_id}/assignments/${assignment.assignment_id}/runs`,
        {
          coordinator_session_id: coordinatorSession.session_id,
          repository_root: info.repository_root,
          runtime_options: {
            mode: "success",
            provider: step.provider.source,
          },
        },
      );
      const completed = await pollRunCompletion(started.run.run_id);
      if (!["completed", "review_ready"].includes(completed.state)) {
        throw new Error(
          `Workflow step ${step.id} ended in ${completed.state}`,
        );
      }
      lastCompletedRunId = completed.run_id;
    }
  }
  if (lastCompletedRunId) {
    await api(
      "POST",
      `/api/control-plane/v1/tasks/${task.task_id}/finalize`,
      { run_id: lastCompletedRunId },
    );
  }
  const completedTask = await api(
    "GET",
    `/api/control-plane/v1/tasks/${task.task_id}`,
  );
  console.log(JSON.stringify({
    task_id: task.task_id,
    coordinator_session_id: coordinatorSession.session_id,
    state: completedTask.state,
  }, null, 2));
}
async function cmdStatus(args) {
  const taskId = args[0];
  if (taskId) {
    const task = await api("GET", `/api/control-plane/v1/tasks/${taskId}`);
    const runs = await api("GET", `/api/control-plane/v1/runs`);
    const taskRuns = runs.items.filter((r) => r.task_id === taskId);
    console.log(JSON.stringify({ task, runs: taskRuns }, null, 2));
  } else {
    const tasks = await api("GET", `/api/control-plane/v1/tasks`);
    console.log(JSON.stringify(tasks, null, 2));
  }
}

async function cmdLogs(args) {
  const target = args[0];
  const follow = args.includes("--follow");
  if (target) {
    // Try as run ID first
    try {
      const run = await api("GET", `/api/control-plane/v1/runs/${target}`);
      if (run.events) {
        for (const event of run.events) {
          console.log(`${event.occurred_at} [${event.type}] ${event.summary}`);
        }
        if (follow) {
          // Poll for new events
          let lastSeq = run.events.length;
          while (true) {
            await new Promise((r) => setTimeout(r, 2000));
            const refreshed = await api("GET", `/api/control-plane/v1/runs/${target}`);
            const newEvents = (refreshed.events || []).slice(lastSeq);
            for (const event of newEvents) {
              console.log(`${event.occurred_at} [${event.type}] ${event.summary}`);
            }
            lastSeq = refreshed.events?.length || lastSeq;
          }
        }
        return;
      }
    } catch {
      // Not a run ID, try as task ID
    }
    // Try as task ID
    const task = await api("GET", `/api/control-plane/v1/tasks/${target}`);
    const runs = await api("GET", `/api/control-plane/v1/runs`);
    const taskRuns = runs.items.filter((r) => r.task_id === target);
    for (const run of taskRuns) {
      const detail = await api("GET", `/api/control-plane/v1/runs/${run.run_id}`);
      for (const event of detail.events || []) {
        console.log(`${event.occurred_at} [${event.type}] ${event.summary}`);
      }
    }
  } else {
    // Show all recent runs
    const runs = await api("GET", `/api/control-plane/v1/runs`);
    for (const run of runs.items.slice(0, 5)) {
      const detail = await api("GET", `/api/control-plane/v1/runs/${run.run_id}`);
      for (const event of detail.events || []) {
        console.log(`${event.occurred_at} [${event.type}] ${event.summary}`);
      }
    }
  }
}

async function cmdStop(args) {
  const target = args[0];
  if (!target) {
    throw new Error("A task or run ID is required");
  }
  // Try as run ID first
  try {
    const result = await api("POST", `/api/control-plane/v1/runs/${target}/cancel`);
    console.log(JSON.stringify({ canceled: result.run_id, state: result.state }, null, 2));
    return;
  } catch {
    // Not a run, try cancel all runs for task
    const runs = await api("GET", `/api/control-plane/v1/runs`);
    const taskRuns = runs.items.filter((r) => r.task_id === target);
    for (const run of taskRuns) {
      try {
        const result = await api("POST", `/api/control-plane/v1/runs/${run.run_id}/cancel`);
        console.log(JSON.stringify({ canceled: result.run_id, state: result.state }));
      } catch (e) {
        console.error(`Failed to cancel run ${run.run_id}: ${e.message}`);
      }
    }
  }
}

async function cmdDecide(args) {
  const taskId = args[0];
  if (!taskId) throw new Error("Task ID is required");
  const decisionIndex = args.indexOf("--decision");
  const decision = decisionIndex !== -1 ? args[decisionIndex + 1] : null;
  if (!decision || !["accepted", "changes_requested", "rejected"].includes(decision)) {
    throw new Error("--decision must be accepted, changes_requested, or rejected");
  }
  const task = await api("GET", `/api/control-plane/v1/tasks/${taskId}`);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const runs = await api("GET", `/api/control-plane/v1/runs`);
  const taskRuns = runs.items.filter((r) => r.task_id === taskId);
  // Find the latest review_ready run
  const reviewReadyRun = taskRuns.find((r) => r.state === "review_ready");
  if (!reviewReadyRun) {
    throw new Error(`No review_ready run found for task ${taskId}`);
  }
  const audit = await api("POST", `/api/control-plane/v1/runs/${reviewReadyRun.run_id}/audit`, {
    decision,
    task_id: taskId,
    task_revision: task.revision,
    finding_ids: [],
  });
  console.log(JSON.stringify({ decision_id: audit.decision_id, decision, task_id: taskId }, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(`Usage: cap <command> [options]

Commands:
  up [--overlay]              Start the control plane daemon
  attach <repository>         Record current repository and surface identity
  run --workflow <file> <goal>  Submit a versioned workflow
  status [task-id]            Show task status (default: all tasks)
  logs [task-or-run] [--follow]  Show events for a task or run
  stop [task-or-run]          Cancel a task or run
  decide <task-id> --decision accepted|changes_requested|rejected  Persist terminal decision

Environment:
  CAP_DIR  Override state directory (default: ~/.openhands/cap)
`);
    return;
  }
  const cmdMap = {
    up: cmdUp,
    __daemon: (daemonArgs) => startDaemon(daemonArgs.includes("--overlay")),
    attach: cmdAttach,
    run: cmdRun,
    status: cmdStatus,
    logs: cmdLogs,
    stop: cmdStop,
    decide: cmdDecide,
  };
  if (!cmdMap[command]) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
  let localStore = null;
  let localServer = null;
  // For commands that need the daemon (everything except up), check/auto-start
  if (!["up", "__daemon"].includes(command) && !isRunning()) {
    console.error("Control plane daemon is not running. Starting it...");
    const store = new ControlPlaneStore(statePath());
    const providerResolver = new CcSwitchProviderResolver();
    const orchestrator = new ControlPlaneOrchestrator({
      store,
      worktreesRoot: join(CAP_DIR, "worktrees"),
      providerResolver,
    });
    const server = createControlPlaneServer({
      store,
      orchestrator,
      providerCatalog: () => providerResolver.catalog(),
    });
    await new Promise((resolve) => server.listen(DEFAULT_PORT, resolve));
    localStore = store;
    localServer = server;
    writePid();
    console.error(`Daemon started on http://127.0.0.1:${DEFAULT_PORT}`);
  }
  try {
    await cmdMap[command](args.slice(1));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
      localStore.close();
      rmSync(join(CAP_DIR, "daemon.pid"), { force: true });
    }
  }
}

main();
