import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.SCOUTNEWS_API_URL ?? "http://127.0.0.1:8080";

// Framework code changes far less often than the reader does, so it is kept in its
// own chunks: a release then re-downloads the app code only, not the whole bundle.
const vendors: Record<string, string[]> = {
  "vendor-react": ["react", "react-dom", "scheduler", "react-router", "react-router-dom", "@tanstack"],
  "vendor-fluent": ["@fluentui", "@griffel", "@swc/helpers"],
};

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          const path = id.replace(/\\/g, "/");
          return Object.keys(vendors).find(chunk =>
            vendors[chunk].some(name => path.includes(`/node_modules/${name}/`)));
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": apiTarget, "/health": apiTarget },
  },
});
