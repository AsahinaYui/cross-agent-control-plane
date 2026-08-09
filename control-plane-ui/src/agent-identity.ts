import type { ModelModule } from "./types";

export function agentIdentityKey(module: ModelModule) {
  return JSON.stringify([
    module.runtimeId,
    module.providerAppType,
    module.providerId,
    module.providerConfigHash,
    module.modelId,
    module.writeIntent,
  ]);
}

export function agentProfileIds(modules: ModelModule[]) {
  const identities = new Map<string, string>();
  return modules.map((module) => {
    const identity = agentIdentityKey(module);
    const existing = identities.get(identity);
    if (existing) return existing;
    identities.set(identity, module.id);
    return module.id;
  });
}

export function uniqueAgentCount(modules: ModelModule[]) {
  return new Set(modules.map(agentIdentityKey)).size;
}

export function agentReuseLabel(modules: ModelModule[], index: number) {
  const identity = agentIdentityKey(modules[index]);
  const matching = modules.filter(
    (module) => agentIdentityKey(module) === identity,
  );
  if (matching.length < 2) return null;
  const identities = [...new Set(modules.map(agentIdentityKey))];
  return `复用 Agent ${identities.indexOf(identity) + 1}`;
}
