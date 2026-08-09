import { describe, expect, it } from "vitest";
import {
  agentProfileIds,
  agentReuseLabel,
  uniqueAgentCount,
} from "./agent-identity";
import type { ModelModule } from "./types";

const base: ModelModule = {
  id: "direction",
  providerId: "openai",
  providerAppType: "codex",
  providerConfigHash: "sha256:openai",
  modelId: "gpt-test",
  role: "Project Direction",
  responsibility: "Plan",
  surface: "codex-cli",
  runtimeId: "codex-cli",
  writeIntent: false,
};

describe("agent identity", () => {
  it("reuses one profile for matching direction and audit stages", () => {
    const modules = [base, { ...base, id: "audit", role: "Acceptance Audit" }];
    expect(agentProfileIds(modules)).toEqual(["direction", "direction"]);
    expect(uniqueAgentCount(modules)).toBe(1);
    expect(agentReuseLabel(modules, 1)).toBe("复用 Agent 1");
  });

  it("keeps different routes and permissions in separate agents", () => {
    const modules = [
      base,
      { ...base, id: "writer", writeIntent: true },
      { ...base, id: "other-route", providerId: "deepseek" },
    ];
    expect(agentProfileIds(modules)).toEqual([
      "direction",
      "writer",
      "other-route",
    ]);
    expect(uniqueAgentCount(modules)).toBe(3);
  });
});
