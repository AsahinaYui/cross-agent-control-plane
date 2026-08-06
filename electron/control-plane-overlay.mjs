import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  screen,
  Tray,
  Menu,
} from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderCatalog } from "./control-plane-provider-catalog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const controlPlaneBase = `http://127.0.0.1:${process.env.CROSS_AGENT_CONTROL_PLANE_PORT ?? "18002"}`;
const appIconPath = join(__dirname, "build-resources", "icon.png");
let overlayWindow = null;
let tray = null;
let ownedBackend = null;
let pinned = true;

app.setName("Cross Agent Overlay");

async function providerCatalog() {
  return buildProviderCatalog();
}

async function backendHealthy() {
  try {
    const response = await fetch(`${controlPlaneBase}/v1/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await backendHealthy()) return;
  const cliPath = join(projectRoot, "control-plane", "cli.mjs");
  if (!existsSync(cliPath))
    throw new Error(`Control Plane CLI not found: ${cliPath}`);
  ownedBackend = spawn(process.execPath, [cliPath, "serve"], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await backendHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Control Plane backend did not become ready on port 18002");
}

function createOverlayWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  overlayWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: "Cross Agent Overlay",
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "control-plane-overlay-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setMenuBarVisibility(false);

  const devUrl = process.env.CONTROL_PLANE_OVERLAY_DEV_URL;
  if (devUrl) overlayWindow.loadURL(devUrl);
  else
    overlayWindow.loadFile(
      join(projectRoot, "build", "control-plane-overlay", "index.html"),
    );

  overlayWindow.once("ready-to-show", () => overlayWindow?.showInactive());
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

function createTray() {
  const icon = nativeImage
    .createFromPath(appIconPath)
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Cross Agent Overlay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示悬浮层", click: () => overlayWindow?.show() },
      { label: "隐藏悬浮层", click: () => overlayWindow?.hide() },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });
}

function isOverlaySender(event) {
  return Boolean(
    overlayWindow &&
    !overlayWindow.isDestroyed() &&
    event.sender === overlayWindow.webContents,
  );
}

ipcMain.handle("overlay:request", async (event, path, init = {}) => {
  if (
    !isOverlaySender(event) ||
    typeof path !== "string" ||
    !path.startsWith("/")
  ) {
    throw new Error("Invalid overlay request");
  }
  const headers = init.body ? { "content-type": "application/json" } : {};
  if (process.env.CONTROL_PLANE_API_KEY)
    headers["x-session-api-key"] = process.env.CONTROL_PLANE_API_KEY;
  const response = await fetch(`${controlPlaneBase}/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error ?? `Control Plane ${response.status}`);
  return payload;
});

ipcMain.handle("overlay:detect-providers", (event) => {
  if (!isOverlaySender(event)) return [];
  return providerCatalog();
});

ipcMain.on("overlay:set-interactive", (event, interactive) => {
  if (!isOverlaySender(event) || !overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.handle("overlay:toggle-pin", (event) => {
  if (!isOverlaySender(event) || !overlayWindow) return pinned;
  pinned = !pinned;
  overlayWindow.setAlwaysOnTop(pinned, pinned ? "floating" : "normal");
  return pinned;
});

ipcMain.on("overlay:minimize", (event) => {
  if (isOverlaySender(event)) overlayWindow?.hide();
});
ipcMain.on("overlay:quit", (event) => {
  if (isOverlaySender(event)) app.quit();
});

app.whenReady().then(async () => {
  if (process.platform === "win32")
    app.setAppUserModelId("cross.agent.control-plane.overlay");
  await ensureBackend();
  createOverlayWindow();
  createTray();
});

app.on("activate", () => {
  if (overlayWindow) overlayWindow.show();
  else createOverlayWindow();
});

app.on("window-all-closed", () => {
  // Keep the tray process alive so a hidden overlay can be restored.
});

app.on("before-quit", () => {
  tray?.destroy();
  tray = null;
  if (ownedBackend && !ownedBackend.killed) ownedBackend.kill();
});
