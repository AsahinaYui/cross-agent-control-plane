import { describe, expect, it } from "vitest";
import { taskExecutionState } from "./task-execution-state";
import type { TaskActivity } from "./types";

function activity(patch: Partial<TaskActivity> = {}): TaskActivity {
  return {
    task: {
      task_id: "task-1",
      title: "Task",
      goal: "Goal",
      revision: 1,
      state: "ready",
    },
    execution_plan: { revision: 1, stages: [] },
    assignments: [],
    handoffs: [],
    runs: [],
    events: [],
    workspace: null,
    sessions: [],
    ...patch,
  };
}

describe("taskExecutionState", () => {
  it("distinguishes disabled plans from fixed plans waiting to start", () => {
    expect(taskExecutionState(activity({ execution_plan: null })).kind).toBe(
      "disabled",
    );
    expect(taskExecutionState(activity()).kind).toBe("standby");
  });

  it("reports cancelable active runs", () => {
    const state = taskExecutionState(
      activity({
        runs: [
          {
            run_id: "run-1",
            runtime_id: "codex-cli",
            state: "running",
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(state.kind).toBe("running");
    expect(state.activeRunIds).toEqual(["run-1"]);
  });

  it("reports cancellation separately from standby", () => {
    expect(
      taskExecutionState(
        activity({
          runs: [
            {
              run_id: "run-1",
              runtime_id: "codex-cli",
              state: "cancel_requested",
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      ).kind,
    ).toBe("stopping");
  });

  it("reports completed and stopped terminal states", () => {
    expect(
      taskExecutionState(
        activity({
          assignments: [
            {
              assignment_id: "assignment-1",
              stage_id: "stage-1",
              role: "Worker",
              profile: {
                profile_id: "profile-1",
                provider_id: "provider-1",
                model_id: "model-1",
                runtime_id: "codex-cli",
              },
              prompt: "Work",
              state: "completed",
              run_id: "run-1",
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      ).kind,
    ).toBe("completed");
    expect(
      taskExecutionState(
        activity({
          runs: [
            {
              run_id: "run-2",
              runtime_id: "codex-cli",
              state: "canceled",
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      ).kind,
    ).toBe("stopped");
  });

  it("ignores runs from an older execution plan revision", () => {
    expect(
      taskExecutionState(
        activity({
          execution_plan: { revision: 2, stages: [] },
          assignments: [
            {
              assignment_id: "old-assignment",
              plan_revision: 1,
              stage_id: "stage-1",
              role: "Worker",
              profile: {
                profile_id: "profile-1",
                provider_id: "provider-1",
                model_id: "model-1",
                runtime_id: "codex-cli",
              },
              prompt: "Old work",
              state: "failed",
              run_id: "old-run",
              updated_at: new Date().toISOString(),
            },
          ],
          runs: [
            {
              run_id: "old-run",
              runtime_id: "codex-cli",
              state: "failed",
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      ).kind,
    ).toBe("standby");
  });
});
