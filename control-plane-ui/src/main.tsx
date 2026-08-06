import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Boxes,
  Check,
  ChevronDown,
  CirclePlus,
  EyeOff,
  LoaderCircle,
  Moon,
  Pin,
  PinOff,
  Plus,
  Save,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { SiAnthropic, SiOpenai } from "react-icons/si";
import deepseekLogo from "./assets/deepseek.svg";
import {
  detectProviders,
  getTaskActivity,
  listTasks,
  saveExecutionPlan,
} from "./api";
import type {
  ActivityAssignment,
  ExecutionCatalog,
  ModelModule,
  ProviderOption,
  RuntimeOption,
  TaskActivity,
  TaskSummary,
} from "./types";
import "./styles.css";

const spring = {
  type: "spring" as const,
  stiffness: 380,
  damping: 34,
  mass: 0.75,
};
const STORAGE_KEY = "cross-agent-overlay:model-modules:v1";
const THEME_KEY = "cross-agent-overlay:theme:v1";
const COORDINATOR_SURFACE_KEY = "cross-agent-overlay:coordinator-surface:v1";

const defaultModules: ModelModule[] = [
  {
    id: "gpt-project-direction",
    providerId: "",
    providerAppType: "codex",
    providerConfigHash: "",
    modelId: "gpt-5.6-sol",
    role: "Project Direction",
    responsibility: "理解项目与自然语言目标，将其交付为具体实施方向。",
    surface: "codex-desktop",
    runtimeId: "codex-cli",
    writeIntent: false,
  },
  {
    id: "deepseek-implementation",
    providerId: "",
    providerAppType: "claude",
    providerConfigHash: "",
    modelId: "deepseek-v4-flash",
    role: "Implementation",
    responsibility: "按固定实施方向编写代码；不自行更换模型或扩大范围。",
    surface: "external-api",
    runtimeId: "claude-cli",
    writeIntent: true,
  },
  {
    id: "gpt-acceptance",
    providerId: "",
    providerAppType: "codex",
    providerConfigHash: "",
    modelId: "gpt-5.6-sol",
    role: "Acceptance Audit",
    responsibility: "对照原始目标验收实现结果，确认是否真正完成。",
    surface: "codex-desktop",
    runtimeId: "codex-cli",
    writeIntent: false,
  },
];

const previewActivity: TaskActivity = {
  task: {
    task_id: "task-preview",
    title: "Cross-agent desktop overlay",
    goal: "Coordinate pinned models while keeping every agent visible.",
    revision: 1,
    state: "active",
  },
  execution_plan: {
    revision: 3,
    stages: defaultModules.map((module, index) => ({
      stage_id: `0${index + 1}-${module.role.toLowerCase().replaceAll(" ", "-")}`,
      role: module.role,
      profile: {
        profile_id: module.id,
        provider_id: module.providerId,
        model_id: module.modelId,
        runtime_id: module.runtimeId,
      },
    })),
  },
  assignments: [
    {
      assignment_id: "preview-direction",
      stage_id: "01-project-direction",
      role: "Project Direction",
      profile: {
        profile_id: defaultModules[0].id,
        provider_id: "preview-openai",
        model_id: "gpt-5.6-sol",
        runtime_id: "codex-cli",
      },
      prompt: "Translate the product intent into an implementation brief.",
      state: "completed",
      run_id: "run-direction",
      updated_at: new Date().toISOString(),
    },
    {
      assignment_id: "preview-implementation",
      stage_id: "02-implementation",
      role: "Implementation",
      profile: {
        profile_id: defaultModules[1].id,
        provider_id: "preview-deepseek",
        model_id: "deepseek-v4-flash",
        runtime_id: "claude-cli",
      },
      prompt: "Implement the selected desktop overlay direction.",
      state: "running",
      run_id: "run-implementation",
      updated_at: new Date().toISOString(),
    },
    {
      assignment_id: "preview-audit",
      stage_id: "03-acceptance-audit",
      role: "Acceptance Audit",
      profile: {
        profile_id: defaultModules[2].id,
        provider_id: "preview-openai",
        model_id: "gpt-5.6-sol",
        runtime_id: "codex-cli",
      },
      prompt: "Verify the implementation against the original intent.",
      state: "queued",
      run_id: null,
      updated_at: new Date().toISOString(),
    },
  ],
  runs: [
    {
      run_id: "run-direction",
      runtime_id: "codex-cli",
      state: "completed",
      updated_at: new Date().toISOString(),
    },
    {
      run_id: "run-implementation",
      runtime_id: "claude-cli",
      state: "running",
      updated_at: new Date().toISOString(),
    },
  ],
  events: [
    {
      event_id: "evt-3",
      run_id: "run-implementation",
      type: "tool",
      summary: "Updating standalone overlay interactions",
      recorded_at: new Date().toISOString(),
    },
    {
      event_id: "evt-2",
      run_id: "run-implementation",
      type: "progress",
      summary: "Frontend shell compiled successfully",
      recorded_at: new Date(Date.now() - 72_000).toISOString(),
    },
    {
      event_id: "evt-1",
      run_id: "run-direction",
      type: "completed",
      summary: "Implementation direction delivered",
      recorded_at: new Date(Date.now() - 190_000).toISOString(),
    },
  ],
  workspace: { worktree_path: "E:\\6767\\cross-agent-control-plane" },
  sessions: [
    { session_id: "codex", surface: "codex-desktop", state: "attached" },
    { session_id: "deepseek", surface: "external-api", state: "attached" },
  ],
};

function readModules(): ModelModule[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultModules;
    return (JSON.parse(stored) as Array<Partial<ModelModule>>).map(
      (module, index) => ({
        ...defaultModules[index % defaultModules.length],
        ...module,
        providerAppType:
          module.providerAppType ??
          (module.runtimeId === "claude-cli" ||
          module.runtimeId === "deepseek-api"
            ? "claude"
            : "codex"),
        providerConfigHash: module.providerConfigHash ?? "",
        runtimeId:
          module.runtimeId === "deepseek-api"
            ? "claude-cli"
            : (module.runtimeId ?? "codex-cli"),
      }),
    );
  } catch {
    return defaultModules;
  }
}

function reconcileModules(
  modules: ModelModule[],
  catalog: ExecutionCatalog,
): ModelModule[] {
  return modules.map((module) => {
    const knownRuntime = catalog.runtimes.some(
      (runtime) => runtime.id === module.runtimeId,
    );
    const identity = `${module.providerId} ${module.modelId}`.toLowerCase();
    const inferredAppType =
      identity.includes("deepseek") || identity.includes("claude")
        ? "claude"
        : module.providerAppType;
    const runtimeId = knownRuntime
      ? module.runtimeId
      : (catalog.runtimes.find(
          (runtime) =>
            runtime.available && runtime.appTypes.includes(inferredAppType),
        )?.id ??
        catalog.runtimes.find((runtime) => runtime.available)?.id ??
        module.runtimeId);
    const exact = catalog.providers.find(
      (provider) =>
        provider.id === module.providerId &&
        provider.appType === module.providerAppType &&
        provider.runtimeIds.includes(runtimeId),
    );
    if (exact)
      return {
        ...module,
        runtimeId,
        providerConfigHash: module.providerConfigHash || exact.configHash,
      };
    const labelHint = `${module.providerId} ${module.modelId}`.toLowerCase();
    const compatible = catalog.providers.filter((provider) =>
      provider.runtimeIds.includes(runtimeId),
    );
    const matched =
      compatible.find((provider) =>
        labelHint.includes(provider.label.toLowerCase()),
      ) ??
      compatible.find((provider) => provider.current) ??
      compatible[0];
    if (!matched) return module;
    return {
      ...module,
      runtimeId,
      providerId: matched.id,
      providerAppType: matched.appType,
      providerConfigHash: matched.configHash,
      modelId: matched.models.includes(module.modelId)
        ? module.modelId
        : (matched.effectiveModel ?? matched.models[0] ?? module.modelId),
    };
  });
}

function progressFor(state: string) {
  return (
    (
      {
        queued: 8,
        assigned: 20,
        running: 64,
        blocked: 46,
        completed: 100,
        failed: 100,
        canceled: 100,
      } as Record<string, number>
    )[state] ?? 12
  );
}

function stateLabel(state: string) {
  return (
    (
      {
        queued: "等待交付",
        assigned: "已分配",
        running: "执行中",
        blocked: "需要关注",
        completed: "已完成",
        failed: "执行失败",
        canceled: "已取消",
      } as Record<string, string>
    )[state] ?? "未开始"
  );
}

function moduleTone(index: number) {
  return ["cyan", "lilac", "peach", "mint"][index % 4];
}

function assignmentFor(module: ModelModule, activity: TaskActivity | null) {
  return activity?.assignments.find(
    (assignment) =>
      assignment.profile.profile_id === module.id ||
      (assignment.profile.model_id === module.modelId &&
        assignment.role === module.role),
  );
}

function ModelLogo({ module }: { module: ModelModule }) {
  const identity = `${module.providerId} ${module.modelId}`.toLowerCase();
  if (identity.includes("deepseek")) {
    return <img src={deepseekLogo} alt="" aria-hidden="true" />;
  }
  if (identity.includes("anthropic") || identity.includes("claude")) {
    return <SiAnthropic aria-hidden="true" />;
  }
  if (
    identity.includes("openai") ||
    identity.includes("codex") ||
    identity.includes("gpt")
  ) {
    return <SiOpenai aria-hidden="true" />;
  }
  return <Boxes size={18} aria-hidden="true" />;
}

function ModelCard({
  module,
  index,
  assignment,
  activity,
  expanded,
  onToggle,
}: {
  module: ModelModule;
  index: number;
  assignment?: ActivityAssignment;
  activity: TaskActivity | null;
  expanded: boolean;
  onToggle(): void;
}) {
  const suppressClickUntil = useRef(0);
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const state = assignment?.state ?? "idle";
  const progress = assignment ? progressFor(state) : 0;
  const events =
    activity?.events
      .filter(
        (event) => !assignment?.run_id || event.run_id === assignment.run_id,
      )
      .slice(0, 4) ?? [];

  return (
    <motion.section
      data-overlay-hit
      data-testid={`model-card-${index}`}
      className={`model-card card-column-${index % 3} tone-${moduleTone(index)} ${expanded ? "is-expanded" : ""}`}
      style={{ "--card-row": Math.floor(index / 3) } as CSSProperties}
      drag
      dragMomentum={false}
      dragElastic={0.08}
      transition={spring}
      animate={{
        width: expanded ? 660 : 350,
        minHeight: expanded ? 350 : 132,
        zIndex: expanded ? 20 : 4,
      }}
      onDragEnd={() => {
        suppressClickUntil.current = Date.now() + 240;
      }}
      onTapStart={(_, info) => {
        tapStart.current = info.point;
      }}
      onTap={(_, info) => {
        const start = tapStart.current;
        tapStart.current = null;
        if (!start || Date.now() < suppressClickUntil.current) return;
        if (Math.hypot(info.point.x - start.x, info.point.y - start.y) < 7)
          onToggle();
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="glass-shine" />
      <header className="card-header">
        <div
          className="model-mark"
          title={`${module.providerId} · ${module.modelId}`}
        >
          <ModelLogo module={module} />
        </div>
        <div className="model-heading">
          <span className="eyebrow">{module.role}</span>
          <strong>{module.modelId}</strong>
        </div>
      </header>

      <div className="progress-copy">
        <span>{stateLabel(state)}</span>
        <span>阶段估算 {progress}%</span>
      </div>
      <div className="progress-track" aria-label={`阶段估算 ${progress}%`}>
        <motion.div
          className="progress-fill"
          animate={{ width: `${progress}%` }}
          transition={spring}
        />
      </div>

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            className="card-details"
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <div className="detail-grid">
              <div>
                <span>Provider</span>
                <strong>{module.providerId}</strong>
              </div>
              <div>
                <span>Surface</span>
                <strong>{module.surface}</strong>
              </div>
              <div>
                <span>Stage</span>
                <strong>{assignment?.stage_id ?? "尚未交付"}</strong>
              </div>
              <div>
                <span>Run</span>
                <strong>{assignment?.run_id?.slice(0, 18) ?? "—"}</strong>
              </div>
            </div>
            <div className="activity-list">
              <div className="section-label">
                <Activity size={14} /> 当前活动
              </div>
              {events.length ? (
                events.map((event) => (
                  <div className="activity-row" key={event.event_id}>
                    <span className="activity-pulse" />
                    <div>
                      <strong>{event.summary}</strong>
                      <small>
                        {event.type} ·{" "}
                        {new Date(event.recorded_at).toLocaleTimeString()}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <div className="activity-empty">暂无运行事件</div>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

function SettingsPanel({
  open,
  modules,
  providers,
  runtimes,
  tasks,
  selectedTaskId,
  coordinatorSurface,
  saving,
  onClose,
  onModules,
  onTask,
  onSurface,
  onSave,
}: {
  open: boolean;
  modules: ModelModule[];
  providers: ProviderOption[];
  runtimes: RuntimeOption[];
  tasks: TaskSummary[];
  selectedTaskId: string;
  coordinatorSurface: string;
  saving: boolean;
  onClose(): void;
  onModules(modules: ModelModule[]): void;
  onTask(taskId: string): void;
  onSurface(surface: string): void;
  onSave(): void;
}) {
  const update = (index: number, patch: Partial<ModelModule>) => {
    onModules(
      modules.map((module, itemIndex) =>
        itemIndex === index ? { ...module, ...patch } : module,
      ),
    );
  };
  const planReady = modules.every((module) => {
    const provider = providers.find(
      (item) =>
        item.id === module.providerId &&
        item.appType === module.providerAppType,
    );
    return Boolean(
      provider?.available &&
      provider.configHash === module.providerConfigHash &&
      provider.runtimeIds.includes(module.runtimeId) &&
      module.modelId.trim(),
    );
  });
  const add = () => {
    const runtime = runtimes.find((item) => item.available) ?? runtimes[0];
    const provider =
      providers.find(
        (item) => item.available && item.runtimeIds.includes(runtime?.id ?? ""),
      ) ??
      providers.find((item) => item.runtimeIds.includes(runtime?.id ?? ""));
    if (!runtime || !provider) return;
    onModules([
      ...modules,
      {
        id: `profile-${crypto.randomUUID()}`,
        providerId: provider.id,
        providerAppType: provider.appType,
        providerConfigHash: provider.configHash,
        modelId:
          provider.effectiveModel ?? provider.models[0] ?? "custom-model",
        role: "New role",
        responsibility: "由 Coordinator 理解并交付的自定义模型职责。",
        surface: coordinatorSurface,
        runtimeId: runtime.id,
        writeIntent: false,
      },
    ]);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          data-overlay-hit
          className="settings-panel"
          initial={{ opacity: 0, scale: 0.9, x: 48 }}
          animate={{ opacity: 1, scale: 1, x: 0 }}
          exit={{ opacity: 0, scale: 0.92, x: 38 }}
          transition={spring}
        >
          <div className="glass-shine" />
          <header className="settings-header">
            <div>
              <span className="eyebrow">Execution setup</span>
              <h2>模型分工</h2>
            </div>
            <button
              className="icon-button compact"
              onClick={onClose}
              aria-label="关闭设置"
            >
              <X size={18} />
            </button>
          </header>

          <div className="settings-context">
            <label>
              当前任务
              <span className="select-wrap">
                <select
                  value={selectedTaskId}
                  onChange={(event) => onTask(event.target.value)}
                >
                  <option value="">尚未选择任务</option>
                  {tasks.map((task) => (
                    <option value={task.task_id} key={task.task_id}>
                      {task.title}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </span>
            </label>
            <label>
              Coordinator 会话区
              <span className="select-wrap">
                <select
                  value={coordinatorSurface}
                  onChange={(event) => onSurface(event.target.value)}
                >
                  <option value="codex-desktop">Codex Desktop</option>
                  <option value="claude-desktop">Claude Desktop</option>
                  <option value="openhands">OpenHands</option>
                  <option value="cursor">Cursor</option>
                  <option value="external-api">External API</option>
                </select>
                <ChevronDown size={14} />
              </span>
            </label>
          </div>

          <div className="model-editor-list">
            {modules.map((module, index) => {
              const provider = providers.find(
                (item) =>
                  item.id === module.providerId &&
                  item.appType === module.providerAppType,
              );
              const compatibleProviders = providers.filter((item) =>
                item.runtimeIds.includes(module.runtimeId),
              );
              const modelOptions = Array.from(
                new Set(
                  [module.modelId, ...(provider?.models ?? [])].filter(Boolean),
                ),
              );
              return (
                <div className="model-editor" key={module.id}>
                  <div className="editor-line">
                    <span
                      className={`provider-light ${provider?.available ? "available" : ""}`}
                    />
                    <select
                      value={module.runtimeId}
                      aria-label="Runtime"
                      onChange={(event) => {
                        const runtimeId = event.target.value;
                        const next =
                          providers.find(
                            (item) =>
                              item.current &&
                              item.runtimeIds.includes(runtimeId),
                          ) ??
                          providers.find((item) =>
                            item.runtimeIds.includes(runtimeId),
                          );
                        update(index, {
                          runtimeId,
                          providerId: next?.id ?? "",
                          providerAppType: next?.appType ?? "codex",
                          providerConfigHash: next?.configHash ?? "",
                          modelId:
                            next?.effectiveModel ??
                            next?.models[0] ??
                            module.modelId,
                        });
                      }}
                    >
                      {runtimes.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.label}
                          {item.available ? "" : " · 未检测"}
                        </option>
                      ))}
                    </select>
                    <select
                      value={provider?.key ?? ""}
                      aria-label="ccSwitch Provider"
                      onChange={(event) => {
                        const next = providers.find(
                          (item) => item.key === event.target.value,
                        );
                        if (!next) return;
                        update(index, {
                          providerId: next.id,
                          providerAppType: next.appType,
                          providerConfigHash: next.configHash,
                          modelId:
                            next.effectiveModel ??
                            next.models[0] ??
                            module.modelId,
                        });
                      }}
                    >
                      {compatibleProviders.map((item) => (
                        <option value={item.key} key={item.key}>
                          {item.label}
                          {item.current ? " · 当前" : ""}
                        </option>
                      ))}
                    </select>
                    {modelOptions.length === 0 ? (
                      <input
                        value={module.modelId}
                        onChange={(event) =>
                          update(index, { modelId: event.target.value })
                        }
                        aria-label="模型"
                      />
                    ) : (
                      <select
                        value={module.modelId}
                        onChange={(event) =>
                          update(index, { modelId: event.target.value })
                        }
                        aria-label="模型"
                      >
                        {modelOptions.map((model) => (
                          <option value={model} key={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      className="remove-button"
                      disabled={modules.length === 1}
                      onClick={() =>
                        onModules(
                          modules.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                      aria-label="删除模型"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="provider-hint">
                    {provider &&
                    provider.configHash !== module.providerConfigHash
                      ? "ccSwitch 路线配置已变化，请重新选择该 Provider"
                      : (provider?.hint ?? "未检测到兼容的 ccSwitch 路线")}
                    {" · "}
                    {module.runtimeId} 独立实例
                  </div>
                  <div className="editor-line lower">
                    <input
                      value={module.role}
                      onChange={(event) =>
                        update(index, { role: event.target.value })
                      }
                      aria-label="角色"
                    />
                    <label className="write-toggle">
                      <input
                        type="checkbox"
                        checked={module.writeIntent}
                        onChange={(event) =>
                          update(index, { writeIntent: event.target.checked })
                        }
                      />
                      允许写入
                    </label>
                  </div>
                  <textarea
                    value={module.responsibility}
                    onChange={(event) =>
                      update(index, { responsibility: event.target.value })
                    }
                    aria-label="自定义模型职责"
                  />
                </div>
              );
            })}
          </div>

          <div className="settings-actions">
            <button className="add-button" onClick={add}>
              <Plus size={16} /> 添加模型
            </button>
            <button
              className="save-button"
              onClick={onSave}
              disabled={!selectedTaskId || saving || !planReady}
            >
              {saving ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Save size={16} />
              )}{" "}
              固定 Execution Plan
            </button>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function OverlayApp() {
  const preview = new URLSearchParams(location.search).has("preview");
  const [modules, setModules] = useState<ModelModule[]>(readModules);
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>(
    preview ? [previewActivity.task] : [],
  );
  const [selectedTaskId, setSelectedTaskId] = useState(
    preview ? previewActivity.task.task_id : "",
  );
  const [activity, setActivity] = useState<TaskActivity | null>(
    preview ? previewActivity : null,
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(preview ? [defaultModules[1].id] : []),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem(THEME_KEY) !== "clear",
  );
  const [coordinatorSurface, setCoordinatorSurface] = useState(
    () => localStorage.getItem(COORDINATOR_SURFACE_KEY) ?? "codex-desktop",
  );
  const [pinned, setPinned] = useState(true);
  const [connection, setConnection] = useState(preview ? "已连接" : "正在连接");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const interactiveRef = useRef(true);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(modules));
  }, [modules]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, darkMode ? "dark" : "clear");
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(COORDINATOR_SURFACE_KEY, coordinatorSurface);
  }, [coordinatorSurface]);

  useEffect(() => {
    void detectProviders().then((catalog) => {
      setRuntimes(catalog.runtimes);
      setProviders(catalog.providers);
      setModules((current) => reconcileModules(current, catalog));
    });
    if (preview) return;
    let active = true;
    const refreshTasks = async () => {
      try {
        const nextTasks = await listTasks();
        if (!active) return;
        setTasks(nextTasks);
        setSelectedTaskId(
          (current) => current || nextTasks.at(-1)?.task_id || "",
        );
        setConnection("已连接");
      } catch {
        if (active) setConnection("等待 Control Plane");
      }
    };
    void refreshTasks();
    const timer = window.setInterval(refreshTasks, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [preview]);

  useEffect(() => {
    if (settingsOpen)
      void detectProviders().then((catalog) => {
        setRuntimes(catalog.runtimes);
        setProviders(catalog.providers);
        setModules((current) => reconcileModules(current, catalog));
      });
  }, [settingsOpen]);

  useEffect(() => {
    if (!selectedTaskId || preview) return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await getTaskActivity(selectedTaskId);
        if (active) {
          setActivity(next);
          setConnection("已连接");
        }
      } catch {
        if (active) setConnection("活动流暂不可用");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [preview, selectedTaskId]);

  useEffect(() => {
    if (!window.controlPlaneOverlay) return;
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const interactive = Boolean(target?.closest("[data-overlay-hit]"));
      if (interactiveRef.current !== interactive) {
        interactiveRef.current = interactive;
        window.controlPlaneOverlay?.setInteractive(interactive);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const task = useMemo(
    () => tasks.find((item) => item.task_id === selectedTaskId),
    [selectedTaskId, tasks],
  );
  const completed =
    activity?.assignments.filter((item) => item.state === "completed").length ??
    0;
  const running =
    activity?.assignments.filter((item) => item.state === "running").length ??
    0;

  const toggleExpanded = (moduleId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const save = async () => {
    if (!task) return;
    setSaving(true);
    try {
      await saveExecutionPlan(
        task.task_id,
        task.revision,
        modules,
        activity?.execution_plan?.revision ?? 0,
        coordinatorSurface,
      );
      setActivity(await getTaskActivity(task.task_id));
      setNotice("Execution Plan 已按当前模型与职责固定");
      window.setTimeout(() => setNotice(""), 3200);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      className={`overlay-canvas ${preview ? "preview-desktop" : ""} ${darkMode ? "theme-dark" : "theme-clear"}`}
    >
      <motion.div
        data-overlay-hit
        drag
        dragMomentum={false}
        className="mission-pill"
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
      >
        <Sparkles size={16} />
        <div>
          <span>Current mission</span>
          <strong>{task?.title ?? "选择一个任务会话"}</strong>
        </div>
        <span className="connection">
          <i />
          {connection}
        </span>
      </motion.div>

      <div data-overlay-hit className="orb-stack">
        <button
          className={`orb ${pinned ? "active" : ""}`}
          onClick={async () =>
            setPinned(
              await (window.controlPlaneOverlay?.togglePin() ??
                Promise.resolve(!pinned)),
            )
          }
          aria-label={pinned ? "取消置顶" : "置顶"}
        >
          {pinned ? <Pin size={18} /> : <PinOff size={18} />}
        </button>
        <button
          className="orb"
          onClick={() => window.controlPlaneOverlay?.minimize()}
          aria-label="隐藏悬浮层"
        >
          <EyeOff size={18} />
        </button>
        <button
          className={`orb ${darkMode ? "active" : ""}`}
          onClick={() => setDarkMode((value) => !value)}
          aria-label={darkMode ? "切换到透明模式" : "切换到深色模式"}
        >
          {darkMode ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <button
          className={`orb ${settingsOpen ? "active" : ""}`}
          onClick={() => setSettingsOpen((value) => !value)}
          aria-label="打开模型配置"
        >
          <Settings size={19} />
        </button>
      </div>

      <section className="module-field" aria-label="模型活动模块">
        {modules.map((module, index) => (
          <ModelCard
            key={module.id}
            module={module}
            index={index}
            assignment={assignmentFor(module, activity)}
            activity={activity}
            expanded={expandedIds.has(module.id)}
            onToggle={() => toggleExpanded(module.id)}
          />
        ))}
      </section>

      <motion.div
        data-overlay-hit
        drag
        dragMomentum={false}
        className="status-strip"
        layout
        transition={spring}
      >
        <div>
          <span className="live-signal" />
          <strong>{running}</strong>
          <small>运行中</small>
        </div>
        <div>
          <Check size={15} />
          <strong>{completed}</strong>
          <small>已完成</small>
        </div>
        <div>
          <CirclePlus size={15} />
          <strong>{modules.length}</strong>
          <small>固定模型</small>
        </div>
        <button onClick={() => setSettingsOpen(true)}>
          <Plus size={15} /> 添加模型
        </button>
      </motion.div>

      <SettingsPanel
        open={settingsOpen}
        modules={modules}
        providers={providers}
        runtimes={runtimes}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        coordinatorSurface={coordinatorSurface}
        saving={saving}
        onClose={() => setSettingsOpen(false)}
        onModules={setModules}
        onTask={setSelectedTaskId}
        onSurface={setCoordinatorSurface}
        onSave={save}
      />

      <AnimatePresence>
        {notice ? (
          <motion.div
            data-overlay-hit
            className="toast"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
          >
            {notice}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        data-overlay-hit
        className="quit-zone"
        onDoubleClick={() => window.controlPlaneOverlay?.quit()}
        aria-label="双击退出"
      >
        <X size={12} />
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
