export function createOverlayWindowOptions({ area, preloadPath, iconPath }) {
  return {
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
    focusable: false,
    skipTaskbar: false,
    show: false,
    title: "Cross Agent Overlay",
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
}

export function applyOverlayFocusability(window, focusable) {
  if (focusable) {
    window.setFocusable(true);
    window.show();
    window.focus();
    return;
  }
  window.blur();
  window.setFocusable(false);
}
