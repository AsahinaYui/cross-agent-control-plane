import { basename } from "node:path";
import { inspectRepository } from "./worktree.mjs";

const RUNTIMES = new Set(["fake", "codex-cli", "claude-cli"]);

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function titleFromPrompt(prompt) {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim()) ?? prompt;
  return firstLine.trim().slice(0, 96);
}

export async function quickStart({ store, orchestrator, input }) {
  const repositoryRoot = requireText(input.repository_root, "repository_root");
  const prompt = requireText(input.prompt, "prompt");
  const runtimeId = input.runtime_id ?? "codex-cli";
  if (!RUNTIMES.has(runtimeId))
    throw new Error(`Unknown runtime: ${runtimeId}`);

  const repository = await inspectRepository(repositoryRoot);
  const requestedModel =
    typeof input.requested_model === "string" && input.requested_model.trim()
      ? input.requested_model.trim()
      : undefined;
  const task = store.createTask({
    title: titleFromPrompt(prompt),
    goal: prompt,
    source: {
      repository_id: basename(repository.repository_root),
      base_commit: repository.head,
    },
    scope: { allow: ["**/*"], deny: [] },
    acceptance: [
      {
        criterion_id: "requested_outcome",
        statement: "Complete the requested task and report the result.",
      },
    ],
    verification: { gates: [] },
    guardrails: {
      irreversible_actions: {
        commit: "human_required",
        merge: "human_required",
        push: "human_required",
        publish: "human_required",
        discard: "human_required",
      },
    },
    execution: {
      preferred_runtime: runtimeId,
      required_capabilities: ["structured_events"],
      ...(requestedModel ? { expected_model: requestedModel } : {}),
      budget: { timeout_seconds: 600 },
    },
    metadata: { task_class: "software-change", labels: ["quick-start"] },
  });
  const started = await orchestrator.startTask({
    taskId: task.task_id,
    taskRevision: task.revision,
    repositoryRoot: repository.repository_root,
    runtimeId,
    prompt,
    runtimeOptions: input.runtime_options,
    requestedModel,
    executable: input.executable,
  });
  started.completion.catch(() => {});
  return {
    task: store.getTask(task.task_id, task.revision),
    run: started.run,
    repository: {
      root: repository.repository_root,
      head: repository.head,
      had_uncommitted_changes: !repository.clean,
    },
  };
}
