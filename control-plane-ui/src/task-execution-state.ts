import type { TaskActivity } from "./types";

const CANCELABLE_RUN_STATES = new Set(["preparing", "running", "waiting"]);
const RUNNING_RUN_STATES = new Set([
  "created",
  "preparing",
  "running",
  "waiting",
  "completed",
  "verifying",
]);
const STOPPED_RUN_STATES = new Set([
  "blocked",
  "failed",
  "canceled",
  "interrupted",
]);

export type TaskExecutionKind =
  | "disabled"
  | "standby"
  | "running"
  | "stopping"
  | "completed"
  | "stopped";

export interface TaskExecutionState {
  kind: TaskExecutionKind;
  label: string;
  activeRunIds: string[];
}

export function taskExecutionState(
  activity: TaskActivity | null,
): TaskExecutionState {
  if (!activity?.execution_plan) {
    return { kind: "disabled", label: "未启用", activeRunIds: [] };
  }

  const assignments = activity.assignments.filter(
    (assignment) =>
      assignment.plan_revision === undefined ||
      assignment.plan_revision === activity.execution_plan?.revision,
  );
  const runIds = new Set(
    assignments
      .map((assignment) => assignment.run_id)
      .filter((runId): runId is string => Boolean(runId)),
  );
  const runs =
    activity.assignments.length === 0
      ? activity.runs
      : activity.runs.filter((run) => runIds.has(run.run_id));
  const activeRunIds = runs
    .filter((run) => CANCELABLE_RUN_STATES.has(run.state))
    .map((run) => run.run_id);
  if (runs.some((run) => run.state === "cancel_requested")) {
    return { kind: "stopping", label: "停止中", activeRunIds: [] };
  }
  if (runs.some((run) => RUNNING_RUN_STATES.has(run.state))) {
    return { kind: "running", label: "运行中", activeRunIds };
  }

  if (
    assignments.length > 0 &&
    assignments.every((assignment) => assignment.state === "completed")
  ) {
    return { kind: "completed", label: "已完成", activeRunIds: [] };
  }

  if (runs.some((run) => STOPPED_RUN_STATES.has(run.state))) {
    return { kind: "stopped", label: "已停止", activeRunIds: [] };
  }

  return { kind: "standby", label: "待命", activeRunIds: [] };
}
