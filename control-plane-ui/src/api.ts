import type {
  ModelModule,
  ExecutionCatalog,
  TaskActivity,
  TaskSummary,
} from "./types";

const API_BASE = "http://127.0.0.1:18002/v1";

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
) {
  if (window.controlPlaneOverlay) {
    return window.controlPlaneOverlay.request<T>(path, init);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new Error(`Control Plane ${response.status}`);
  return response.json() as Promise<T>;
}

export async function listTasks() {
  return (await request<{ items: TaskSummary[] }>("/tasks")).items;
}

export async function getTaskActivity(taskId: string) {
  return request<TaskActivity>(
    `/tasks/${encodeURIComponent(taskId)}/activity?event_limit=80`,
  );
}

export async function saveExecutionPlan(
  taskId: string,
  taskRevision: number,
  modules: ModelModule[],
  currentPlanRevision: number,
  coordinatorSurface: string,
) {
  return request(`/tasks/${encodeURIComponent(taskId)}/execution-plan`, {
    method: "POST",
    body: {
      revision: currentPlanRevision + 1,
      ...(currentPlanRevision
        ? { change_reason: "Explicit update from the desktop overlay" }
        : {}),
      fallback_policy: "disabled",
      coordinator_surface: coordinatorSurface,
      task_revision: taskRevision,
      stages: modules.map((module, index) => ({
        stage_id: `${String(index + 1).padStart(2, "0")}-${
          module.role
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-") || "stage"
        }`,
        role: module.role.trim() || "Worker",
        responsibility:
          module.responsibility.trim() || module.role.trim() || "Worker",
        write_intent: module.writeIntent,
        profile: {
          profile_id: module.id,
          runtime_id: module.runtimeId,
          provider_id: module.providerId,
          provider_source: "ccswitch",
          ccswitch_app_type: module.providerAppType,
          provider_config_hash: module.providerConfigHash,
          model_id: module.modelId,
          billing_channel: "external-api",
          fallback_policy: "disabled",
        },
      })),
    },
  });
}

const browserCatalog: ExecutionCatalog = {
  source: "ccswitch",
  runtimes: [
    {
      id: "codex-cli",
      label: "Codex CLI",
      available: true,
      appTypes: ["codex"],
      hint: "浏览器预览",
    },
    {
      id: "claude-cli",
      label: "Claude Code CLI",
      available: true,
      appTypes: ["claude"],
      hint: "浏览器预览",
    },
  ],
  providers: [
    {
      key: "codex:preview-openai",
      id: "preview-openai",
      appType: "codex",
      label: "OpenAI · ccSwitch",
      available: true,
      channel: "external-api",
      current: true,
      configured: true,
      runtimeIds: ["codex-cli"],
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      effectiveModel: "gpt-5.6-sol",
      configHash: "sha256:preview-openai",
      hint: "ccSwitch codex · 当前路线",
    },
    {
      key: "claude:preview-deepseek",
      id: "preview-deepseek",
      appType: "claude",
      label: "DeepSeek · ccSwitch",
      available: true,
      channel: "external-api",
      current: true,
      configured: true,
      runtimeIds: ["claude-cli"],
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      effectiveModel: "deepseek-v4-flash",
      configHash: "sha256:preview-deepseek",
      hint: "ccSwitch claude · 当前路线",
    },
  ],
};

export async function detectProviders() {
  return window.controlPlaneOverlay?.detectProviders() ?? browserCatalog;
}
