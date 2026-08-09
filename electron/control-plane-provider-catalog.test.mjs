import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderCatalog,
  parseCodexModelCache,
} from "./control-plane-provider-catalog.mjs";

test("parseCodexModelCache exposes listed models and hides internal entries", () => {
  const result = parseCodexModelCache(
    JSON.stringify({
      models: [
        { slug: "gpt-visible", visibility: "list" },
        { slug: "internal-review", visibility: "hide" },
        { slug: "gpt-visible", visibility: "list" },
      ],
    }),
  );
  assert.deepEqual(result, ["gpt-visible"]);
});

test("buildProviderCatalog exposes ccSwitch routes separately from runtimes", async () => {
  const catalog = await buildProviderCatalog({
    userHome: "Z:\\missing-home",
    hasCommand: (command) => command === "claude",
    readLiveTakeovers: () => ["codex"],
    readCatalog: () => [
      {
        key: "claude:deepseek",
        id: "deepseek",
        appType: "claude",
        label: "DeepSeek",
        current: true,
        configured: true,
        credentialReady: true,
        runtimeIds: ["claude-cli"],
        models: ["deepseek-v4-flash"],
        effectiveModel: "deepseek-v4-pro",
        configHash: "sha256:route",
      },
      {
        key: "codex:official",
        id: "official",
        appType: "codex",
        label: "OpenAI Official",
        current: true,
        configured: true,
        credentialReady: true,
        runtimeIds: ["codex-cli"],
        models: ["gpt-test"],
        effectiveModel: "gpt-test",
        configHash: "sha256:official",
      },
    ],
  });

  assert.equal(catalog.source, "ccswitch");
  assert.deepEqual(catalog.liveTakeovers, ["codex"]);
  assert.equal(
    catalog.runtimes.find((item) => item.id === "claude-cli").available,
    true,
  );
  assert.equal(
    catalog.runtimes.find((item) => item.id === "codex-cli").available,
    false,
  );
  assert.equal(catalog.providers[0].available, true);
  assert.equal(catalog.providers[1].available, false);
  assert.equal(catalog.providers[0].connected, true);
  assert.equal(catalog.providers[1].connected, false);
  assert.deepEqual(catalog.providers[0].models, ["deepseek-v4-flash"]);
  assert.match(catalog.providers[0].hint, /ccSwitch claude/);
});
