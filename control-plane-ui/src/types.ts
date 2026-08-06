export type ProviderId = string;

export interface ProviderOption {
  key: string;
  id: ProviderId;
  appType: "claude" | "codex";
  label: string;
  available: boolean;
  channel: "subscription" | "external-api" | "local-cli";
  current: boolean;
  configured: boolean;
  runtimeIds: string[];
  models: string[];
  effectiveModel: string | null;
  configHash: string;
  hint: string;
}

export interface RuntimeOption {
  id: string;
  label: string;
  available: boolean;
  appTypes: Array<"claude" | "codex">;
  hint: string;
}

export interface ExecutionCatalog {
  source: "ccswitch";
  runtimes: RuntimeOption[];
  providers: ProviderOption[];
}

export interface ModelModule {
  id: string;
  providerId: ProviderId;
  providerAppType: "claude" | "codex";
  providerConfigHash: string;
  modelId: string;
  role: string;
  responsibility: string;
  surface: string;
  runtimeId: string;
  writeIntent: boolean;
}

export interface TaskSummary {
  task_id: string;
  title: string;
  goal: string;
  revision: number;
  state: string;
  updated_at?: string;
}

export interface ActivityAssignment {
  assignment_id: string;
  stage_id: string;
  role: string;
  profile: {
    profile_id: string;
    provider_id: string;
    provider_source?: string;
    ccswitch_app_type?: string;
    provider_config_hash?: string;
    model_id: string;
    runtime_id: string;
  };
  prompt: string;
  state: string;
  run_id: string | null;
  updated_at: string;
}

export interface ActivityRun {
  run_id: string;
  assignment_id?: string | null;
  runtime_id: string;
  state: string;
  updated_at: string;
}

export interface ActivityEvent {
  event_id: string;
  run_id: string;
  type: string;
  summary: string;
  recorded_at: string;
}

export interface TaskActivity {
  task: TaskSummary;
  execution_plan: {
    revision: number;
    coordinator_surface?: string;
    stages: Array<{
      stage_id: string;
      role: string;
      responsibility?: string;
      profile: {
        profile_id: string;
        provider_id: string;
        provider_source?: string;
        ccswitch_app_type?: string;
        provider_config_hash?: string;
        model_id: string;
        runtime_id: string;
      };
    }>;
  } | null;
  assignments: ActivityAssignment[];
  runs: ActivityRun[];
  events: ActivityEvent[];
  workspace: { worktree_path: string } | null;
  sessions: Array<{ session_id: string; surface: string; state: string }>;
}

export interface OverlayBridge {
  request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T>;
  detectProviders(): Promise<ExecutionCatalog>;
  setInteractive(interactive: boolean): void;
  togglePin(): Promise<boolean>;
  minimize(): void;
  quit(): void;
}

declare global {
  interface Window {
    controlPlaneOverlay?: OverlayBridge;
  }
}
