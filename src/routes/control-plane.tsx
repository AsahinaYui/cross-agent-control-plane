/* eslint-disable i18next/no-literal-string */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ControlPlaneService } from "#/api/control-plane-service/control-plane-service.api";

const badge = (state: string) =>
  state === "review_ready" || state === "accepted"
    ? "bg-green-500/15 text-green-400"
    : state === "failed" || state === "blocked"
      ? "bg-red-500/15 text-red-400"
      : "bg-blue-500/15 text-blue-300";
function RunDetail({ runId }: { runId: string }) {
  const run = useQuery({
    queryKey: ["control-plane", "run", runId],
    queryFn: () => ControlPlaneService.getRun(runId),
    refetchInterval: 2000,
  });
  if (run.isLoading)
    return (
      <p className="p-6 text-sm text-neutral-400">Loading run evidence?</p>
    );
  if (run.isError || !run.data)
    return (
      <p className="p-6 text-sm text-red-400">Control Plane is unavailable.</p>
    );
  const data = run.data;
  return (
    <div className="p-6 space-y-5">
      <Link className="text-sm text-blue-400" to="/control-plane">
        ? All runs
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Run evidence</h1>
        <p className="font-mono text-xs text-neutral-400">{data.run_id}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="State" value={data.state} />
        <Metric label="Runtime" value={data.runtime_id} />
        <Metric
          label="Requested model"
          value={data.context.model_identity?.requested_model ?? "default"}
        />
        <Metric
          label="Observed model"
          value={data.bundle?.runtime.observed_model ?? "pending"}
        />
        <Metric label="Events" value={String(data.events.length)} />
        <Metric
          label="Bundle"
          value={
            data.bundle_integrity === true
              ? "verified"
              : data.bundle_integrity === false
                ? "tampered"
                : "pending"
          }
        />
      </div>
      {data.context.correction_delta_id ? (
        <Section title="Correction lineage">
          <Row
            left={data.context.correction_delta_id}
            right={`parent ${data.context.parent_run_id ?? "unknown"}`}
          />
        </Section>
      ) : null}
      <Section title="Verification">
        {data.verification.length ? (
          data.verification.map((gate) => (
            <Row
              key={gate.gate_id}
              left={gate.gate_id}
              right={`${gate.status}${gate.observed_tests === undefined ? "" : ` ? ${gate.observed_tests} tests`}`}
            />
          ))
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Evidence artifacts">
        {data.artifacts.length ? (
          data.artifacts.map((artifact) => (
            <Row
              key={artifact.artifact_id}
              left={artifact.kind}
              right={`${artifact.bytes} bytes ? ${artifact.sha256.slice(0, 18)}?`}
            />
          ))
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Event timeline">
        {data.events.map((event) => (
          <Row
            key={event.event_id}
            left={`${event.sequence}. ${event.summary}`}
            right={`${event.actor.role} ? ${event.type}`}
          />
        ))}
      </Section>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800">
      <h2 className="border-b border-neutral-800 bg-neutral-900/50 px-4 py-3 font-medium">
        {title}
      </h2>
      <div className="divide-y divide-neutral-800">{children}</div>
    </section>
  );
}
function Row({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span>{left}</span>
      <span className="text-right text-neutral-400">{right}</span>
    </div>
  );
}
function Empty() {
  return (
    <p className="px-4 py-5 text-sm text-neutral-500">No evidence recorded.</p>
  );
}

export default function ControlPlaneRoute() {
  const { runId } = useParams();
  const tasks = useQuery({
    queryKey: ["control-plane", "tasks"],
    queryFn: ControlPlaneService.listTasks,
    refetchInterval: 3000,
  });
  const runs = useQuery({
    queryKey: ["control-plane", "runs"],
    queryFn: ControlPlaneService.listRuns,
    refetchInterval: 2000,
  });
  if (runId) return <RunDetail runId={runId} />;
  const unavailable = tasks.isError || runs.isError;
  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Cross-Agent Control Plane</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Read-only execution history, verification gates, and immutable
          evidence.
        </p>
      </div>
      {unavailable ? (
        <div className="rounded-xl border border-amber-700/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          The local Control Plane service is unavailable. Start the full Agent
          Canvas stack.
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Tasks" value={String(tasks.data?.length ?? 0)} />
        <Metric label="Runs" value={String(runs.data?.length ?? 0)} />
        <Metric
          label="Review ready"
          value={String(
            runs.data?.filter((run) => run.state === "review_ready").length ??
              0,
          )}
        />
      </div>
      <Section title="Recent runs">
        {runs.data?.length ? (
          runs.data.map((run) => (
            <Link
              key={run.run_id}
              to={`/control-plane/${run.run_id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-neutral-900/60"
            >
              <span>
                <span className="font-mono text-xs">{run.run_id}</span>
                <span className="ml-3 text-neutral-400">{run.runtime_id}</span>
              </span>
              <span
                className={`rounded-full px-2 py-1 text-xs ${badge(run.state)}`}
              >
                {run.state}
              </span>
            </Link>
          ))
        ) : (
          <Empty />
        )}
      </Section>
      <Section title="Task specifications">
        {tasks.data?.length ? (
          tasks.data.map((task) => (
            <Row
              key={`${task.task_id}:${task.revision}`}
              left={task.title}
              right={`${task.state} ? rev ${task.revision}`}
            />
          ))
        ) : (
          <Empty />
        )}
      </Section>
    </div>
  );
}
