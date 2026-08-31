import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Fold the two builds into the one directory that gets published.
 *
 * Two vite invocations rather than a multi-page build, because `public/` is
 * copied verbatim to whichever outDir owns it and `manifest.webmanifest` sets
 * `"start_url": "."` — which resolves against the manifest's OWN location. An
 * app under /app/ whose manifest sits at the root installs the landing page.
 *
 * Assembled by moving rather than by pointing both builds at overlapping
 * outDirs: vite's `emptyOutDir` would let the second build delete the first,
 * and the result deploys green with no demo in it.
 */
export function assembleSite(opts: {
  siteDir: string;
  appDir: string;
  installScript: string;
}): void {
  const { siteDir, appDir, installScript } = opts;

  // Loud, not silent. A missing input here is a published site whose "try the
  // demo" link 404s while every other page renders perfectly.
  if (!existsSync(siteDir)) throw new Error(`assemble-site: no site build at ${siteDir}`);
  if (!existsSync(appDir)) throw new Error(`assemble-site: no app build at ${appDir}`);
  if (!existsSync(installScript)) {
    throw new Error(`assemble-site: no install script at ${installScript}`);
  }

  const target = join(siteDir, "app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(appDir, target, { recursive: true });
  rmSync(appDir, { recursive: true, force: true });

  // install.sh is served from the site, so it must ride along in the published
  // directory. demo.yml has carried this copy since Pages, for the same reason:
  // without it the published install command 404s while the site looks healthy.
  cpSync(installScript, join(siteDir, "install.sh"));
}

if (import.meta.main) {
  assembleSite({ siteDir: "dist-site", appDir: "dist-app", installScript: "install.sh" });
}
