# Demo Site and Spotlight Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare hosted demo with a one-page site that explains paddock — a pinned live phone that follows the copy, plus a spotlight tour you enter deliberately — hosted on Vercel.

**Architecture:** Two Vite builds assembled into one directory: a static landing page at the root, and today's demo app under `/app/`. The landing page drives the app through a same-origin iframe by setting its hash, and spotlights controls the app tags with `data-tour`. No component gains a demo branch.

**Tech Stack:** Bun, Vite, React 19, TypeScript, Tailwind v4, `bun test` with `@happy-dom/global-registrator`, GitHub Actions, Vercel CLI.

**Spec:** `docs/design/2026-08-31-demo-site-and-tour-design.md` — read it before Task 1. The plan argues from it and does not repeat its reasoning.

## Global Constraints

Every task's requirements implicitly include these. They are repository rules, not preferences.

- **This repository is public.** No real hostnames, home paths, usernames, or employer terms. Fixtures use invented agent names only — the existing demo seeds are `schema-migration`, `lint-config`, `api-refactor`, `perf-audit`, `docs-cleanup`, `flaky-test-fix`.
- **`make check-clean` before EVERY commit.** If it fails, fix the content; never add the string to the ignore list.
- **`make check` is `tsc --noEmit`.** There is no linter.
- **`make test` builds the UI first.** Never run bare `bun test` for a full-suite claim.
- **No demo branches in any component.** `data-tour` attributes are rendered unconditionally in all builds.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, then redefined under `prefers-color-scheme` and `[data-theme]`.
- **Respect `prefers-reduced-motion`** and `env(safe-area-inset-bottom)`.
- **Never swallow errors.** No `2>/dev/null`, no unconditional `exit 0`, no empty catch blocks.
- **File ids must match `/^[0-9a-f]{32}$/`** — `FILE_HASH_RE` in `src/shared/route.ts` rejects anything else, so a demo file id must be exactly 32 lowercase hex characters.
- **Site URL is `https://trypaddock.vercel.app`** — a placeholder pending operator confirmation. It appears in exactly one code constant (`src/shared/links.ts`) plus documentation; changing it later is a find-and-replace.

---

### Task 1: Split the build into site and app, and assemble them

**Files:**
- Create: `vite.site.config.ts`
- Create: `site/index.html`
- Create: `src/site/main.ts`
- Create: `scripts/assemble-site.ts`
- Modify: `package.json:8-13` (the `scripts` block)
- Test: `tests/site-build.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `assembleSite(opts: { siteDir: string; appDir: string; installScript: string }): void` from `scripts/assemble-site.ts`. Moves `appDir` to `${siteDir}/app` and copies `installScript` to `${siteDir}/install.sh`. Throws if either source is missing.

- [ ] **Step 1: Write the failing test**

Create `tests/site-build.test.ts`:

```ts
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

test("install.sh rides along, as demo.yml has always required", () => {
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/site-build.test.ts`
Expected: FAIL — `Cannot find module '../scripts/assemble-site'`.

- [ ] **Step 3: Write the assembly script**

Create `scripts/assemble-site.ts`:

```ts
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
```

- [ ] **Step 4: Add the site config and its entry**

Create `vite.site.config.ts`:

```ts
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
```

Create `site/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>paddock — watch and answer your coding agents from your phone</title>
  </head>
  <body>
    <main id="site"></main>
    <script type="module" src="../src/site/main.ts"></script>
  </body>
</html>
```

Note the `src` path. Vite resolves a leading `/` against `config.root`, which is
`site/` here — so `/src/site/main.ts` would look for `site/src/site/main.ts` and
fail the build. The entry is reached relatively, as `../src/site/main.ts`.

Create `src/site/main.ts`:

```ts
/** Filled in by Task 8. Present now so the build has an entry to compile. */
export {};
```

- [ ] **Step 5: Wire the scripts**

In `package.json`, replace the `build:demo` line with:

```json
    "build:site": "vite build -c vite.site.config.ts",
    "build:app": "VITE_PADDOCK_DEMO=1 vite build --base=/app/ --outDir dist-app",
    "build:demo": "bun run build:site && bun run build:app && bun run scripts/assemble-site.ts"
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/site-build.test.ts`
Expected: PASS, all seven.

- [ ] **Step 7: Prove the real build assembles**

Run: `bun run build:demo && ls dist-site dist-site/app/manifest.webmanifest dist-site/install.sh`
Expected: all three listed, no error. Then `rm -rf dist-site dist-app`.

- [ ] **Step 8: Typecheck, scan, commit**

```bash
make check && make check-clean
git add vite.site.config.ts site/index.html src/site/main.ts scripts/assemble-site.ts package.json tests/site-build.test.ts
git commit -m "build: split the demo into a site build and an app build under /app/"
```

---

### Task 2: Give the demo the file routes it never had

The hosted demo has no `/api/files` handling at all, so `#/file/:id` renders an error today. `FileViewer` loads bytes through `<iframe src>` — a browser navigation, which the monkeypatched `fetch` cannot intercept — so the metadata is mocked in `backend.ts` while the bytes must exist as a real static file.

**Files:**
- Modify: `src/web/demo/backend.ts` (add a branch beside the `/api/spaces` one, around line 210)
- Create: `site/public/api/files/a1b2c3d4e5f60718293a4b5c6d7e8f90/index.html` (the bytes)
- Create: `site/public/api/files/a1b2c3d4e5f60718293a4b5c6d7e8f90/download` — same bytes
- Test: `tests/demo-backend-files.test.ts`

**Interfaces:**
- Consumes: `assembleSite` from Task 1 (the static files ride in `site/public/`, which vite copies to `dist-site/`).
- Produces: the constant demo file id `a1b2c3d4e5f60718293a4b5c6d7e8f90` (32 lowercase hex, as `FILE_HASH_RE` requires), used by Task 6's step 04.

- [ ] **Step 1: Write the failing test**

Create `tests/demo-backend-files.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { fileIdFromHash } from "@shared/route";

/**
 * The second instance of one bug. `backend.ts` already records the first:
 * `/api/spaces` had no route, fell through to the agent regex, and answered
 * 404 — so the Spaces screen rendered an error on the hosted demo. `/api/files`
 * had no route either, and the file viewer renders an error there right now.
 *
 * Source-read rather than executed, for the reason demo-backend-spaces.test.ts
 * gives: importing backend.ts installs itself over the global `fetch` and takes
 * the process's networking with it.
 */
const src = readFileSync("src/web/demo/backend.ts", "utf8");

const DEMO_FILE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("the demo file id is one the router will actually accept", () => {
  // FILE_HASH_RE is /^#\/file\/([0-9a-f]{32})$/. An id that misses that shape
  // routes nowhere, and the screen never mounts to show the error.
  expect(fileIdFromHash(`#/file/${DEMO_FILE_ID}`)).toBe(DEMO_FILE_ID);
});

test("the demo answers /api/files/:id/meta", () => {
  expect(src, "the file viewer has no metadata and will error").toContain("/meta");
  expect(src).toContain("/api/files/");
});

test("the metadata names the file and its render mode", () => {
  const at = src.indexOf("/api/files/");
  const branch = src.slice(at, at + 900);
  expect(branch).toContain("render");
  expect(branch).toContain("name");
  // "iframe" is what makes FileViewer mount an <iframe src>, which is the whole
  // point of the step this serves.
  expect(branch).toContain('"iframe"');
});

test("the bytes exist as a real static file, because an iframe src is not a fetch", () => {
  // The demo backend replaces `fetch`. `<iframe src={fileUrl(id)}>` is a
  // browser navigation and never passes through it, so mocking the route would
  // leave a blank frame with a correct-looking header above it.
  const bytes = `site/public/api/files/${DEMO_FILE_ID}`;
  expect(existsSync(bytes), "the file viewer would show an empty frame").toBe(true);
});

test("the served page contains nothing from a real session", () => {
  // CLAUDE.md calls fixture content the rule most likely to be broken by
  // accident. This file is HTML and reads like a report, which is exactly the
  // sort of thing someone pastes a real one into.
  const html = readFileSync(`site/public/api/files/${DEMO_FILE_ID}`, "utf8");
  expect(html).toContain("api-refactor");
  expect(html).not.toMatch(/\/home\/|\/Users\/|@[\w.-]+\.\w+/);
});

test("a write to a file route is refused, not quietly resolved", () => {
  expect(src).toContain("const refuse = ()");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/demo-backend-files.test.ts`
Expected: FAIL — the `/api/files/` route and the static file are both absent.

- [ ] **Step 3: Add the metadata route**

In `src/web/demo/backend.ts`, immediately after the `/api/harnesses` line (currently line 241), insert:

```ts
  /**
   * The file viewer's metadata.
   *
   * It had no route at all, so `/api/files/...` fell through to the agent regex
   * below and answered 404 — the file viewer rendered an error on the hosted
   * demo, which is the same failure `/api/spaces` had above and for the same
   * reason.
   *
   * ONLY the metadata is answered here. `FileViewer` loads the bytes through
   * `<iframe src={fileUrl(id)}>`, and an iframe src is a browser navigation
   * that never passes through the `fetch` this module replaces. The bytes are a
   * real static file under `site/public/api/files/`; mocking them here would
   * leave a blank frame under a correct-looking header, which reads as a
   * product bug rather than a demo's limit.
   */
  if (/\/api\/files\/[0-9a-f]{32}\/meta$/.test(path)) {
    return json({ ok: true, name: "coverage-report.html", render: "iframe" });
  }
```

- [ ] **Step 4: Add the bytes**

`fileUrl(id)` is `/api/files/<id>` while `fileDownloadUrl(id)` is
`/api/files/<id>/download`, so `<id>` must be both a document and a folder. A
DIRECTORY with an `index.html` is the one shape that serves both — on Vercel and
on any local static server — with no rewrite rules to keep in sync, and the
`.html` extension gets the content type right for free.

Create `site/public/api/files/a1b2c3d4e5f60718293a4b5c6d7e8f90/index.html`. Every name and number in it is invented:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>coverage-report.html</title>
    <style>
      body { font: 15px/1.6 system-ui, sans-serif; margin: 0; padding: 20px; color: #1b1b1f; background: #fff; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      p.sub { margin: 0 0 18px; color: #6b6b76; font-size: 13px; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; }
      th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e6e6ea; }
      th { font-weight: 600; color: #6b6b76; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; }
      .ok { color: #1a7f37; } .warn { color: #9a6700; }
    </style>
  </head>
  <body>
    <h1>Coverage — api-refactor</h1>
    <p class="sub">Generated by the agent, opened on the phone.</p>
    <table>
      <tr><th>Module</th><th>Lines</th><th>Covered</th></tr>
      <tr><td>auth/middleware</td><td class="n">312</td><td class="n ok">96%</td></tr>
      <tr><td>auth/session</td><td class="n">188</td><td class="n ok">91%</td></tr>
      <tr><td>routes/upload</td><td class="n">241</td><td class="n warn">64%</td></tr>
      <tr><td>routes/health</td><td class="n">47</td><td class="n ok">100%</td></tr>
    </table>
  </body>
</html>
```

Copy it to `site/public/api/files/a1b2c3d4e5f60718293a4b5c6d7e8f90/download`. The viewer's header renders a Download link unconditionally, and a 404 behind a visible control is a dead control in a screenshot. The anchor's own `download={name}` attribute names the saved file, so no `content-disposition` header is needed.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/demo-backend-files.test.ts`
Expected: PASS, all six.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `make test`
Expected: PASS. `tests/demo-backend-spaces.test.ts` in particular still passes — the new branch sits after `/api/harnesses` and before the agent regex, so it changes no existing route's reachability.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/web/demo/backend.ts site/public/api tests/demo-backend-files.test.ts
git commit -m "fix: the hosted demo's file viewer renders a file instead of an error"
```

---

### Task 3: Publish to Vercel, and retire GitHub Pages

**Files:**
- Create: `vercel.json`
- Modify: `.github/workflows/demo.yml` (replace the Pages steps)
- Modify: `README.md` (lines 8, 51, 68, 72)
- Modify: `install.sh:6`
- Modify: `.github/ISSUE_TEMPLATE/config.yml:7`
- Modify: `docs/design/2026-08-18-distribution-and-update-design.md:11,155`
- Modify: `docs/plans/2026-08-18-distribution-and-update.md:667,1245,1250`
- Modify: `tests/demo-workflow.test.ts` (it asserts the Pages artifact shape)
- Test: `tests/site-deploy.test.ts`

**Interfaces:**
- Consumes: `build:demo` and `dist-site` from Task 1; the static file paths from Task 2.
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the failing test**

Create `tests/site-deploy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const wf = readFileSync(".github/workflows/demo.yml", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

/**
 * demo.yml states why its gates exist: "a demo that ships from a red tree would
 * be advertising something that does not work." Vercel's own Git integration
 * would build on push and bypass all three, so it stays off and the workflow
 * keeps publishing.
 */
test("the three gates still run before anything is published", () => {
  for (const gate of ["make check", "make check-clean", "make test"]) {
    expect(wf, `${gate} no longer gates the deploy`).toContain(gate);
  }
});

test("the gates run BEFORE the deploy, not beside it", () => {
  const test_ = wf.indexOf("make test");
  const deploy = wf.indexOf("vercel deploy");
  expect(deploy).toBeGreaterThan(-1);
  expect(deploy, "a deploy that races its own gates is not gated").toBeGreaterThan(test_);
});

test("the deploy publishes the assembled directory, prebuilt", () => {
  // --prebuilt, because the gates already built it. Letting Vercel rebuild
  // would run an ungated build and publish that instead.
  expect(wf).toContain("--prebuilt");
});

test("nothing in the repository still points at the retired host", () => {
  // The migration is all-or-nothing: a half-done one leaves an install command
  // that 404s in a README that otherwise reads correctly.
  const files = [
    "README.md",
    "install.sh",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/workflows/demo.yml",
    "docs/design/2026-08-18-distribution-and-update-design.md",
    "docs/plans/2026-08-18-distribution-and-update.md",
  ];
  for (const f of files) {
    expect(readFileSync(f, "utf8"), `${f} still points at the retired host`).not.toContain(
      "github.io",
    );
  }
});

test("the file routes are served as HTML, not downloaded as octet-stream", () => {
  // The static file has no extension, because fileUrl(id) has none. Without an
  // explicit content-type the host guesses, and the viewer's iframe renders a
  // download prompt or a blank frame.
  const rule = vercel.headers?.find((h) => h.source.includes("/api/files/"));
  expect(rule, "no content-type rule for the demo file routes").toBeDefined();
  const ct = rule!.headers.find((h) => h.key.toLowerCase() === "content-type");
  expect(ct?.value).toContain("text/html");
});

test("the served file carries the same sandbox header the real route sets", () => {
  // routes.ts sets `Content-Security-Policy: sandbox` on BOTH file routes and
  // explains why at length: without it an agent-authored page served here is
  // same-origin with paddock and can drive the operator's agents. The demo
  // mirrors production rather than modelling a weaker thing.
  const rule = vercel.headers?.find((h) => h.source.includes("/api/files/"));
  const csp = rule!.headers.find((h) => h.key.toLowerCase() === "content-security-policy");
  expect(csp?.value).toContain("sandbox");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/site-deploy.test.ts`
Expected: FAIL — `vercel.json` does not exist.

- [ ] **Step 3: Write `vercel.json`**

```json
{
  "buildCommand": "bun run build:demo",
  "outputDirectory": "dist-site",
  "headers": [
    {
      "source": "/api/files/(.*)",
      "headers": [
        { "key": "content-type", "value": "text/html; charset=utf-8" },
        { "key": "content-security-policy", "value": "sandbox" },
        { "key": "x-content-type-options", "value": "nosniff" }
      ]
    },
    {
      "source": "/install.sh",
      "headers": [{ "key": "content-type", "value": "text/plain; charset=utf-8" }]
    }
  ]
}
```

`buildCommand` is the repo's own build: `vercel build` runs it and writes `.vercel/output`, which `--prebuilt` then publishes. Turn the Git integration off in the project settings — that, not the config, is what stops an ungated build on push.

- [ ] **Step 4: Rewrite the workflow's publish half**

In `.github/workflows/demo.yml`, keep the `on`, `concurrency` and gate steps. Replace the `permissions` block, the `configure-pages`/`upload-pages-artifact` steps and the whole `deploy` job with:

```yaml
permissions:
  contents: read

# ... on/concurrency/jobs.build unchanged through `make test` ...

      - run: bun run build:demo

      # install.sh is copied by scripts/assemble-site.ts, which throws when it
      # is missing rather than publishing a site whose install command 404s.

      - name: Build with Vercel
        # `--prebuilt` publishes .vercel/output, which only `vercel build`
        # writes — deploying without it publishes nothing. vercel.json's
        # buildCommand is `bun run build:demo`, so this IS the site build and
        # the gates above have already passed by the time it runs.
        run: |
          bunx vercel@latest pull --yes --environment=production --token="$VERCEL_TOKEN"
          bunx vercel@latest build --prod --token="$VERCEL_TOKEN"

      - name: Deploy to Vercel
        run: bunx vercel@latest deploy --prebuilt --prod --token="$VERCEL_TOKEN"
```

Change the `concurrency.group` from `pages` to `vercel`, and delete the `environment:` block with it.

- [ ] **Step 5: Update `tests/demo-workflow.test.ts`**

It currently asserts `cp install.sh dist-demo/install.sh` and `path: dist-demo`, both of which have moved. Replace its two tests with one that keeps the guarantee at its new home:

```ts
test("install.sh reaches the published directory, or the build fails loudly", () => {
  // The copy moved into scripts/assemble-site.ts, which THROWS when the script
  // is missing. That is stronger than the old `cp`: a missing install.sh now
  // fails the build instead of publishing a site whose install command 404s
  // while every other page keeps working.
  const assemble = readFileSync("scripts/assemble-site.ts", "utf8");
  expect(assemble).toContain("install.sh");
  expect(assemble).toContain("throw new Error");
});
```

- [ ] **Step 6: Replace every retired URL**

Replace `https://lntvan166.github.io/paddock/` with `https://trypaddock.vercel.app/` throughout. In `README.md` the demo links (lines 8, 51) become `https://trypaddock.vercel.app/`, and the install lines (68, 72) become `https://trypaddock.vercel.app/install.sh`.

Run: `grep -rn "github.io" --include='*.md' --include='*.sh' --include='*.yml' --include='*.ts' . | grep -v node_modules | grep -v dist`
Expected: no output.

- [ ] **Step 7: Confirm the operator-side setup**

These cannot be done from the repository and must be reported to the operator, not assumed:
1. Create the Vercel project and **disable its Git integration**, so only the workflow deploys.
2. Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as repository secrets.
3. Confirm the project URL matches the `https://trypaddock.vercel.app` written into the files above.
4. **The install URL has changed** — it belongs in the next release notes. Every previously published release prints the retired one.

- [ ] **Step 8: Run everything, then commit**

```bash
make check && make check-clean && make test
git add vercel.json .github/workflows/demo.yml .github/ISSUE_TEMPLATE/config.yml README.md install.sh docs tests/site-deploy.test.ts tests/demo-workflow.test.ts
git commit -m "build: publish the demo to Vercel and retire the Pages site"
```

---

### Task 4: Tag the tour's anchors, and make them a contract

**Files:**
- Create: `src/shared/tour-anchors.ts`
- Modify: `src/web/components/Dashboard.tsx:117` (the `<section key={key}>`)
- Modify: `src/web/components/AskDialogView.tsx:129` (`.dialog-options`)
- Modify: `src/web/components/AgentTerminal.tsx:1068` (`.term-reply-field`)
- Modify: `src/web/components/FileViewer.tsx` (`.file-frame`)
- Modify: `src/web/components/Spaces.tsx:186` (`<ul className="spaces">`)
- Modify: `src/web/components/settings/DeviceSection.tsx:34` (the theme `<select>`)
- Test: `tests/tour-anchors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const TOUR_ANCHORS = ["needs-you", "answer-options", "reply-field", "file-frame", "space-tree", "theme-picker"] as const;` and `export type TourAnchor = (typeof TOUR_ANCHORS)[number];` from `src/shared/tour-anchors.ts`. Task 6's steps are typed against `TourAnchor`.

- [ ] **Step 1: Write the failing test**

Create `tests/tour-anchors.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { TOUR_ANCHORS } from "@shared/tour-anchors";

/**
 * The tour points at controls it does not own. Without this test a renamed
 * class or a restructured component leaves an arrow pointing at empty space —
 * on the one page people look at paddock without running it, and with nothing
 * in the suite able to notice.
 *
 * Static, deliberately: the alternative is booting the app in happy-dom and
 * navigating to six screens, which tests the harness more than the contract.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const web = sources("src/web").map((p) => readFileSync(p, "utf8")).join("\n");

/**
 * The anchor names actually rendered.
 *
 * `[^"]*` between the attribute and the value because one of these is a
 * ternary — `data-tour={key === "needs-you" ? ...}` — and a literal
 * `data-tour="` match would silently miss it, which is exactly the undercount
 * this file exists to prevent.
 */
const rendered = new Set([...web.matchAll(/data-tour[^"]*"([a-z-]+)"/g)].map((m) => m[1]!));

test("every anchor the tour names exists in the app", () => {
  for (const a of TOUR_ANCHORS) {
    expect([...rendered], `no component renders data-tour="${a}"`).toContain(a);
  }
});

test("every data-tour in the app is one the tour knows about", () => {
  // The other direction. An orphan attribute is dead weight in the operator's
  // bundle and a hint that a step was deleted without its anchor.
  expect(rendered.size, "the anchor scan found nothing to check").toBeGreaterThan(0);
  for (const f of rendered) {
    expect(TOUR_ANCHORS as readonly string[], `data-tour="${f}" matches no step`).toContain(f);
  }
});

test("the anchors are unconditional, not branched on the demo flag", () => {
  // demo.yml states the property that keeps the demo honest: "there are no demo
  // branches in any component." An attribute behind import.meta.env would be
  // exactly such a branch, and would also mean the anchors are absent from the
  // build anyone could ever debug.
  for (const p of sources("src/web")) {
    const s = readFileSync(p, "utf8");
    if (!s.includes("data-tour")) continue;
    for (const line of s.split("\n")) {
      if (!line.includes("data-tour")) continue;
      expect(line, `${p}: data-tour is conditional on the demo flag`).not.toContain(
        "VITE_PADDOCK_DEMO",
      );
    }
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/tour-anchors.test.ts`
Expected: FAIL — `Cannot find module '@shared/tour-anchors'`.

- [ ] **Step 3: Declare the anchors**

Create `src/shared/tour-anchors.ts`:

```ts
/**
 * The controls the site's tour points at.
 *
 * In `shared/` rather than `web/` because BOTH sides need it: the app renders
 * the attributes, and the site's tour queries them across an iframe boundary.
 * A second copy would be a contract with itself.
 *
 * The attributes are rendered UNCONDITIONALLY, in every build. `demo.yml`
 * states the property that keeps the demo honest — "there are no demo branches
 * in any component" — and a conditional attribute would be exactly such a
 * branch. A static string of a few dozen bytes has no code path to drift.
 */
export const TOUR_ANCHORS = [
  "needs-you",
  "answer-options",
  "reply-field",
  "file-frame",
  "space-tree",
  "theme-picker",
] as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[number];
```

- [ ] **Step 4: Add the six attributes**

`src/web/components/Dashboard.tsx` — the section wrapper at line 117:

```tsx
              <section key={key} data-tour={key === "needs-you" ? "needs-you" : undefined}>
```

`src/web/components/AskDialogView.tsx` line 129:

```tsx
      <div className="dialog-options" role="group" aria-label="Answer" data-mode={dialog.mode} data-tour="answer-options">
```

`src/web/components/AgentTerminal.tsx` line 1068 — add `data-tour="reply-field"` to the element already carrying `className="term-reply-field"`.

`src/web/components/FileViewer.tsx` — the iframe in `FileViewer`:

```tsx
          <iframe
            className="file-frame"
            src={fileUrl(id)}
            sandbox=""
            title={name}
            data-tour="file-frame"
          />
```

`src/web/components/Spaces.tsx` line 186:

```tsx
      <ul className="spaces" data-tour="space-tree">
```

`src/web/components/settings/DeviceSection.tsx` line 34 — add `data-tour="theme-picker"` to the `<select>` already carrying `data-field="theme"`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/tour-anchors.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Confirm no screen changed**

Run: `make test`
Expected: PASS. These are inert attributes; any failure here is a real regression, not a snapshot to update.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/shared/tour-anchors.ts src/web/components tests/tour-anchors.test.ts
git commit -m "feat: tag the six controls the site's tour points at"
```

---

### Task 5: Tour tokens, and the contrast test that guards them

**Files:**
- Modify: `src/web/styles.css` (the bare `:root` block, its `prefers-color-scheme` block, and each `:root[data-theme="…"]` block)
- Modify: `tests/themes.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--tour-scrim`, `--tour-panel`, `--tour-text`, `--tour-accent`. Task 7's overlay styles reference them by these exact names.

- [ ] **Step 1: Write the failing test**

Append to `tests/themes.test.ts`, reusing its existing `ratio`, `AA`, `baseTokens`, `blockFor` and `THEMES`:

```ts
/**
 * The tour overlay lays down its OWN dark ground and then writes on it. Callout
 * text checked against the theme's background is checked against a colour that
 * is nowhere on screen while the tour is open — so a theme could pass every
 * assertion above and still be unreadable for the whole tour.
 *
 * `--tour-panel` is the ground here, not `--tour-scrim`: the scrim is
 * translucent over the page, while the callout sits on an opaque panel.
 */
const TOUR_TOKENS = ["--tour-scrim", "--tour-panel", "--tour-text", "--tour-accent"];

test("the tour tokens are defined on bare :root, not only in a media query", () => {
  // The house rule, and the reason for it: a token defined only under
  // prefers-color-scheme is undefined for a manual toggle in the other
  // direction, and an undefined colour renders as transparent or inherited.
  const base = baseTokens();
  for (const t of TOUR_TOKENS) {
    expect(base[t], `${t} is missing from the bare :root palette`).toBeDefined();
  }
});

for (const t of THEMES.filter((x) => !NO_BLOCK.has(x.id))) {
  test(`tour callout text stays AA on ${t.id}`, () => {
    const base = baseTokens();
    const own = blockFor(`:root[data-theme="${t.id}"]`) ?? {};
    // A theme may retune these; if it does not, it inherits the base pair. Both
    // paths must be legible, which is the case the inherited state colours
    // above already prove is easy to miss.
    const panel = own["--tour-panel"] ?? base["--tour-panel"]!;
    const text = own["--tour-text"] ?? base["--tour-text"]!;
    expect(ratio(text, panel)).toBeGreaterThanOrEqual(AA);
  });

  test(`tour accent stays AA on ${t.id}`, () => {
    const base = baseTokens();
    const own = blockFor(`:root[data-theme="${t.id}"]`) ?? {};
    const panel = own["--tour-panel"] ?? base["--tour-panel"]!;
    const accent = own["--tour-accent"] ?? base["--tour-accent"]!;
    expect(ratio(accent, panel)).toBeGreaterThanOrEqual(AA);
  });
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/themes.test.ts`
Expected: FAIL — `--tour-panel` is undefined in the bare `:root` palette.

- [ ] **Step 3: Define the tokens**

In `src/web/styles.css`, inside the bare `:root { … }` block:

```css
  /* The tour overlay's own ground. Defined here, on bare :root, because a
     colour defined only inside a media query is undefined for a manual toggle
     in the other direction — and an undefined colour is not a fallback, it is
     transparent.

     The panel is opaque and the scrim is not: the scrim dims the page, the
     panel is what callout text is actually read against. tests/themes.test.ts
     measures against the panel for that reason. */
  --tour-scrim: rgb(6 7 9 / 0.86);
  --tour-panel: #14161a;
  --tour-text: #f2f3f5;
  --tour-accent: #8ab4ff;
```

The tour presents the same dark surface in every theme — it is chrome, not content, and `CLAUDE.md`'s rule is that a theme changes hue and never meaning. So no `:root[data-theme="…"]` block needs to override these; the test's inheritance path is the one that runs. Add a matching set under the existing `prefers-color-scheme: dark` guard **only if** a value must change there — it does not, so leave that block alone and let the tokens inherit.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/themes.test.ts`
Expected: PASS. `ratio("#f2f3f5", "#14161a")` is roughly 14.9 and `ratio("#8ab4ff", "#14161a")` roughly 8.0 — both well clear of 4.5. If either fails, lighten the text or darken the panel; do not lower `AA`.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/web/styles.css tests/themes.test.ts
git commit -m "feat: tour overlay tokens, checked for AA against their own ground"
```

---

### Task 6: The tour engine

Pure logic, no DOM. Which step is current, what advances it, when `show me` appears.

**Files:**
- Create: `src/site/tour/steps.ts`
- Create: `src/site/tour/engine.ts`
- Test: `tests/tour-engine.test.ts`

**Interfaces:**
- Consumes: `TourAnchor` from `src/shared/tour-anchors.ts` (Task 4); the demo file id `a1b2c3d4e5f60718293a4b5c6d7e8f90` (Task 2).
- Produces:
  - `TOUR_STEPS: readonly TourStep[]` from `steps.ts`, where
    `type TourStep = { anchor: TourAnchor; hash: string; title: string; body: string; advance: "click" | "hash" }`.
  - `createTour(opts: { steps: readonly TourStep[]; onStep: (s: TourStep, i: number) => void; onEnd: () => void; hintAfterMs?: number }): Tour` from `engine.ts`, where
    `type Tour = { start(): void; index(): number; current(): TourStep | null; satisfy(anchor: string): void; hintVisible(): boolean; tick(nowMs: number): void; showMe(): void; skip(): void; }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tour-engine.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createTour, type Tour } from "@site/tour/engine";
import { TOUR_STEPS } from "@site/tour/steps";
import { TOUR_ANCHORS } from "@shared/tour-anchors";

const steps = [
  { anchor: "needs-you", hash: "#/", title: "one", body: "b", advance: "click" },
  { anchor: "answer-options", hash: "#/pane/x", title: "two", body: "b", advance: "click" },
] as const;

function tour(over: Partial<Parameters<typeof createTour>[0]> = {}) {
  const seen: number[] = [];
  let ended = false;
  const t: Tour = createTour({
    steps,
    onStep: (_s, i) => seen.push(i),
    onEnd: () => { ended = true; },
    hintAfterMs: 3000,
    ...over,
  });
  return { t, seen, ended: () => ended };
}

test("a step advances on the real action, not on being asked nicely", () => {
  const { t, seen } = tour();
  t.start();
  expect(seen).toEqual([0]);
  t.satisfy("answer-options");           // the wrong anchor
  expect(t.index(), "an unrelated click advanced the tour").toBe(0);
  t.satisfy("needs-you");
  expect(t.index()).toBe(1);
  expect(seen).toEqual([0, 1]);
});

test("the tour ends after the last step, once", () => {
  const { t, ended } = tour();
  t.start();
  t.satisfy("needs-you");
  t.satisfy("answer-options");
  expect(ended()).toBe(true);
  expect(t.current()).toBeNull();
});

test("show me appears only after the idle window, and only if nothing happened", () => {
  // A hint that appears instantly reads as an instruction to press it, which
  // makes the tour a slideshow again. One that never appears traps a visitor
  // hunting for a control they cannot find.
  const { t } = tour();
  t.start();
  t.tick(0);
  expect(t.hintVisible()).toBe(false);
  t.tick(2999);
  expect(t.hintVisible()).toBe(false);
  t.tick(3000);
  expect(t.hintVisible()).toBe(true);
});

test("the idle window restarts on each step", () => {
  const { t } = tour();
  t.start();
  t.tick(0);
  t.tick(3000);
  expect(t.hintVisible()).toBe(true);
  t.satisfy("needs-you");
  // A hint carried across a step boundary would appear immediately on step two,
  // before the visitor has had any chance to act.
  expect(t.hintVisible()).toBe(false);
});

test("show me satisfies the current step", () => {
  const { t } = tour();
  t.start();
  t.showMe();
  expect(t.index()).toBe(1);
});

test("skip ends the tour wherever it is", () => {
  const { t, ended } = tour();
  t.start();
  expect(ended()).toBe(false);
  t.skip();
  expect(ended()).toBe(true);
  // And a late event cannot resurrect it.
  t.satisfy("needs-you");
  expect(t.current()).toBeNull();
});

test("every real step names an anchor the app actually renders", () => {
  for (const s of TOUR_STEPS) {
    expect(TOUR_ANCHORS as readonly string[]).toContain(s.anchor);
  }
});

test("the real steps cover all six anchors, in reading order", () => {
  expect(TOUR_STEPS.map((s) => s.anchor)).toEqual([...TOUR_ANCHORS]);
});

test("the file step addresses an id the router accepts", () => {
  const file = TOUR_STEPS.find((s) => s.anchor === "file-frame")!;
  expect(file.hash).toMatch(/^#\/file\/[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Add the `@site` alias so tests can import it**

In `tsconfig.json`'s `compilerOptions.paths`, beside the existing `@web/*` and `@shared/*` entries, add:

```json
      "@site/*": ["./src/site/*"]
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test tests/tour-engine.test.ts`
Expected: FAIL — `Cannot find module '@site/tour/engine'`.

- [ ] **Step 4: Write the steps**

Create `src/site/tour/steps.ts`:

```ts
import type { TourAnchor } from "@shared/tour-anchors";

export type TourStep = {
  anchor: TourAnchor;
  /** The demo's hash for this step. Routing is hash-only, so this is the whole
   *  of "navigate the app" — see src/web/route.ts. */
  hash: string;
  title: string;
  body: string;
  /** What counts as done. `click` is a tap inside the anchor; `hash` is the app
   *  having navigated itself, for steps whose action IS the navigation. */
  advance: "click" | "hash";
};

/** Invented, like every other fixture here. See CLAUDE.md. */
const BLOCKED_AGENT = "d1%3Ap1";
const DEMO_FILE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    anchor: "needs-you",
    hash: "#/",
    title: "Grouped by what wants you",
    body: "Not alphabetically. Agents that have stopped and need an answer sit at the top, so triage is a glance rather than a search. Tap the one that needs you.",
    advance: "click",
  },
  {
    anchor: "answer-options",
    hash: `#/pane/${BLOCKED_AGENT}`,
    title: "Its own words, not a guess",
    body: "These are the agent's real option labels, read from its screen — never invented. The row Enter would commit is named before you tap it. Choose one.",
    advance: "click",
  },
  {
    anchor: "reply-field",
    hash: `#/pane/${BLOCKED_AGENT}`,
    title: "Or answer properly",
    body: "A field that grows to what you wrote, with slash-commands read from the project's own .claude — and a screenshot attached by pasting it. Tap to start typing.",
    advance: "click",
  },
  {
    anchor: "file-frame",
    hash: `#/file/${DEMO_FILE}`,
    title: "Open what it made",
    body: "Tap a path in the output and the page, PDF or image opens here — sandboxed twice, so a page an agent wrote can never reach paddock's own API.",
    advance: "hash",
  },
  {
    anchor: "space-tree",
    hash: "#/spaces",
    title: "Every space, every tab",
    body: "The whole herd, not just the agents that happen to be busy. Rename, close, or start something new from here.",
    advance: "hash",
  },
  {
    anchor: "theme-picker",
    hash: "#/settings",
    title: "Five themes, all legible",
    body: "paddock's own light and dark, plus Dracula, Gruvbox and Nord — each checked against WCAG AA, including the state colours. Red always means an agent has stopped.",
    advance: "hash",
  },
];
```

- [ ] **Step 5: Write the engine**

Create `src/site/tour/engine.ts`:

```ts
import type { TourStep } from "@site/tour/steps";

export type Tour = {
  start(): void;
  index(): number;
  current(): TourStep | null;
  /** The real event happened on this anchor. Ignored unless it is the one the
   *  current step is waiting for. */
  satisfy(anchor: string): void;
  hintVisible(): boolean;
  /** Monotonic milliseconds. Passed in rather than read, so the idle window is
   *  testable without waiting three seconds. */
  tick(nowMs: number): void;
  showMe(): void;
  skip(): void;
};

/**
 * Which step is current, and what moves it on.
 *
 * Steps advance on the REAL event — a tap inside the anchor, or the app having
 * navigated — never on a Next button. That is the difference between a tour and
 * a slideshow, and it also puts the visitor on a USED screen at every step,
 * which `CLAUDE.md` records as the state paddock's own controls have shipped
 * bugs in.
 *
 * Nothing here ever blocks. A hard gate is right inside an app somebody has
 * installed and wrong on a public page somebody is still evaluating, so `show
 * me` appears after an idle window and does the action for them.
 *
 * No DOM, no timers of its own: the caller owns both. This file is the part
 * worth testing, and it is testable without a browser.
 */
export function createTour(opts: {
  steps: readonly TourStep[];
  onStep: (step: TourStep, index: number) => void;
  onEnd: () => void;
  hintAfterMs?: number;
}): Tour {
  const hintAfterMs = opts.hintAfterMs ?? 3000;
  let i = -1;
  let done = false;
  let stepStartedAt: number | null = null;
  let hint = false;

  const enter = (next: number): void => {
    i = next;
    if (i >= opts.steps.length) {
      done = true;
      opts.onEnd();
      return;
    }
    // Reset both, or a hint earned on the previous step appears instantly on
    // this one — before the visitor has had any chance to act.
    stepStartedAt = null;
    hint = false;
    opts.onStep(opts.steps[i]!, i);
  };

  const advance = (): void => {
    if (done || i < 0) return;
    enter(i + 1);
  };

  return {
    start: () => { if (!done && i < 0) enter(0); },
    index: () => i,
    current: () => (done || i < 0 ? null : (opts.steps[i] ?? null)),
    satisfy: (anchor: string) => {
      if (done || i < 0) return;
      if (opts.steps[i]!.anchor !== anchor) return;
      advance();
    },
    hintVisible: () => hint,
    tick: (nowMs: number) => {
      if (done || i < 0) return;
      if (stepStartedAt === null) { stepStartedAt = nowMs; return; }
      if (nowMs - stepStartedAt >= hintAfterMs) hint = true;
    },
    showMe: advance,
    skip: () => {
      if (done) return;
      done = true;
      i = -1;
      opts.onEnd();
    },
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/tour-engine.test.ts`
Expected: PASS, all nine.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add src/site/tour tsconfig.json tests/tour-engine.test.ts
git commit -m "feat: the tour's step machine, advancing on real events"
```

---

### Task 7: The spotlight overlay, measured after the repaint

**Files:**
- Create: `src/site/tour/spotlight.ts`
- Create: `src/site/tour/overlay.css`
- Test: `tests/tour-spotlight.test.ts`

**Interfaces:**
- Consumes: `TourStep` from Task 6; the `--tour-*` tokens from Task 5; `data-tour` attributes from Task 4.
- Produces:
  - `awaitAnchor(doc: Document, anchor: string, opts?: { timeoutMs?: number }): Promise<HTMLElement>` — resolves once the element exists, rejects on timeout.
  - `spotlightRect(el: HTMLElement, frame: HTMLIFrameElement, pad?: number): { x: number; y: number; width: number; height: number }` — the element's rectangle in the OUTER page's coordinates.

- [ ] **Step 1: Write the failing test**

Create `tests/tour-spotlight.test.ts`:

```ts
import "./support/dom";

import { expect, test } from "bun:test";
import { awaitAnchor, spotlightRect } from "@site/tour/spotlight";

/**
 * The highest-risk defect in this feature, and a browser restatement of one
 * CLAUDE.md already records for TUIs: "send-keys a b c measures the later keys
 * against the frame before the earlier ones landed."
 *
 * Set the hash and measure in the same tick and the spotlight is positioned
 * against the PREVIOUS screen's layout. It looks right on a development machine
 * and wrong on a phone, which is the only device that matters here.
 */
test("awaitAnchor waits for an element that is not there yet", async () => {
  const doc = document.implementation.createHTMLDocument("t");
  const pending = awaitAnchor(doc, "space-tree", { timeoutMs: 500 });

  // Appears a tick later, exactly as it would after a hash change repaints.
  queueMicrotask(() => {
    const el = doc.createElement("ul");
    el.setAttribute("data-tour", "space-tree");
    doc.body.appendChild(el);
  });

  const found = await pending;
  expect(found.getAttribute("data-tour")).toBe("space-tree");
});

test("awaitAnchor rejects rather than resolving with nothing", async () => {
  // A silent resolution here paints a spotlight at 0,0 over the corner of the
  // page, which reads as a rendering bug rather than a missing anchor.
  const doc = document.implementation.createHTMLDocument("t");
  await expect(awaitAnchor(doc, "never", { timeoutMs: 30 })).rejects.toThrow(/never/);
});

test("awaitAnchor finds an anchor that is already there", async () => {
  const doc = document.implementation.createHTMLDocument("t");
  const el = doc.createElement("div");
  el.setAttribute("data-tour", "needs-you");
  doc.body.appendChild(el);
  expect(await awaitAnchor(doc, "needs-you", { timeoutMs: 30 })).toBe(el);
});

test("the rect is translated into the outer page's coordinates", () => {
  // The anchor's own rect is relative to the iframe's document. Painted without
  // the frame's offset, the spotlight lands in the top-left of the page instead
  // of over the phone.
  const el = { getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }) };
  const frame = { getBoundingClientRect: () => ({ x: 300, y: 80, width: 390, height: 780 }) };
  const r = spotlightRect(el as unknown as HTMLElement, frame as unknown as HTMLIFrameElement, 0);
  expect(r).toEqual({ x: 310, y: 100, width: 100, height: 40 });
});

test("padding grows the hole around the control, not just below it", () => {
  const el = { getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }) };
  const frame = { getBoundingClientRect: () => ({ x: 0, y: 0, width: 390, height: 780 }) };
  const r = spotlightRect(el as unknown as HTMLElement, frame as unknown as HTMLIFrameElement, 6);
  expect(r).toEqual({ x: 4, y: 14, width: 112, height: 52 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/tour-spotlight.test.ts`
Expected: FAIL — `Cannot find module '@site/tour/spotlight'`.

- [ ] **Step 3: Write the spotlight geometry**

Create `src/site/tour/spotlight.ts`:

```ts
/**
 * Where the hole goes.
 *
 * Two functions rather than one, because they fail differently: the anchor may
 * not exist yet (a repaint has not landed), or it may exist and be measured
 * against the wrong origin (an iframe's document has its own coordinate space).
 * The first is a race; the second is arithmetic.
 */

/**
 * Resolve once the anchor is in the document.
 *
 * NEVER measure across a repaint. Setting the hash and reading a rect in the
 * same tick measures the PREVIOUS screen — the browser sibling of the TUI rule
 * in CLAUDE.md, where `send-keys a b c` measured later keys against a frame the
 * earlier ones had not reached yet. Two entries in a measured-behaviour table
 * were wrong that way and both reached shipped code.
 *
 * Rejects on timeout rather than resolving with null: a spotlight painted over
 * nothing reads as a rendering bug, and the caller can say what is wrong.
 */
export function awaitAnchor(
  doc: Document,
  anchor: string,
  opts: { timeoutMs?: number } = {},
): Promise<HTMLElement> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const sel = `[data-tour="${anchor}"]`;

  const present = doc.querySelector(sel);
  if (present) return Promise.resolve(present as HTMLElement);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      fn();
    };

    const observer = new (doc.defaultView ?? globalThis).MutationObserver(() => {
      const el = doc.querySelector(sel);
      if (el) finish(() => resolve(el as HTMLElement));
    });
    observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`tour: anchor "${anchor}" never appeared`)));
    }, timeoutMs);
  });
}

/**
 * The anchor's rectangle in the OUTER page's coordinates.
 *
 * `getBoundingClientRect` inside an iframe is relative to that frame's own
 * viewport. Painted without the frame's offset the hole lands in the corner of
 * the page rather than over the phone — which looks like a broken overlay, not
 * a wrong coordinate space.
 */
export function spotlightRect(
  el: HTMLElement,
  frame: HTMLIFrameElement,
  pad = 6,
): { x: number; y: number; width: number; height: number } {
  const a = el.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  return {
    x: f.x + a.x - pad,
    y: f.y + a.y - pad,
    width: a.width + pad * 2,
    height: a.height + pad * 2,
  };
}
```

- [ ] **Step 4: Write the overlay stylesheet**

Create `src/site/tour/overlay.css`:

```css
/* The scrim is one element with a very large spread shadow and a transparent
   middle: the "hole" is the element itself, and everything outside it is
   darkened by the shadow. One box to move, and it clips nothing. */
.tour-scrim {
  position: fixed;
  inset: 0;
  z-index: 90;
  pointer-events: auto;
  background: var(--tour-scrim);
}

.tour-hole {
  position: fixed;
  z-index: 91;
  border-radius: 10px;
  box-shadow: 0 0 0 9999px var(--tour-scrim);
  outline: 2px solid var(--tour-accent);
  /* The hole must not eat the tap the step is waiting for. */
  pointer-events: none;
  transition: all 180ms ease;
}

.tour-callout {
  position: fixed;
  z-index: 92;
  max-width: 34ch;
  padding: 14px 16px calc(14px + env(safe-area-inset-bottom));
  border-radius: 12px;
  background: var(--tour-panel);
  color: var(--tour-text);
}

.tour-callout h3 { margin: 0 0 6px; font-size: 15px; color: var(--tour-accent); }
.tour-callout p { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }

/* The connector from callout to hole. Drawn, not implied. */
.tour-line { position: fixed; z-index: 91; pointer-events: none; stroke: var(--tour-accent); }

/* Below the breakpoint there is no space outside the bezel, so the callout
   docks to the bottom of the screen and the connector shortens. Same engine,
   same tokens, reflowed. */
@media (max-width: 999px) {
  .tour-callout { left: 12px; right: 12px; bottom: 12px; max-width: none; }
}

@media (prefers-reduced-motion: reduce) {
  /* The spotlight cuts between steps rather than sliding. A travelling hole is
     the single most motion-heavy thing on the page. */
  .tour-hole { transition: none; }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/tour-spotlight.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean
git add src/site/tour/spotlight.ts src/site/tour/overlay.css tests/tour-spotlight.test.ts
git commit -m "feat: spotlight geometry that waits for the repaint before measuring"
```

---

### Task 8: The landing page — sticky phone, sections, and the tour wired up

**Files:**
- Modify: `src/site/main.ts` (replace the stub)
- Create: `src/site/page.ts`
- Create: `src/site/styles.css`
- Modify: `site/index.html` (add the stylesheet link)
- Test: `tests/site-page.test.ts`

**Interfaces:**
- Consumes: `createTour` and `TOUR_STEPS` (Task 6); `awaitAnchor`, `spotlightRect` (Task 7); the assembled `/app/` path (Task 1).
- Produces: `SECTIONS: readonly { anchor: TourAnchor; heading: string; body: string }[]` from `page.ts`, and `sectionForScroll(entries: { anchor: string; ratio: number }[]): string | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/site-page.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { SECTIONS, sectionForScroll } from "@site/page";
import { TOUR_STEPS } from "@site/tour/steps";

test("every section pairs with a tour step, so the phone always has a screen", () => {
  expect(SECTIONS.map((s) => s.anchor)).toEqual(TOUR_STEPS.map((s) => s.anchor));
});

test("the most-visible section wins, not the first one intersecting", () => {
  // Two sections are on screen at once for most of a scroll. Picking the first
  // means the phone changes a screen early and the copy beside it disagrees.
  expect(
    sectionForScroll([
      { anchor: "needs-you", ratio: 0.2 },
      { anchor: "answer-options", ratio: 0.8 },
    ]),
  ).toBe("answer-options");
});

test("nothing on screen drives nothing", () => {
  expect(sectionForScroll([])).toBeNull();
  expect(sectionForScroll([{ anchor: "needs-you", ratio: 0 }])).toBeNull();
});

const main = readFileSync("src/site/main.ts", "utf8");

test("the demo is embedded from /app/, the path the build assembles", () => {
  expect(main).toContain("/app/");
});

test("the site never imports a dashboard component", () => {
  // vite.site.config.ts has no React plugin and no @web alias, so this would
  // fail the build — but it would fail it confusingly, and the reason belongs
  // in a test that says it.
  const site = ["src/site/main.ts", "src/site/page.ts", "src/site/tour/steps.ts", "src/site/tour/engine.ts", "src/site/tour/spotlight.ts"];
  for (const f of site) {
    expect(readFileSync(f, "utf8"), `${f} pulls the app bundle into the landing page`).not.toContain("@web/");
  }
});

test("scroll is locked while the tour runs", () => {
  // The hole is registered to the frame's on-screen position, so scrolling
  // behind the scrim desynchronises it from what it is pointing at.
  expect(main).toContain("overflow");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/site-page.test.ts`
Expected: FAIL — `Cannot find module '@site/page'`.

- [ ] **Step 3: Write the section content**

Create `src/site/page.ts`:

```ts
import type { TourAnchor } from "@shared/tour-anchors";

export type Section = { anchor: TourAnchor; heading: string; body: string };

/**
 * One section per tour step, in the same order and pinned to it by a test.
 *
 * The copy is the README's argument, which is already the right one and already
 * checked for public-repo safety. A second, freely-written set of claims here
 * would be a second thing to keep true.
 */
export const SECTIONS: readonly Section[] = [
  {
    anchor: "needs-you",
    heading: "Triage, not a list",
    body: "Agents are grouped into needs you, working and idle — never alphabetically. The ones that have stopped sit at the top, because those are the only ones your walking back to the desk would fix.",
  },
  {
    anchor: "answer-options",
    heading: "Answer with its own words",
    body: "A blocked agent's options are read from its screen and shown with their real labels, and the row Enter would commit is named before you tap it. A mislabelled Approve button is worse than no button.",
  },
  {
    anchor: "reply-field",
    heading: "Or reply properly",
    body: "A field that grows to what you wrote, slash-command autocomplete read from the project's own .claude, and a screenshot attached by pasting it.",
  },
  {
    anchor: "file-frame",
    heading: "Open what an agent made",
    body: "Tap a path in the output to read an HTML page, a PDF or an image on the phone, or download it — sandboxed twice, so a page an agent wrote can never reach paddock's own API.",
  },
  {
    anchor: "space-tree",
    heading: "The whole herd",
    body: "Every space and every tab, not only the agents that happen to be busy. Rename, close, or start something new from the phone.",
  },
  {
    anchor: "theme-picker",
    heading: "Pick a theme",
    body: "paddock's own light and dark, plus Dracula, Gruvbox and Nord — every one checked against WCAG AA, including the state colours. Red always means an agent has stopped and needs you.",
  },
];

/**
 * Which section the phone should follow.
 *
 * The MOST VISIBLE one, not the first intersecting one: two sections share the
 * viewport for most of a scroll, and taking the first changes the phone's
 * screen while the copy beside it still describes the previous one.
 */
export function sectionForScroll(entries: { anchor: string; ratio: number }[]): string | null {
  let best: { anchor: string; ratio: number } | null = null;
  for (const e of entries) {
    if (e.ratio <= 0) continue;
    if (best === null || e.ratio > best.ratio) best = e;
  }
  return best?.anchor ?? null;
}
```

- [ ] **Step 4: Write the page**

Replace `src/site/main.ts`. It renders the hero, the sections and the sticky phone; wires an `IntersectionObserver` to `sectionForScroll`; and mounts the tour on the "take the tour" button.

```ts
import "./styles.css";
import "./tour/overlay.css";
import { SECTIONS, sectionForScroll } from "@site/page";
import { createTour } from "@site/tour/engine";
import { TOUR_STEPS } from "@site/tour/steps";
import { awaitAnchor, spotlightRect } from "@site/tour/spotlight";

const APP_SRC = "/app/";
const root = document.getElementById("site")!;

root.innerHTML = `
  <header class="hero">
    <h1>paddock</h1>
    <p class="lede">Watch and answer your coding agents from your phone.</p>
    <p class="install"><code>curl -fsSL https://trypaddock.vercel.app/install.sh | sh</code></p>
    <button type="button" class="tour-start">Take the tour</button>
  </header>
  <div class="split">
    <div class="copy">
      ${SECTIONS.map(
        (s, i) => `<section class="sec" data-section="${s.anchor}">
          <span class="num">0${i + 1}</span>
          <h2>${s.heading}</h2>
          <p>${s.body}</p>
        </section>`,
      ).join("")}
    </div>
    <div class="phone-rail">
      <div class="phone"><iframe class="demo" src="${APP_SRC}" title="paddock demo"></iframe></div>
    </div>
  </div>
`;

const frame = root.querySelector<HTMLIFrameElement>(".demo")!;
const stepFor = (anchor: string) => TOUR_STEPS.find((s) => s.anchor === anchor);

/** Hash-only routing means this is the whole of "drive the demo". */
function goto(hash: string): void {
  if (frame.contentWindow) frame.contentWindow.location.hash = hash;
}

// --- gear one: the phone follows the copy -----------------------------------
let following = true;
frame.addEventListener("mouseenter", () => { following = false; });
frame.addEventListener("touchstart", () => { following = false; }, { passive: true });

const ratios = new Map<string, number>();
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      ratios.set((e.target as HTMLElement).dataset.section!, e.intersectionRatio);
    }
    if (!following) return;
    const anchor = sectionForScroll([...ratios].map(([a, ratio]) => ({ anchor: a, ratio })));
    const step = anchor ? stepFor(anchor) : undefined;
    if (step) goto(step.hash);
  },
  { threshold: [0, 0.25, 0.5, 0.75, 1] },
);
for (const el of root.querySelectorAll(".sec")) observer.observe(el);
// Scrolling to a new section resumes following after a visitor has explored.
addEventListener("scroll", () => { following = true; }, { passive: true });

// --- gear two: the tour -----------------------------------------------------
const scrim = document.createElement("div");
const hole = document.createElement("div");
const callout = document.createElement("div");
scrim.className = "tour-scrim";
hole.className = "tour-hole";
callout.className = "tour-callout";

let raf = 0;
const tour = createTour({
  steps: TOUR_STEPS,
  hintAfterMs: 3000,
  onStep: (step, i) => {
    callout.innerHTML = `
      <h3>0${i + 1} · ${step.title}</h3>
      <p>${step.body}</p>
      <div class="tour-controls">
        <button type="button" class="tour-showme" hidden>Show me</button>
        <button type="button" class="tour-skip">Skip</button>
      </div>`;
    callout.querySelector(".tour-skip")!.addEventListener("click", () => tour.skip());
    callout.querySelector(".tour-showme")!.addEventListener("click", () => {
      const doc = frame.contentDocument;
      const el = doc?.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`);
      // Do the thing the step asked for, rather than skipping past it.
      if (step.advance === "click" && el) el.click();
      tour.showMe();
    });

    goto(step.hash);
    const doc = frame.contentDocument;
    if (!doc) return;
    // NEVER measure in this tick — the hash change has not repainted yet.
    void awaitAnchor(doc, step.anchor)
      .then((el) => {
        const r = spotlightRect(el, frame);
        Object.assign(hole.style, {
          left: `${r.x}px`, top: `${r.y}px`,
          width: `${r.width}px`, height: `${r.height}px`,
        });
        if (step.advance === "click") {
          el.addEventListener("click", () => tour.satisfy(step.anchor), { once: true, capture: true });
        } else {
          tour.satisfy(step.anchor);
        }
      })
      .catch((err: unknown) => {
        // Never swallowed. A missing anchor means the contract test is stale,
        // and a silent skip would hide exactly that.
        console.error(err);
        tour.skip();
      });
  },
  onEnd: () => {
    cancelAnimationFrame(raf);
    for (const el of [scrim, hole, callout]) el.remove();
    document.documentElement.style.overflow = "";
  },
});

root.querySelector(".tour-start")!.addEventListener("click", () => {
  document.body.append(scrim, hole, callout);
  // The hole is registered to the frame's on-screen position, so a scroll
  // behind the scrim desynchronises it from what it points at.
  document.documentElement.style.overflow = "hidden";
  const loop = (t: number) => {
    tour.tick(t);
    const showme = callout.querySelector<HTMLButtonElement>(".tour-showme");
    if (showme) showme.hidden = !tour.hintVisible();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  tour.start();
});
```

- [ ] **Step 5: Write the page stylesheet**

Create `src/site/styles.css` with the two-column sticky layout. The load-bearing rules:

```css
:root { --site-bg: #fbfbfd; --site-fg: #1b1b1f; --site-dim: #6b6b76; }
@media (prefers-color-scheme: dark) {
  :root { --site-bg: #08090a; --site-fg: #f2f3f5; --site-dim: #9a9aa6; }
}
body { margin: 0; background: var(--site-bg); color: var(--site-fg); font: 16px/1.6 system-ui, sans-serif; }

.split { display: grid; grid-template-columns: 1fr 420px; gap: 48px; max-width: 1100px; margin: 0 auto; padding: 0 24px; }
.sec { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; }
.num { color: var(--site-dim); font-variant-numeric: tabular-nums; }

.phone-rail { position: sticky; top: 5vh; height: 90vh; display: flex; align-items: center; }
.phone { width: 390px; height: 780px; max-height: 88vh; border-radius: 34px; overflow: hidden; border: 10px solid #1b1b1f; }
.demo { width: 100%; height: 100%; border: 0; }

/* No device detection, per the house rule — a width query for layout, and
   nothing that asks what the device is. */
@media (max-width: 999px) {
  .split { grid-template-columns: 1fr; gap: 0; }
  .phone-rail { position: static; height: auto; order: -1; }
  .phone { width: 100%; height: 70vh; border-radius: 20px; }
  .sec { min-height: 0; padding: 32px 0; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
```

Add `<link rel="stylesheet" href="/src/site/styles.css" />` to `site/index.html`'s head — or rely on the `import "./styles.css"` already at the top of `main.ts`, which is what vite expects. Prefer the import and add no link.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/site-page.test.ts`
Expected: PASS, all six.

- [ ] **Step 7: Look at it**

Run: `bun run build:demo && bunx serve dist-site`
Open the printed URL. Verify by hand, on a narrow window as well as a wide one:
1. Scrolling changes the phone's screen, and the copy beside it agrees.
2. Tapping inside the phone stops it following until you scroll again.
3. **Take the tour** dims the page, lights one control, and the callout sits outside the bezel on a wide window and at the bottom on a narrow one.
4. Doing nothing for three seconds reveals **Show me**; pressing it advances.
5. Doing the real thing advances without pressing anything.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/site site/index.html tests/site-page.test.ts
git commit -m "feat: the landing page, its sticky phone, and the tour it launches"
```

---

### Task 9: A "How to use" card in Settings, linking out safely

**Files:**
- Create: `src/shared/links.ts`
- Create: `src/web/components/settings/HelpSection.tsx`
- Modify: `src/web/components/Settings.tsx:450-452` (the Info band)
- Test: `tests/external-links.test.ts`
- Test: `tests/help-section.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `SITE_URL` and `TOUR_URL` from `src/shared/links.ts`; `HelpSection` from `HelpSection.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `tests/external-links.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The manifest sets "display": "standalone", so Add to Home Screen runs
 * chromeless. A same-window navigation to a cross-origin URL from a standalone
 * PWA historically renders INSIDE the app shell with no browser chrome and no
 * back button — the operator is stranded on the site and has to force quit
 * paddock to get back. iOS 16.4 and later hand such links to the browser, but
 * the older behaviour is still in the field.
 *
 * target="_blank" is the whole fix. It is invisible, load-bearing, and exactly
 * the sort of attribute a later tidy-up removes, which is why it is asserted
 * rather than merely commented.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("every external link opens outside the PWA, and cannot reach back into it", () => {
  let checked = 0;
  for (const p of sources("src/web")) {
    const src = readFileSync(p, "utf8");
    // Each <a ...> element, whole, so the attributes are read together.
    for (const m of src.matchAll(/<a\s[^>]*>/g)) {
      const tag = m[0];
      if (!/href=\{?["`]?https?:|href=\{(SITE_URL|TOUR_URL)/.test(tag)) continue;
      checked += 1;
      expect(tag, `${p}: external link traps the PWA without target="_blank"`).toContain(
        'target="_blank"',
      );
      expect(tag, `${p}: external link is missing rel="noopener"`).toContain("noopener");
    }
  }
  // Guard the guard: a regex that matches nothing passes silently, and this
  // file's whole value is that it keeps matching as links are added.
  expect(checked, "the external-link scan found nothing to check").toBeGreaterThan(0);
});
```

Create `tests/help-section.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { HelpSection } from "@web/components/settings/HelpSection";
import { TOUR_URL } from "@shared/links";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the card links to the tour, opened outside the app", async () => {
  const host = await render(<HelpSection />);
  const a = host.querySelector("a") as HTMLAnchorElement;
  expect(a.getAttribute("href")).toBe(TOUR_URL);
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toContain("noopener");
});

test("the link says where it goes, since it leaves the app", async () => {
  const host = await render(<HelpSection />);
  expect((host.textContent ?? "").toLowerCase()).toContain("how to use");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test tests/external-links.test.ts tests/help-section.test.tsx`
Expected: FAIL — `@shared/links` does not exist, and the external-link scan finds nothing (its guard assertion fires).

- [ ] **Step 3: Write the constant**

Create `src/shared/links.ts`:

```ts
/**
 * paddock's own public URLs, in one place.
 *
 * CLAUDE.md forbids special-casing a hostname in the client, and that rule
 * stands — but it protects DERIVED CONNECTION URLs: the `localhost` exclusion
 * that silently turns a working dashboard into a demo screen. A documentation
 * link is not that. It is still a hardcoded URL, so it lives here once rather
 * than being repeated at each call site.
 */
export const SITE_URL = "https://trypaddock.vercel.app";
export const TOUR_URL = `${SITE_URL}/#tour`;
```

- [ ] **Step 4: Write the card**

Create `src/web/components/settings/HelpSection.tsx`:

```tsx
import { TOUR_URL } from "@shared/links";
import { Card } from "@web/components/ui/Card";
import { PlugIcon } from "@web/components/ui/icons";

/**
 * The one external link in the application, and the reason it is written the
 * way it is.
 *
 * `target="_blank"` is load-bearing, not stylistic. The manifest sets
 * "display": "standalone", so an installed paddock runs chromeless; a
 * same-window navigation to another origin from a standalone PWA historically
 * renders inside the app shell with no back button, stranding the operator on
 * a page they cannot leave without force quitting. `rel="noopener"` keeps the
 * opened page from reaching `window.opener`.
 *
 * tests/external-links.test.ts asserts both, here and on every link added
 * later.
 */
export function HelpSection() {
  return (
    <Card
      icon={<PlugIcon />}
      title="How to use"
      subtitle="A guided pass over every screen, on the demo."
    >
      <div className="card-row">
        <span>New to paddock?</span>
        <a href={TOUR_URL} target="_blank" rel="noopener noreferrer">
          Take the tour
        </a>
      </div>
    </Card>
  );
}
```

- [ ] **Step 5: Mount it in the Info band**

In `src/web/components/Settings.tsx`, add the import beside the other section imports and render it directly above `<InfoSection health={health} />`:

```tsx
        <HelpSection />
        <InfoSection health={health} />
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/external-links.test.ts tests/help-section.test.tsx`
Expected: PASS.

- [ ] **Step 7: Full suite, then commit**

```bash
make check && make check-clean && make test
git add src/shared/links.ts src/web/components/settings/HelpSection.tsx src/web/components/Settings.tsx tests/external-links.test.ts tests/help-section.test.tsx
git commit -m "feat: a How to use card in Settings, opened outside the installed app"
```

---

### Task 10: Screenshots, and the documentation owed

**Files:**
- Create: `docs/images/03-terminal.png`, `docs/images/04-spaces.png`, `docs/images/07-compose.png`, `docs/images/08-file.png`
- Modify: `README.md`
- Modify: `docs/decisions.md`, `docs/gotchas.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Take the screenshots**

```bash
make build
./paddock serve --demo
```

Open the dashboard at a phone width. `DEMO_BLOCKED_AGENT_ID` never rotates, so the blocked agent is always on screen and every shot is reproducible rather than a race. Capture four:

1. `03-terminal.png` — the blocked agent with **every control visible at once**: option buttons, the Enter-commits line, the ctrl-key row and the composer. Today's `02-blocked.png` crops the toolbox, so a reader cannot see how much is there.
2. `04-spaces.png` — the Spaces screen, tree expanded.
3. `07-compose.png` — the composer with the slash-command list open.
4. `08-file.png` — the file viewer rendering an HTML page.

Every agent name in frame must be one of the invented demo seeds. No hostname, no URL bar, no home path — `make check-clean` does not read PNGs, so this check is yours.

- [ ] **Step 2: Place them in the README**

Add `03-terminal.png` and `04-spaces.png` as a pair beneath the *answer* and *open what an agent made* bullets, and `07-compose.png` with `08-file.png` as a pair beneath *reply properly*, matching the existing two-up `<p align="center">` blocks at `width="46%"`.

- [ ] **Step 3: Write the documentation the spec owes**

`docs/decisions.md` — two entries: the Pages retirement with its accepted cost (the published install one-liner now 404s; announced in release notes), and why `data-tour` is unconditional rather than behind the demo flag.

`docs/gotchas.md` — two rows: **measure after the repaint, never across it**, as the browser sibling of the existing `send-keys a b c` entry; and the **standalone-PWA external link trap**, with `target="_blank"` as the fix and `tests/external-links.test.ts` as the guard.

`CLAUDE.md` — the screenshot rule gains the site (`--demo` is still the only sanctioned source; the site embeds it rather than replacing it), and the demo is now two builds assembled by `scripts/assemble-site.ts`.

- [ ] **Step 4: Verify and commit**

```bash
make check && make check-clean && make test
git add docs README.md CLAUDE.md
git commit -m "docs: screenshots of the terminal, spaces, composer and file viewer"
```

- [ ] **Step 5: Report to the operator**

State plainly, without assuming any of it is done:
- The Vercel project must exist, with its **Git integration disabled**, and `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` set as repository secrets.
- The real project URL must be confirmed and replaced if it is not `paddock.vercel.app`.
- **The install URL has changed** and belongs in the next release notes.

---

## Corrections made during execution

Recorded rather than silently folded in, because most of them are things the
plan asserted and the running page disproved.

**Task 1 — the site entry path.** The plan said a leading `/` in `site/index.html`
resolves from the project root. It does not: vite resolves it against
`config.root`, which is `site/`. The entry is reached as `../src/site/main.ts`.

**Task 2 — the demo file is a directory.** `fileUrl(id)` is `/api/files/<id>` and
`fileDownloadUrl(id)` is `/api/files/<id>/download`, so `<id>` must be both a
document and a folder. A directory with an `index.html` serves both, on Vercel
and on any local static server, with no rewrite rules — and the extension gets
the content type right for free.

**Task 3 — `--prebuilt` needs `vercel build`.** It publishes `.vercel/output`,
which only `vercel build` writes; deploying without it publishes nothing. The
workflow now runs the gates, then `vercel build` (whose `buildCommand` is the
repo's own `build:demo`), then `deploy --prebuilt`.

**Task 4 — the answer-options anchor was on the wrong component.** It went on
`AskDialogView`'s `.dialog-options`, which is the AskUserQuestion surface. The
demo's blocked agent renders `.term-options` in `AgentTerminal`, so the step
timed out and the tour bailed. **The contract test cannot catch this**: it proves
an anchor exists in the source, not that it is on the screen the step navigates
to. Only running the tour catches it.

**Task 5 — the tour tokens were in the wrong stylesheet.** They were added to
`src/web/styles.css`, which the SITE never loads. An undefined custom property
inside a `box-shadow` or `outline` invalidates the whole declaration, so the tour
ran with no scrim and no spotlight at all and nothing failed. They now live in
`src/site/tour/overlay.css` beside their only consumer, with
`tests/tour-contrast.test.ts` asserting both that every `var(--tour-*)` used is
defined and that the text clears AA on the panel. The per-theme assertions were
removed: the tour renders in the site's document, where no `[data-theme]` is in
scope.

**Task 6 — `advance: "hash"` was not an advance condition.** A step whose anchor
merely appears satisfies itself the instant it renders, so steps 04–06 flashed
past unread. Renamed `next`: those steps get an explicit Next control, because
their destination offers the visitor nothing to tap. Steps 01–03 remain real
actions with `Show me`.

**Task 8 — four defects only the browser found.**

1. *Double advance.* `Show me` clicked the anchor (firing the same listener a
   real tap does, which advances) and then called `showMe()` as well, so 01
   jumped to 03. It now satisfies BY ANCHOR, which is idempotent: once the click
   has advanced, the stale anchor no longer matches.
2. *Stale rect.* A superseded step's `awaitAnchor` still resolved and wrote its
   rectangle over the current step's. Guarded by a step token.
3. *Measure after the SCROLL, not just the repaint.* The tour locked the page
   wherever the visitor was — the hero, where the phone is barely peeking — and
   spotlit controls at y=1220 in a 900px window. The phone is scrolled into view
   before locking, the anchor is scrolled into view inside the frame, and the
   measurement waits a frame for both. This is the same rule as the repaint one,
   which the plan stated and which was still not enough.
4. *Callout off-screen, and a sideways-scrolling body.* The callout aligned its
   top with the lit control and ran off the bottom; it is now clamped after
   layout, when its height is first known. And `max-width: 100%` on an
   inline-block that also has `overflow-x: auto` does not cap it — the install
   one-liner pushed the whole page 8px sideways, so the scroll container moved to
   the parent.
