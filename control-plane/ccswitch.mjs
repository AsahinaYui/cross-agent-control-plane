import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const APP_RUNTIME = Object.freeze({
  claude: "claude-cli",
  codex: "codex-cli",
});

const unique = (values) => [
  ...new Set(
    values.filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
  ),
];

export const defaultCcSwitchDbPath = (userHome = homedir()) =>
  join(userHome, ".cc-switch", "cc-switch.db");

function parseSettings(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function modelFromToml(config) {
  if (typeof config !== "string") return null;
  return config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
}

function modelsFromSettings(appType, settings) {
  const catalog = Array.isArray(settings?.modelCatalog?.models)
    ? settings.modelCatalog.models.map((item) => item?.model)
    : [];
  const env =
    settings?.env && typeof settings.env === "object" ? settings.env : {};
  const envModels = Object.entries(env)
    .filter(([key]) => /(?:^|_)MODEL(?:_NAME)?$/.test(key))
    .map(([, value]) => value);
  const configured =
    appType === "codex"
      ? modelFromToml(settings?.config)
      : appType === "claude"
        ? (env.ANTHROPIC_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL)
        : env.GEMINI_MODEL;
  return {
    models: unique([configured, ...catalog, ...envModels]),
    effectiveModel: typeof configured === "string" ? configured : null,
  };
}

function configHash(row) {
  return `sha256:${createHash("sha256")
    .update(`${row.app_type}\0${row.id}\0${row.settings_config}`)
    .digest("hex")}`;
}

function openDatabase(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function providerRows(db) {
  return db
    .prepare(
      `
    SELECT id, app_type, name, settings_config, is_current, provider_type,
           cost_multiplier, limit_daily_usd, limit_monthly_usd
      FROM providers
     WHERE app_type IN ('claude', 'codex')
     ORDER BY app_type, sort_index, name
  `,
    )
    .all();
}

export function readCcSwitchCatalog({ dbPath = defaultCcSwitchDbPath() } = {}) {
  let db;
  try {
    db = openDatabase(dbPath);
    return providerRows(db).map((row) => {
      const settings = parseSettings(row.settings_config);
      const { models, effectiveModel } = modelsFromSettings(
        row.app_type,
        settings,
      );
      return {
        key: `${row.app_type}:${row.id}`,
        id: row.id,
        appType: row.app_type,
        label: row.name,
        current: row.is_current === 1,
        configured: Object.keys(settings).length > 0,
        runtimeIds: APP_RUNTIME[row.app_type]
          ? [APP_RUNTIME[row.app_type]]
          : [],
        models,
        effectiveModel,
        configHash: configHash(row),
        costMultiplier: row.cost_multiplier ?? "1.0",
        dailyLimitUsd: row.limit_daily_usd ?? null,
        monthlyLimitUsd: row.limit_monthly_usd ?? null,
      };
    });
  } catch (error) {
    if (error?.code === "ERR_INVALID_ARG_TYPE") throw error;
    return [];
  } finally {
    db?.close();
  }
}

function exactProvider(db, appType, providerId) {
  return db
    .prepare(
      `
    SELECT id, app_type, name, settings_config, is_current
      FROM providers
     WHERE app_type=? AND id=?
  `,
    )
    .get(appType, providerId);
}

function writeRuntimeFile(path, value) {
  const content =
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

export class CcSwitchProviderResolver {
  constructor({ dbPath = defaultCcSwitchDbPath(), runtimeConfigRoot } = {}) {
    this.dbPath = dbPath;
    this.runtimeConfigRoot = runtimeConfigRoot;
  }

  resolve(profile, { runId }) {
    if (profile.provider_source !== "ccswitch") return { env: {}, route: null };
    const expectedRuntime = APP_RUNTIME[profile.ccswitch_app_type];
    if (!expectedRuntime || expectedRuntime !== profile.runtime_id)
      throw new Error(
        `ccSwitch ${profile.ccswitch_app_type} route is incompatible with ${profile.runtime_id}`,
      );
    const db = openDatabase(this.dbPath);
    try {
      const row = exactProvider(
        db,
        profile.ccswitch_app_type,
        profile.provider_id,
      );
      if (!row)
        throw new Error(
          `Pinned ccSwitch provider not found: ${profile.ccswitch_app_type}:${profile.provider_id}`,
        );
      const observedHash = configHash(row);
      if (
        profile.provider_config_hash &&
        profile.provider_config_hash !== observedHash
      )
        throw new Error(
          `Pinned ccSwitch provider configuration changed: expected=${profile.provider_config_hash}, actual=${observedHash}`,
        );
      const settings = parseSettings(row.settings_config);
      const route = {
        source: "ccswitch",
        app_type: row.app_type,
        provider_id: row.id,
        provider_name: row.name,
        provider_config_hash: observedHash,
        model_id: profile.model_id,
      };
      if (row.app_type === "claude") {
        const env =
          settings.env && typeof settings.env === "object"
            ? { ...settings.env }
            : {};
        env.ANTHROPIC_MODEL = profile.model_id;
        if (this.runtimeConfigRoot) {
          const configDir = join(this.runtimeConfigRoot, runId, "claude");
          mkdirSync(configDir, { recursive: true });
          env.CLAUDE_CONFIG_DIR = configDir;
        }
        return { env, route };
      }
      if (row.app_type === "codex") {
        if (!this.runtimeConfigRoot)
          throw new Error("runtimeConfigRoot is required for Codex isolation");
        const configDir = join(this.runtimeConfigRoot, runId, "codex");
        mkdirSync(configDir, { recursive: true });
        if (settings.auth !== undefined)
          writeRuntimeFile(join(configDir, "auth.json"), settings.auth);
        if (settings.config !== undefined)
          writeRuntimeFile(join(configDir, "config.toml"), settings.config);
        return { env: { CODEX_HOME: configDir }, route };
      }
      throw new Error(`Unsupported ccSwitch app type: ${row.app_type}`);
    } finally {
      db.close();
    }
  }

  cleanup(runId) {
    if (!this.runtimeConfigRoot || typeof runId !== "string" || !runId) return;
    const root = resolve(this.runtimeConfigRoot),
      target = resolve(root, runId),
      pathFromRoot = relative(root, target);
    if (
      !pathFromRoot ||
      pathFromRoot.startsWith("..") ||
      pathFromRoot.includes(":")
    )
      throw new Error(
        `Refusing to clean runtime config outside its root: ${target}`,
      );
    rmSync(target, { recursive: true, force: true });
  }
}
