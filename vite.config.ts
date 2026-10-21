import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Fail loudly if the port is taken. With `false`, Vite silently moved to
    // 5174 - and the API's CORS allow-list names 5173, so every request from
    // 5174 came back without an `Access-Control-Allow-Origin` header and the
    // browser reported it as "Cannot reach the API". A confusing failure for
    // what is really "another dev server is already running".
    strictPort: true,
    proxy: {
      // The app talks to its own origin in development and Vite forwards
      // `/api` to the API. That keeps development off CORS entirely: no
      // allow-list to keep in sync, no port that has to match, and the page
      // works from whatever origin the preview panel serves it on.
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
      // `/health` lives at the API's root, not under `/api/v1`, so it needs its
      // own entry - otherwise it would resolve against the Vite origin and 404.
      "/health": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
    },
  },
});
