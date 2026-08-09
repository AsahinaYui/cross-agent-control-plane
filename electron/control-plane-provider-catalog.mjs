import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  defaultCcSwitchDbPath,
  readCcSwitchCatalog,
  readCcSwitchLiveTakeovers,
} from "../control-plane/ccswitch.mjs";

const unique = (values) => [
  ...new Set(
    values.filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
  ),
];

function commandAvailable(command) {
  const result = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { windowsHide: true, stdio: "ignore", timeout: 3000 },
  );
  return result.status === 0;
}

export function parseCodexModelCache(raw) {
  try {
    const parsed = JSON.parse(raw);
    return unique(
      (parsed.models ?? [])
        .filter((model) => model?.visibility !== "hide")
        .map((model) => model?.slug),
    );
  } catch {
    return [];
  }
}

export async function buildProviderCatalog({
  userHome = homedir(),
  dbPath = defaultCcSwitchDbPath(userHome),
  hasCommand = commandAvailable,
  readCatalog = readCcSwitchCatalog,
  readLiveTakeovers = readCcSwitchLiveTakeovers,
} = {}) {
  const codexAvailable = hasCommand("codex");
  const claudeAvailable = hasCommand("claude");
  let codexModels = [];
  try {
    codexModels = parseCodexModelCache(
      await readFile(join(userHome, ".codex", "models_cache.json"), "utf8"),
    );
  } catch {
    // ccSwitch model catalogs remain authoritative when the cache is absent.
  }

  const runtimeAvailability = {
    "codex-cli": codexAvailable,
    "claude-cli": claudeAvailable,
  };
  const providers = readCatalog({ dbPath }).map((provider) => {
    const models =
      provider.appType === "codex" &&
      (provider.id === "codex-official" ||
        /openai official/i.test(provider.label))
        ? unique([...provider.models, ...codexModels])
        : provider.models;
    const runtimeAvailable = provider.runtimeIds.some(
      (runtimeId) => runtimeAvailability[runtimeId],
    );
    return {
      ...provider,
      available: provider.configured && runtimeAvailable,
      connected:
        provider.configured && provider.credentialReady && runtimeAvailable,
      channel: "external-api",
      models,
      hint: [
        `ccSwitch ${provider.appType}`,
        provider.current ? "当前路线" : "已保存路线",
        provider.effectiveModel
          ? `默认 ${provider.effectiveModel}`
          : `${models.length} 个模型`,
      ].join(" · "),
    };
  });

  return {
    source: "ccswitch",
    liveTakeovers: readLiveTakeovers({ dbPath }),
    runtimes: [
      {
        id: "codex-cli",
        label: "Codex CLI",
        available: codexAvailable,
        appTypes: ["codex"],
        hint: codexAvailable
          ? "可创建独立 Codex CLI 进程"
          : "未检测到 Codex CLI",
      },
      {
        id: "claude-cli",
        label: "Claude Code CLI",
        available: claudeAvailable,
        appTypes: ["claude"],
        hint: claudeAvailable
          ? "可创建独立 Claude Code CLI 进程"
          : "未检测到 Claude Code CLI",
      },
    ],
    providers,
  };
}
