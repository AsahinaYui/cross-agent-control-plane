import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLease, isProcessAlive, spawnOwnedProcess } from "./process.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
export const RUNTIME_ADAPTER_CONTRACT_VERSION = "cross-agent/runtime-adapter/v1";
const commonCapabilities = {
  structured_events: true,
  graceful_cancel: true,
  send_message: false,
  approvals: false,
  resume_session: true,
  model_observation: true,
  usage_observation: false,
  recovery_probe: true,
};

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const promptTokens =
    value.prompt_tokens ?? value.input_tokens ?? value.promptTokens ?? null;
  const completionTokens =
    value.completion_tokens ??
    value.output_tokens ??
    value.completionTokens ??
    null;
  const totalTokens =
    value.total_tokens ?? value.totalTokens ??
    (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
      ? (Number(promptTokens) || 0) + (Number(completionTokens) || 0)
      : null);
  const costUsd = value.cost_usd ?? value.costUsd ?? null;
  if (
    ![promptTokens, completionTokens, totalTokens, costUsd].some((item) =>
      Number.isFinite(item),
    )
  )
    return null;
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? Number(promptTokens) : null,
    completion_tokens: Number.isFinite(completionTokens)
      ? Number(completionTokens)
      : null,
    total_tokens: Number.isFinite(totalTokens) ? Number(totalTokens) : null,
    cost_usd: Number.isFinite(costUsd) ? Number(costUsd) : null,
  };
}

function assertAdapterContract(adapter) {
  for (const name of ["describe", "start", "wait", "cancel", "recover", "normalize"])
    if (typeof adapter?.[name] !== "function")
      throw new Error(`Runtime adapter contract violation: missing ${name}()`);
  return adapter;
}

class ProcessRuntimeAdapter {
  constructor(runtimeId, adapterVersion, commandBuilder, capabilities = {}) {
    this.runtimeId = runtimeId;
    this.adapterVersion = adapterVersion;
    this.commandBuilder = commandBuilder;
    this.capabilities = { ...commonCapabilities, ...capabilities };
  }
  async describe() {
    return {
      contract_version: RUNTIME_ADAPTER_CONTRACT_VERSION,
      runtime_id: this.runtimeId,
      adapter_version: this.adapterVersion,
      capabilities: this.capabilities,
    };
  }
  normalize(parsed, context = {}) {
    const usage =
      parsed.type === "usage.observed"
        ? normalizeUsage(parsed.data ?? parsed.usage ?? parsed)
        : null;
    if (usage)
      return {
        usage,
        event: {
          type: "usage.observed",
          summary: "Runtime usage observed",
          data: { usage },
        },
      };
    if (parsed.type === "result")
      return {
        terminal: {
          completed:
            parsed.credible_terminal === true && parsed.status === "completed",
        },
      };
    return {
      event: {
        type: parsed.type,
        summary: parsed.data?.message ?? parsed.type,
        data: parsed.data ?? {},
      },
      actual_model:
        parsed.type === "model.observed"
          ? (parsed.data?.runtime?.actual_model ?? null)
          : null,
    };
  }
  async start(input, sinks) {
    const argv = this.commandBuilder(input);
    let stdoutBuffer = "",
      stderrBuffer = "";
    const handle = await spawnOwnedProcess({
      argv,
      cwd: input.worktree_path,
      env: input.env,
      onStdout: (chunk) => {
        sinks.raw?.("stdout", chunk);
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) sinks.line?.("stdout", line);
      },
      onStderr: (chunk) => {
        sinks.raw?.("stderr", chunk);
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) sinks.line?.("stderr", line);
      },
      keepStdinOpen: this.capabilities.send_message,
    });
    return {
      runtime_id: this.runtimeId,
      pid: handle.child.pid,
      completion: handle.completion.then((result) => {
        if (stdoutBuffer) sinks.line?.("stdout", stdoutBuffer);
        if (stderrBuffer) sinks.line?.("stderr", stderrBuffer);
        return result;
      }),
      send: handle.send,
      cancel: handle.cancel,
    };
  }
  async send(handle, message) {
    if (!this.capabilities.send_message)
      throw new Error(`${this.runtimeId} does not support send_message`);
    handle.send(message.content);
  }
  async wait(handle) {
    return handle.completion;
  }
  async cancel(handle) {
    await handle.cancel();
  }
  async recover(leasePath) {
    const lease = readLease(leasePath);
    return {
      lease,
      observed_process: lease?.pid ? isProcessAlive(lease.pid) : false,
      outcome:
        lease?.pid && isProcessAlive(lease.pid) ? "running" : "interrupted",
    };
  }
}

export class FakeRuntimeAdapter extends ProcessRuntimeAdapter {
  constructor() {
    super("fake", "1.0.0", (input) => [
      process.execPath,
      join(here, "fake-runtime.mjs"),
      "--mode",
      input.runtime_options?.mode ?? "success",
    ], { usage_observation: true });
  }
}

export function buildClaudeCommand(input) {
  return [
    input.executable ?? "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    input.write_intent === false ? "plan" : "dontAsk",
    ...(input.requested_model ? ["--model", input.requested_model] : []),
    ...(input.resume_session_id ? ["--resume", input.resume_session_id] : []),
    input.prompt,
  ];
}

export function buildCodexCommand(input) {
  const sandboxMode =
    input.write_intent === false
      ? "read-only"
      : process.platform === "win32"
        ? "danger-full-access"
        : "workspace-write";
  if (input.resume_session_id)
    return [
      input.executable ?? "codex",
      "--sandbox",
      sandboxMode,
      "exec",
      "resume",
      "--json",
      ...(input.requested_model ? ["--model", input.requested_model] : []),
      input.resume_session_id,
      input.prompt,
    ];
  return [
    input.executable ?? "codex",
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    ...(input.requested_model ? ["--model", input.requested_model] : []),
    input.prompt,
  ];
}

function claudeMessageText(parsed) {
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return null;
  return (
    content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n") || null
  );
}

export class ClaudeRuntimeAdapter extends ProcessRuntimeAdapter {
  constructor() {
    super("claude-cli", "1.0.0", buildClaudeCommand, {
      usage_observation: true,
    });
  }
  normalize(parsed) {
    if (parsed.type === "system" && parsed.subtype === "init")
      return {
        actual_model: parsed.model ?? null,
        external_session_id: parsed.session_id ?? null,
        event: {
          type: "model.observed",
          summary: "Claude runtime initialized",
          data: {
            runtime: { actual_model: parsed.model ?? "unknown" },
            provider: { requested_route: "external-cli" },
          },
        },
      };
    if (parsed.type === "assistant") {
      const text = claudeMessageText(parsed);
      return {
        event: {
          type: "agent.message",
          summary: text ?? "Claude assistant message",
          data: { channel: "progress", ...(text ? { text } : {}) },
        },
      };
    }
    if (parsed.type === "result")
      return {
        terminal: {
          completed: parsed.subtype === "success" && parsed.is_error !== true,
        },
      };
    return {};
  }
}
export class CodexRuntimeAdapter extends ProcessRuntimeAdapter {
  constructor() {
    super("codex-cli", "1.0.0", buildCodexCommand, { usage_observation: true });
  }
  normalize(parsed, context = {}) {
    if (parsed.type === "thread.started")
      return {
        actual_model: context.requested_model ?? null,
        external_session_id: parsed.thread_id ?? null,
        event: {
          type: "model.observed",
          summary: "Codex model route bound",
          data: {
            external_session_id: parsed.thread_id ?? null,
            runtime: { actual_model: context.requested_model ?? "unknown" },
            observation_source: "pinned_cli_argument",
          },
        },
      };
    if (
      parsed.type === "session.configured" ||
      parsed.type === "model.observed"
    )
      return {
        actual_model:
          parsed.model ?? parsed.data?.runtime?.actual_model ?? null,
        event: {
          type: "model.observed",
          summary: "Codex runtime configured",
          data: {
            runtime: {
              actual_model:
                parsed.model ?? parsed.data?.runtime?.actual_model ?? "unknown",
            },
            provider: { requested_route: "external-cli" },
          },
        },
      };
    if (
      parsed.type === "item.completed" &&
      parsed.item?.type === "agent_message"
    )
      return {
        event: {
          type: "agent.message",
          summary: parsed.item.text ?? "Codex assistant message",
          data: {
            channel: "progress",
            ...(parsed.item.text ? { text: parsed.item.text } : {}),
          },
        },
      };
    if (parsed.type === "turn.completed")
      return { terminal: { completed: true } };
    if (parsed.type === "error" || parsed.type === "turn.failed")
      return { terminal: { completed: false } };
    return {};
  }
}
export function createRuntimeAdapter(runtimeId) {
  if (runtimeId === "fake") return assertAdapterContract(new FakeRuntimeAdapter());
  if (runtimeId === "claude-cli")
    return assertAdapterContract(new ClaudeRuntimeAdapter());
  if (runtimeId === "codex-cli")
    return assertAdapterContract(new CodexRuntimeAdapter());
  throw new Error(`Unknown runtime adapter: ${runtimeId}`);
}
