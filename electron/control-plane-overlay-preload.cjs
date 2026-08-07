const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("controlPlaneOverlay", {
  request: (path, init) => ipcRenderer.invoke("overlay:request", path, init),
  detectProviders: () => ipcRenderer.invoke("overlay:detect-providers"),
  setInteractive: (interactive) =>
    ipcRenderer.send("overlay:set-interactive", Boolean(interactive)),
  setFocusable: (focusable) =>
    ipcRenderer.send("overlay:set-focusable", Boolean(focusable)),
  togglePin: () => ipcRenderer.invoke("overlay:toggle-pin"),
  minimize: () => ipcRenderer.send("overlay:minimize"),
  quit: () => ipcRenderer.send("overlay:quit"),
});
