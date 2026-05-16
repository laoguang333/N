import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET || "https://127.0.0.1:234";

export default defineConfig({
  plugins: [react()],
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
