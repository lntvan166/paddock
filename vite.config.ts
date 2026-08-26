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
  },
  server: {
    proxy: {
      // `Origin` rewritten to the TARGET's, not forwarded.
      //
      // paddock refuses a cross-origin WRITE (`allowWrite` in
      // `server/origin.ts`) because it has no auth token — Cloudflare Access
      // gates the public path, and the origin check is what keeps another
      // process on this host from POSTing to a TCP port every uid can reach.
      // That rule is correct and stays.
      //
      // But through this proxy the browser's origin is `localhost:5173` while
      // the server's host is `127.0.0.1:8787`, so every write from the dev UI
      // was refused — the terminal loaded and then said "cross-origin
      // rejected" instead of output. Presenting the proxy as what it actually
      // is fixes the loop without loosening the server by a single case.
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:8787" },
      },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
