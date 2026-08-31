import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { assembleSite } from "../scripts/assemble-site";

/**
 * The demo is published as ONE directory, built by TWO vite invocations. The
 * failure this guards is silent: vite's `emptyOutDir` lets a second build
 * delete the first, and a site whose /app/ directory is missing deploys green
 * and 404s for every visitor who clicks "try the demo".
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paddock-assemble-"));
  const siteDir = join(root, "dist-site");
  const appDir = join(root, "dist-app");
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(siteDir, "index.html"), "<!doctype html>site");
  writeFileSync(join(appDir, "index.html"), "<!doctype html>app");
  writeFileSync(join(appDir, "manifest.webmanifest"), '{"start_url":"."}');
  const installScript = join(root, "install.sh");
  writeFileSync(installScript, "#!/bin/sh\n");
  return { root, siteDir, appDir, installScript };
}

test("the app lands under /app/, with its manifest beside it", () => {
  const { root, siteDir, appDir, installScript } = fixture();
  assembleSite({ siteDir, appDir, installScript });

  // The manifest's start_url is ".", which resolves against the manifest's OWN
  // location. At the site root it would install the landing page instead of
  // the dashboard — an icon that opens marketing copy, invisible until a user
  // does it.
  expect(existsSync(join(siteDir, "app", "index.html"))).toBe(true);
  expect(existsSync(join(siteDir, "app", "manifest.webmanifest"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("the landing page survives the assembly", () => {
  const { root, siteDir, appDir, installScript } = fixture();
  assembleSite({ siteDir, appDir, installScript });
  expect(readFileSync(join(siteDir, "index.html"), "utf8")).toContain("site");
  rmSync(root, { recursive: true, force: true });
});

/**
 * The site keeps serving install.sh even though README no longer points here.
 *
 * The documented command reads the copy on GitHub now, so this one is no
 * longer load-bearing — but the site URL was published for months and the OG
 * card still shows it, and a bookmarked `curl … | sh` that starts 404ing is a
 * worse failure than an extra 4 KB in the bundle.
 */
test("install.sh rides along, so the URL published for months keeps resolving", () => {
  const { root, siteDir, appDir, installScript } = fixture();
  assembleSite({ siteDir, appDir, installScript });
  expect(existsSync(join(siteDir, "install.sh"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("a missing app build throws rather than publishing a site with no demo", () => {
  const { root, siteDir, installScript } = fixture();
  // The whole point: a silent skip here is a deploy that looks healthy.
  expect(() =>
    assembleSite({ siteDir, appDir: join(root, "does-not-exist"), installScript }),
  ).toThrow();
  rmSync(root, { recursive: true, force: true });
});

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

test("the app build is a demo build, based at /app/", () => {
  const s = pkg.scripts["build:app"] ?? "";
  expect(s).toContain("VITE_PADDOCK_DEMO=1");
  expect(s, "without this base the app's assets 404 under /app/").toContain("--base=/app/");
  expect(s).toContain("--outDir dist-app");
});

test("build:demo runs the site build, the app build, then the assembly", () => {
  const s = pkg.scripts["build:demo"] ?? "";
  const site = s.indexOf("build:site");
  const app = s.indexOf("build:app");
  const assemble = s.indexOf("assemble-site");
  expect(site).toBeGreaterThan(-1);
  expect(app).toBeGreaterThan(-1);
  // Assembly last: it moves dist-app, so a build after it would recreate an
  // orphan directory that never reaches the published output.
  expect(assemble).toBeGreaterThan(site);
  expect(assemble).toBeGreaterThan(app);
});
