import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    // One chunk on purpose: at high RTT an extra round trip costs more than the
    // bytes code-splitting would save, and this is a single screen.
    rollupOptions: { output: { manualChunks: undefined } },
  },
  define: {
    // JSON.stringify, not bare interpolation: a define value is substituted as
    // SOURCE TEXT, so an unquoted version becomes a syntax error or an
    // identifier. This is the same quoting hazard tests/version-stamp.test.ts
    // exists to catch on the server side.
    __PADDOCK_VERSION__: JSON.stringify(process.env.PADDOCK_VERSION ?? "0.0.0-dev"),
    __PADDOCK_COMMIT__: JSON.stringify(process.env.PADDOCK_COMMIT ?? "dev"),
    __PADDOCK_BUILD_TIME__: JSON.stringify(process.env.PADDOCK_BUILD_TIME ?? "unknown"),
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
