import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CcSwitchProviderResolver, readCcSwitchCatalog } from "../ccswitch.mjs";
import { tempDir } from "./helpers.mjs";

function fixtureDatabase(root) {
  const path = join(root, "cc-switch.db"),
    db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      sort_index INTEGER,
      is_current BOOLEAN NOT NULL DEFAULT 0,
      provider_type TEXT,
      cost_multiplier TEXT NOT NULL DEFAULT '1.0',
      limit_daily_usd TEXT,
      limit_monthly_usd TEXT,
      PRIMARY KEY (id, app_type)
    )
  `);
  const insert = db.prepare(
    "INSERT INTO providers VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "deepseek-a",
    "claude",
    "DeepSeek A",
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "secret-a",
        ANTHROPIC_BASE_URL: "https://a.example/v1",
        ANTHROPIC_MODEL: "deepseek-v4-flash",
      },
    }),
    1,
    1,
    null,
    "0.5",
    null,
    null,
  );
  insert.run(
    "deepseek-b",
    "claude",
    "DeepSeek B",
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "secret-b",
        ANTHROPIC_BASE_URL: "https://b.example/v1",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
      },
    }),
    2,
    0,
    null,
    "1.0",
    null,
    null,
  );
  insert.run(
    "codex-route",
    "codex",
    "Codex Route",
    JSON.stringify({
      auth: { OPENAI_API_KEY: "codex-secret" },
      config: 'model_provider = "custom"\nmodel = "gpt-route"\n',
      modelCatalog: { models: [{ model: "gpt-route" }] },
    }),
    1,
    1,
    null,
    "1.0",
    null,
    null,
  );
  db.close();
  return path;
}

test("ccSwitch catalog contains safe route metadata without credentials", () => {
  const root = tempDir("ccswitch-catalog"),
    dbPath = fixtureDatabase(root),
    catalog = readCcSwitchCatalog({ dbPath });
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog[0].models, ["deepseek-v4-flash"]);
  assert.equal(catalog[0].runtimeIds[0], "claude-cli");
  assert.equal(JSON.stringify(catalog).includes("secret-a"), false);
  assert.match(catalog[0].configHash, /^sha256:/);
  rmSync(root, { recursive: true, force: true });
});

test("one runtime type resolves concurrent ccSwitch routes into isolated instances", () => {
  const root = tempDir("ccswitch-resolve"),
    dbPath = fixtureDatabase(root),
    runtimeConfigRoot = join(root, "runtime-configs"),
    resolver = new CcSwitchProviderResolver({ dbPath, runtimeConfigRoot }),
    catalog = readCcSwitchCatalog({ dbPath }),
    routeA = catalog.find((item) => item.id === "deepseek-a"),
    routeB = catalog.find((item) => item.id === "deepseek-b"),
    launchA = resolver.resolve(
      {
        runtime_id: "claude-cli",
        provider_source: "ccswitch",
        ccswitch_app_type: "claude",
        provider_id: routeA.id,
        provider_config_hash: routeA.configHash,
        model_id: "deepseek-v4-flash",
      },
      { runId: "run-a" },
    ),
    launchB = resolver.resolve(
      {
        runtime_id: "claude-cli",
        provider_source: "ccswitch",
        ccswitch_app_type: "claude",
        provider_id: routeB.id,
        provider_config_hash: routeB.configHash,
        model_id: "deepseek-v4-pro",
      },
      { runId: "run-b" },
    );
  assert.equal(launchA.env.ANTHROPIC_BASE_URL, "https://a.example/v1");
  assert.equal(launchB.env.ANTHROPIC_BASE_URL, "https://b.example/v1");
  assert.notEqual(launchA.env.CLAUDE_CONFIG_DIR, launchB.env.CLAUDE_CONFIG_DIR);
  assert.equal(launchA.route.provider_id, "deepseek-a");
  assert.equal(launchB.route.provider_id, "deepseek-b");
  rmSync(root, { recursive: true, force: true });
});

test("Codex routes receive a per-run CODEX_HOME snapshot", () => {
  const root = tempDir("ccswitch-codex"),
    dbPath = fixtureDatabase(root),
    runtimeConfigRoot = join(root, "runtime-configs"),
    resolver = new CcSwitchProviderResolver({ dbPath, runtimeConfigRoot }),
    route = readCcSwitchCatalog({ dbPath }).find(
      (item) => item.id === "codex-route",
    ),
    launch = resolver.resolve(
      {
        runtime_id: "codex-cli",
        provider_source: "ccswitch",
        ccswitch_app_type: "codex",
        provider_id: route.id,
        provider_config_hash: route.configHash,
        model_id: "gpt-route",
      },
      { runId: "run-codex" },
    );
  assert.match(
    readFileSync(join(launch.env.CODEX_HOME, "config.toml"), "utf8"),
    /model_provider = "custom"/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(launch.env.CODEX_HOME, "auth.json"), "utf8"))
      .OPENAI_API_KEY,
    "codex-secret",
  );
  rmSync(root, { recursive: true, force: true });
});
