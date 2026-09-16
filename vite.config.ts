import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI with hot reload and proxies /api to `wrangler dev` (port 8787).
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { outDir: "dist", sourcemap: true },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
