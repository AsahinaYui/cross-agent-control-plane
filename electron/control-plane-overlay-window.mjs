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
    // The overlay is already visible. Do not call show()/focus() here: opening
    // settings must not steal focus, while the next explicit control click can
    // activate this now-focusable window normally.
    return;
  }
  const wasFocused = window.isFocused();
  window.setFocusable(false);
  if (wasFocused) {
    // Do not hide/show the transparent window here. On Windows that sequence
    // can leave an always-on-top, non-focusable BrowserWindow visible but
    // permanently unable to receive mouse input again. Blurring after the
    // focusability change releases activation without recreating native state.
    window.blur();
  }
}

export function shouldOverlayCapturePointer({
  editing,
  windowBounds,
  cursor,
  hitRegions,
}) {
  if (editing) return true;
  const clientX = cursor.x - windowBounds.x;
  const clientY = cursor.y - windowBounds.y;
  return hitRegions.some(
    (region) =>
      clientX >= region.x &&
      clientX <= region.x + region.width &&
      clientY >= region.y &&
      clientY <= region.y + region.height,
  );
}
