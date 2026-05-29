import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiTarget = process.env.VITE_API_TARGET || "https://127.0.0.1:234";
const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        tauriTest: resolve(rootDir, "tauri-test.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
