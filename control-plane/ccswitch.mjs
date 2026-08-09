import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const CODEX_ROUTE_KEYS = new Set([
  "disable_response_storage",
  "model",
  "model_auto_compact_token_limit",
  "model_catalog_json",
  "model_context_window",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
]);

const CODEX_PROVIDER_KEYS = new Set([
  "base_url",
  "env_key",
  "name",
  "requires_openai_auth",
  "stream_idle_timeout_ms",
  "stream_max_retries",
  "wire_api",
]);

const CODEX_HEADLESS_FEATURES = `
[features]
apps = false
browser_use = false
computer_use = false
enable_mcp_apps = false
goals = false
hooks = false
image_generation = false
memories = false
multi_agent = false
plugins = false
remote_plugin = false
shell_snapshot = false
workspace_dependencies = false
`;

function normalizedCodexBaseUrl(rawValue) {
  const value = rawValue?.match(/^["']([^"']+)["']$/)?.[1];
  if (!value) return rawValue;
  try {
    const url = new URL(value);
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1";
    return JSON.stringify(url.toString().replace(/\/$/, ""));
  } catch {
    return rawValue;
  }
}

export function isolateCodexRouteConfig(config) {
  if (typeof config !== "string") return "";
  const lines = config.split(/\r?\n/),
    kept = [],
    rootValues = new Map();
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z\d_]*)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, value] = match;
    rootValues.set(key, value.trim());
    if (CODEX_ROUTE_KEYS.has(key)) kept.push(line.trim());
  }
  const textValue = (key) =>
      rootValues.get(key)?.match(/^["']([^"']+)["']$/)?.[1] ?? null,
    rootBaseUrl = rootValues.get("base_url"),
    rootWireApi = rootValues.get("wire_api"),
    providerId =
      textValue("model_provider") ?? (rootBaseUrl ? "ccswitch" : null);
  if (!providerId) return `${kept.join("\n")}\n${CODEX_HEADLESS_FEATURES}`;
  const safeProviderId = /^[A-Za-z_][A-Za-z\d_-]*$/.test(providerId)
    ? providerId
    : "ccswitch";
  const withoutProvider = kept.filter(
    (line) => !/^model_provider\s*=/.test(line),
  );
  withoutProvider.unshift(`model_provider = ${JSON.stringify(safeProviderId)}`);

  let providerLines = [];
  if (rootBaseUrl || rootWireApi) {
    providerLines = [
      `name = ${JSON.stringify(`ccSwitch ${safeProviderId}`)}`,
      ...(rootBaseUrl
        ? [`base_url = ${normalizedCodexBaseUrl(rootBaseUrl)}`]
        : []),
      `wire_api = ${rootWireApi ?? '"responses"'}`,
      "requires_openai_auth = true",
    ];
  } else {
    const header = `[model_providers.${safeProviderId}]`,
      start = lines.findIndex((line) => line.trim() === header);
    if (start >= 0)
      for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) break;
        const key = line.match(/^\s*([A-Za-z_][A-Za-z\d_]*)\s*=/)?.[1];
        if (key && CODEX_PROVIDER_KEYS.has(key))
          providerLines.push(line.trim());
      }
  }
  if (providerLines.length === 0)
    throw new Error(`Codex provider ${safeProviderId} is missing a route`);
  return `${withoutProvider.join("\n")}\n\n[model_providers.${safeProviderId}]\n${providerLines.join("\n")}\n${CODEX_HEADLESS_FEATURES}`;
}

function hasCodexCredential(auth) {
  if (!auth || typeof auth !== "object") return false;
  if (hasText(auth.OPENAI_API_KEY)) return true;
  const tokens =
    auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  return [
    auth.access_token,
    auth.id_token,
    auth.refresh_token,
    tokens.access_token,
    tokens.id_token,
    tokens.refresh_token,
  ].some(hasText);
}

function codexUsesExternalApi(config) {
  if (typeof config !== "string") return false;
  const provider = config.match(
    /^\s*model_provider\s*=\s*["']([^"']+)["']/m,
  )?.[1];
  if (provider && !["openai", "chatgpt"].includes(provider.toLowerCase()))
    return true;
  const baseUrl = config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!baseUrl) return false;
  try {
    return !["api.openai.com", "chatgpt.com", "chat.openai.com"].includes(
      new URL(baseUrl).hostname.toLowerCase(),
    );
  } catch {
    return true;
  }
}

function isolateCodexAuth(auth, config) {
  if (!codexUsesExternalApi(config)) return auth;
  if (!hasText(auth?.OPENAI_API_KEY))
    throw new Error("External Codex route requires an API key");
  return { auth_mode: "apikey", OPENAI_API_KEY: auth.OPENAI_API_KEY };
}

function credentialsReady(appType, settings) {
  if (appType === "claude") {
    const env =
      settings?.env && typeof settings.env === "object" ? settings.env : {};
    return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some(hasText);
  }
  if (appType === "codex") {
    if (codexUsesExternalApi(settings?.config))
      return hasText(settings?.auth?.OPENAI_API_KEY);
    return hasText(settings?.config) && hasCodexCredential(settings?.auth);
  }
  return false;
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
        credentialReady: credentialsReady(row.app_type, settings),
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

export function readCcSwitchLiveTakeovers({
  dbPath = defaultCcSwitchDbPath(),
} = {}) {
  let db;
  try {
    db = openDatabase(dbPath);
    return db
      .prepare(
        `SELECT app_type
           FROM proxy_config
          WHERE live_takeover_active = 1
          ORDER BY app_type`,
      )
      .all()
      .map((row) => row.app_type)
      .filter((appType) => appType === "codex" || appType === "claude");
  } catch {
    // Older ccSwitch databases may not have proxy_config/live takeover state.
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

function copyCodexModelCatalog(config, configDir, sourceRoots) {
  if (typeof config !== "string") return;
  const reference = config.match(
    /^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m,
  )?.[1];
  if (!reference || isAbsolute(reference)) return;
  const target = resolve(configDir, reference),
    pathFromConfig = relative(configDir, target);
  if (
    !pathFromConfig ||
    pathFromConfig.startsWith("..") ||
    pathFromConfig.includes(":")
  )
    throw new Error(`Unsafe Codex model catalog path: ${reference}`);
  const source = sourceRoots
    .map((root) => resolve(root, reference))
    .find((candidate) => existsSync(candidate));
  if (!source) throw new Error(`Codex model catalog not found: ${reference}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function scopedRuntimeRoot(root, scope, id) {
  if (typeof id !== "string" || !id) throw new Error(`${scope} id is required`);
  const scopeRoot = resolve(root, scope),
    target = resolve(scopeRoot, id),
    pathFromScope = relative(scopeRoot, target);
  if (
    !pathFromScope ||
    pathFromScope.startsWith("..") ||
    pathFromScope.includes(":")
  )
    throw new Error(`Refusing runtime config outside ${scope}: ${target}`);
  return target;
}

export class CcSwitchProviderResolver {
  constructor({
    dbPath = defaultCcSwitchDbPath(),
    runtimeConfigRoot,
    codexSourceRoots = unique([
      process.env.CODEX_HOME,
      join(homedir(), ".codex"),
    ]),
  } = {}) {
    this.dbPath = dbPath;
    this.runtimeConfigRoot = runtimeConfigRoot;
    this.codexSourceRoots = codexSourceRoots.map((root) => resolve(root));
  }

  resolve(profile, { runId, sessionId = null }) {
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
      const instanceRoot = this.runtimeConfigRoot
        ? scopedRuntimeRoot(
            this.runtimeConfigRoot,
            sessionId ? "sessions" : "runs",
            sessionId ?? runId,
          )
        : null;
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
        if (instanceRoot) {
          const configDir = join(instanceRoot, "claude");
          mkdirSync(configDir, { recursive: true });
          env.CLAUDE_CONFIG_DIR = configDir;
        }
        return { env, route };
      }
      if (row.app_type === "codex") {
        if (!this.runtimeConfigRoot)
          throw new Error("runtimeConfigRoot is required for Codex isolation");
        const configDir = join(instanceRoot, "codex");
        mkdirSync(configDir, { recursive: true });
        if (settings.auth !== undefined)
          writeRuntimeFile(
            join(configDir, "auth.json"),
            isolateCodexAuth(settings.auth, settings.config),
          );
        if (settings.config !== undefined) {
          const routeConfig = isolateCodexRouteConfig(settings.config);
          writeRuntimeFile(join(configDir, "config.toml"), routeConfig);
          copyCodexModelCatalog(routeConfig, configDir, this.codexSourceRoots);
        }
        return { env: { CODEX_HOME: configDir }, route };
      }
      throw new Error(`Unsupported ccSwitch app type: ${row.app_type}`);
    } finally {
      db.close();
    }
  }

  cleanup(runId) {
    if (!this.runtimeConfigRoot || typeof runId !== "string" || !runId) return;
    const target = scopedRuntimeRoot(this.runtimeConfigRoot, "runs", runId);
    rmSync(target, { recursive: true, force: true });
  }

  cleanupSession(sessionId) {
    if (!this.runtimeConfigRoot || typeof sessionId !== "string" || !sessionId)
      return;
    const target = scopedRuntimeRoot(
      this.runtimeConfigRoot,
      "sessions",
      sessionId,
    );
    rmSync(target, { recursive: true, force: true });
  }
}
