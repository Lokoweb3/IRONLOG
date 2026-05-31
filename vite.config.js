import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Vite dev server (default :5173) proxies API calls to the Express
// server so the browser only ever talks to ONE origin — that keeps the session
// cookie first-party and means we never need CORS. In prod, Express serves the
// built `dist/` itself (see server/index.js), so there's no proxy at all.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.PORT || "8080";
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/auth": { target: apiTarget, changeOrigin: true },
        "/workouts": { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
