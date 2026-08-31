import { defineConfig } from "vite";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * The landing page. Deliberately NOT the app's config: no React plugin and no
 * `@web` alias, so importing a dashboard component from the site fails at build
 * time rather than quietly doubling the bundle a visitor downloads.
 */
export default defineConfig({
  root: "site",
  plugins: [tailwind()],
  resolve: {
    alias: {
      "@site": fileURLToPath(new URL("./src/site", import.meta.url)),
      // The tour's steps are typed against TOUR_ANCHORS, which lives in shared
      // precisely because both sides need it. Without this alias the site build
      // cannot resolve it. `@web` is deliberately absent: importing a dashboard
      // component here should fail, not silently double the bundle.
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: { outDir: "../dist-site", emptyOutDir: true },
});
