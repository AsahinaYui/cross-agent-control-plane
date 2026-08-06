import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(process.cwd(), "control-plane-ui"),
  base: "./",
  build: {
    outDir: resolve(process.cwd(), "build/control-plane-overlay"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
});
