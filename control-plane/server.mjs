import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { URL } from "node:url";
import { quickStart } from "./quick-start.mjs";
import { readCcSwitchCatalog } from "./ccswitch.mjs";

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}

export function createControlPlaneServer({
  store,
  orchestrator,
  apiKey,
  providerCatalog = () => readCcSwitchCatalog(),
}) {
  return createServer(async (req, res) => {
    try {
      if (apiKey && req.headers["x-session-api-key"] !== apiKey)
        return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const routedPath =
        url.pathname.replace(/^\/api\/control-plane(?=\/|$)/, "") || "/";
      const parts = routedPath.split("/").filter(Boolean);
      if (parts[0] !== "v1") return json(res, 404, { error: "not_found" });
      if (req.method === "GET" && parts[1] === "health")
        return json(res, 200, {
          status: "ok",
          schema: "cross-agent/control-plane/v1",
        });
      if (
        req.method === "GET" &&
        parts[1] === "ccswitch" &&
        parts[2] === "providers" &&
        parts.length === 3
      )
        return json(res, 200, {
          source: "ccswitch",
          items: providerCatalog(),
        });
      if (req.method === "GET" && parts[1] === "tasks" && parts.length === 2)
        return json(res, 200, { items: store.listTasks() });
      if (
        req.method === "POST" &&
        parts[1] === "quick-start" &&
        parts.length === 2
      )
        return json(
          res,
          202,
          await quickStart({ store, orchestrator, input: await body(req) }),
        );
      if (req.method === "POST" && parts[1] === "tasks" && parts.length === 2)
        return json(res, 201, store.createTask(await body(req)));
      if (req.method === "GET" && parts[1] === "tasks" && parts.length === 3) {
        const task = store.getTask(parts[2]);
        return task
          ? json(res, 200, task)
          : json(res, 404, { error: "task_not_found" });
      }
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "execution-plan"
      ) {
        const plan = store.getExecutionPlan(
          parts[2],
          url.searchParams.get("revision")
            ? Number(url.searchParams.get("revision"))
            : undefined,
        );
        return plan
          ? json(res, 200, plan)
          : json(res, 404, { error: "execution_plan_not_found" });
      }
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "execution-plan"
      )
        return json(
          res,
          201,
          store.createExecutionPlan(parts[2], await body(req)),
        );
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "sessions" &&
        parts.length === 4
      )
        return json(res, 200, { items: store.listSessions(parts[2]) });
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "sessions" &&
        parts.length === 4
      )
        return json(res, 201, store.attachSession(parts[2], await body(req)));
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "sessions" &&
        parts[4] &&
        parts[5] === "heartbeat"
      )
        return json(res, 200, store.heartbeatSession(parts[4]));
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "sessions" &&
        parts[4] &&
        parts[5] === "close"
      )
        return json(res, 200, store.closeSession(parts[4]));
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "assignments" &&
        parts.length === 4
      )
        return json(res, 200, { items: store.listAssignments(parts[2]) });
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "assignments" &&
        parts.length === 4
      )
        return json(
          res,
          201,
          store.createAssignment(parts[2], await body(req)),
        );
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "assignments" &&
        parts[4] &&
        parts[5] === "assign"
      ) {
        const input = await body(req);
        return json(res, 200, store.assignSession(parts[4], input.session_id));
      }
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "assignments" &&
        parts[4] &&
        parts[5] === "runs"
      ) {
        const input = await body(req),
          started = await orchestrator.startAssignment({
            assignmentId: parts[4],
            coordinatorSessionId: input.coordinator_session_id,
            repositoryRoot: input.repository_root,
            runtimeOptions: input.runtime_options,
            executable: input.executable,
          });
        started.completion.catch(() => {});
        return json(res, 202, {
          run: started.run,
          assignment: started.assignment,
        });
      }
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "leases" &&
        parts[4] &&
        parts[5] === "acquire"
      ) {
        const input = await body(req);
        return json(
          res,
          200,
          store.acquireLease(parts[2], parts[4], input.session_id, input),
        );
      }
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "leases" &&
        parts[4] &&
        parts[5] === "release"
      ) {
        const input = await body(req);
        return json(
          res,
          200,
          store.releaseLease(parts[2], parts[4], input.session_id),
        );
      }
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "activity"
      )
        return json(
          res,
          200,
          store.getTaskActivity(
            parts[2],
            Math.min(Number(url.searchParams.get("event_limit")) || 100, 500),
          ),
        );
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "workspace"
      ) {
        const workspace = store.getMissionWorkspace(parts[2]);
        return workspace
          ? json(res, 200, workspace)
          : json(res, 404, { error: "mission_workspace_not_found" });
      }
      if (
        req.method === "GET" &&
        parts[1] === "tasks" &&
        parts[3] === "corrections"
      )
        return json(res, 200, { items: store.listCorrections(parts[2]) });
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "corrections"
      ) {
        const input = await body(req),
          task = store.getTask(parts[2], input.task_revision);
        if (!task) return json(res, 404, { error: "task_not_found" });
        return json(
          res,
          201,
          store.createCorrectionDelta({
            ...input,
            task_id: task.task_id,
            task_revision: task.revision,
          }),
        );
      }
      if (req.method === "GET" && parts[1] === "runs" && parts.length === 2)
        return json(res, 200, { items: store.listRuns() });
      if (
        req.method === "POST" &&
        parts[1] === "tasks" &&
        parts[3] === "runs"
      ) {
        const input = await body(req),
          task = store.getTask(parts[2], input.task_revision);
        if (!task) return json(res, 404, { error: "task_not_found" });
        const started = await orchestrator.startTask({
          taskId: task.task_id,
          taskRevision: task.revision,
          repositoryRoot: input.repository_root,
          runtimeId: input.runtime_id ?? task.execution.preferred_runtime,
          prompt: input.prompt,
          runtimeOptions: input.runtime_options,
          requestedModel: input.requested_model,
          executable: input.executable,
          parentRunId: input.parent_run_id,
          correctionDeltaId: input.correction_delta_id,
          resumeSessionId: input.resume_session_id,
        });
        started.completion.catch(() => {});
        return json(res, 202, started.run);
      }
      if (parts[1] === "runs" && parts[2]) {
        const runId = parts[2],
          run = store.getRun(runId);
        if (!run) return json(res, 404, { error: "run_not_found" });
        if (req.method === "GET" && parts.length === 3) {
          const bundle = store.getBundle(runId);
          return json(res, 200, {
            ...run,
            events: store.listEvents(runId),
            artifacts: store.listArtifacts(runId),
            verification: store.listVerification(runId),
            bundle,
            bundle_integrity: bundle ? store.verifyBundle(runId) : null,
            decisions: store.listDecisions(runId),
          });
        }
        if (req.method === "GET" && parts[3] === "events")
          return json(res, 200, { items: store.listEvents(runId) });
        if (req.method === "GET" && parts[3] === "bundle") {
          const bundle = store.getBundle(runId);
          return bundle
            ? json(res, 200, bundle)
            : json(res, 404, { error: "bundle_not_found" });
        }
        if (req.method === "POST" && parts[3] === "cancel") {
          await orchestrator.cancel(runId);
          return json(res, 202, store.getRun(runId));
        }
        if (req.method === "POST" && parts[3] === "audit")
          return json(
            res,
            201,
            store.createAuditDecision({ ...(await body(req)), run_id: runId }),
          );
        if (req.method === "GET" && parts[3] === "artifacts" && parts[4]) {
          const path = store.getArtifactPath(runId, parts[4]);
          if (!path) return json(res, 404, { error: "artifact_not_found" });
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return createReadStream(path).pipe(res);
        }
      }
      if (req.method === "POST" && parts[1] === "rebuild-index")
        return json(res, 200, store.rebuildIndex());
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  });
}
