# Install, binary distribution and update — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paddock installable with one command and upgradable with one
more, by turning the compiled binary into the whole product.

**Architecture:** The built UI is embedded into the binary by a generated
module, so a single file serves the dashboard from anywhere. A tag-triggered
workflow cross-compiles four platforms from one Linux runner, publishes
checksums, and `install.sh` plus `paddock update` both verify those checksums
against the same mapping table before writing anything.

**Tech Stack:** Bun (`--compile`, `--define`, `with { type: "file" }`), Hono,
GitHub Actions, POSIX sh.

**Spec:** `docs/design/2026-08-18-distribution-and-update-design.md`

## Global Constraints

- **This repository is PUBLIC.** No real hostnames, domains, home paths,
  usernames, machine names, employer terms or tunnel IDs in any file, comment,
  test or commit message. Use `paddock.example.com`, `~`, `dev-box`, `operator`,
  and invented agent names (`api-refactor`, `docs-cleanup`, `flaky-test-fix`,
  `schema-migration`). The repo's own GitHub URL is not a violation.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store →
  ws/hub → web/`. Nothing upstream imports downstream; `src/server/**` never
  imports `@web/`.
- **Never swallow errors.** No empty catch blocks, no `2>/dev/null`, no
  unconditional `exit 0`. In shell, `set -eu` and explicit failure messages.
- **Never `sudo`.** Install target is `~/.local/bin`.
- **Verify the checksum before writing any binary**, in both the installer and
  the updater. A mismatch aborts and leaves the existing install untouched.
- **Update is explicit.** paddock never replaces itself unasked.
- **Supported platforms are exactly four:** `linux-x86_64`, `linux-aarch64`,
  `macos-x86_64`, `macos-aarch64`. Windows is out of scope — herdr publishes no
  Windows build.
- **Bare `paddock` must keep serving the dashboard**, and `--demo` must keep
  working. The Docker `CMD` and the README depend on it.
- Run `make check && make check-clean && make test` before every commit.
- **Prove each test can fail** by breaking the code it guards.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/gen-embedded.ts` (new) | Walk `dist/`, generate the embed manifest |
| `src/server/embedded.ts` (generated, gitignored) | URL path → embedded file handle |
| `src/server/routes.ts` (mod) | Serve from the manifest, fall back to `staticDir` |
| `src/server/cli.ts` (new) | Parse argv into a command plus flags |
| `src/server/version.ts` (new) | The single version accessor |
| `src/server/update.ts` (new) | Check, download, verify, replace |
| `src/server/index.ts` (mod) | Dispatch on the parsed command |
| `install.sh` (new) | Detect platform, verify, install to `~/.local/bin` |
| `.github/workflows/release.yml` (new) | Tag-triggered build of four binaries |
| `.github/workflows/demo.yml` (mod) | Copy `install.sh` into the Pages artifact |
| `Makefile` (mod) | Generate the manifest; stamp the version |

---

### Task 1: Embed the built UI in the binary

Today's binary is a half-product. Compiled and run from an empty directory it
answers `/api/health` and connects to herdr, but `GET /` returns 404, because
`routes.ts:571` reads assets from disk at runtime.

**Files:**
- Create: `scripts/gen-embedded.ts`
- Create: `src/shared/file-import.d.ts`
- Modify: `src/server/routes.ts` (the `if (deps.staticDir)` block)
- Modify: `Makefile`, `.gitignore`
- Test: `tests/embedded.test.ts`

**Interfaces:**
- Produces: `EMBEDDED: Record<string, string>` from `@server/embedded`, mapping
  a URL path (`/index.html`, `/assets/index-ABC123.js`) to the embedded file
  path Bun resolves at runtime. Empty when `dist/` was absent at generation.

- [ ] **Step 1: Write the failing test**

Create `tests/embedded.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The defect this guards, measured before the fix: a compiled binary run from
 * a directory with no `dist/` answered /api/health but returned 404 for `/`.
 * Installing it to ~/.local/bin gave an API with no dashboard.
 */
test("the compiled binary serves the dashboard from a directory with no dist/", async () => {
  const out = join(await mkdtemp(join(tmpdir(), "paddock-bin-")), "paddock");
  const build = Bun.spawnSync([
    "bun", "build", "--compile", "--target=bun", "src/server/index.ts", "--outfile", out,
  ]);
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

  const runDir = await mkdtemp(join(tmpdir(), "paddock-run-"));
  const port = 8900 + Math.floor(performance.now() % 90);
  const proc = Bun.spawn([out], {
    cwd: runDir,
    env: { ...process.env, PADDOCK_PORT: String(port), PADDOCK_HERDR_SOCKET: "/nonexistent.sock" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    let res: Response | null = null;
    for (let i = 0; i < 40 && res === null; i++) {
      try { res = await fetch(`http://127.0.0.1:${port}/`); } catch { await Bun.sleep(100); }
    }
    expect(res, "binary never bound its port").not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("<div id=\"root\">");
  } finally {
    proc.kill();
  }
}, 60_000);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run build:web && bun test tests/embedded.test.ts`
Expected: FAIL — status 404, because nothing is embedded yet.

- [ ] **Step 3: Declare file imports for tsc**

Create `src/shared/file-import.d.ts`:

```ts
/**
 * `import x from "./a.js" with { type: "file" }` yields a path string that Bun
 * resolves inside a compiled binary. TypeScript has no built-in knowledge of
 * this, and the files are content-hashed build output that does not exist in a
 * fresh checkout, so a wildcard declaration is what lets `tsc --noEmit` run
 * before anything is built.
 */
declare module "*.html" { const path: string; export default path; }
declare module "*.js" { const path: string; export default path; }
declare module "*.css" { const path: string; export default path; }
declare module "*.png" { const path: string; export default path; }
declare module "*.svg" { const path: string; export default path; }
declare module "*.webmanifest" { const path: string; export default path; }
```

- [ ] **Step 4: Write the generator**

Create `scripts/gen-embedded.ts`:

```ts
/**
 * Generates `src/server/embedded.ts` — the map that lets one binary be the
 * whole product.
 *
 * Generated rather than committed because Vite content-hashes asset names, so
 * a committed manifest would silently drift from the bundle it claims to
 * describe. Writing an EMPTY map when `dist/` is absent is what keeps a fresh
 * clone's `make check` working before anything has been built.
 */
import { readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const DIST = "dist";
const OUT = "src/server/embedded.ts";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;   // a real read failure must not masquerade as "no assets"
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = (await walk(DIST)).sort();
const lines: string[] = [
  "// GENERATED by scripts/gen-embedded.ts — do not edit, do not commit.",
  "// Regenerate with `make embed`. Empty when dist/ has not been built.",
];
const entries: string[] = [];
files.forEach((f, i) => {
  const url = "/" + relative(DIST, f).split("\\").join("/");
  lines.push(`import a${i} from "../../${f}" with { type: "file" };`);
  entries.push(`  ${JSON.stringify(url)}: a${i},`);
});
lines.push("", "export const EMBEDDED: Record<string, string> = {", ...entries, "};", "");
await writeFile(OUT, lines.join("\n"));
console.log(`gen-embedded: ${files.length} asset(s) -> ${OUT}`);
```

- [ ] **Step 5: Serve from the manifest**

In `src/server/routes.ts`, add the import at the top:

```ts
import { EMBEDDED } from "@server/embedded";
```

Replace the `if (deps.staticDir) { … }` block's handler so the embedded map is
consulted first and `staticDir` remains the fallback. Keep the existing
`IMMUTABLE_ASSET_RE` cache-header logic exactly as it is — it is load-bearing
and documented in place:

```ts
  // Embedded assets first, disk second. The binary must be the whole product;
  // `staticDir` is what keeps `make dev` and the Docker image working, where
  // the UI is rebuilt constantly and embedding it would be wrong.
  const serve = async (path: string): Promise<Response | null> => {
    const embedded = EMBEDDED[path];
    if (embedded) return new Response(Bun.file(embedded), { headers: headersFor(path) });
    if (!deps.staticDir) return null;
    const candidate = Bun.file(`${deps.staticDir}${path}`);
    return (await candidate.exists())
      ? new Response(candidate, { headers: headersFor(path) })
      : null;
  };

  app.get("/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path !== "/") {
      const hit = await serve(path);
      if (hit) return hit;
    }
    const index = await serve("/index.html");
    if (!index) return c.text("UI not built — run `make build`", 404);
    return index;
  });
```

Extract the existing cache-control decision into `headersFor(path)` in the same
file, preserving its comment verbatim:

```ts
function headersFor(path: string): Record<string, string> {
  // Content-hashed assets are safe to cache forever. Everything else —
  // `sw.js`, the manifest, icons — carries no hash, so a long-lived entry for
  // it would pin a stale copy under a name that never changes.
  return {
    "cache-control": IMMUTABLE_ASSET_RE.test(path)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
}
```

Note the `app.get("/*")` registration must now happen unconditionally, not
inside `if (deps.staticDir)`, because a binary with embedded assets and no
`staticDir` must still serve.

- [ ] **Step 6: Wire the generator into the build**

In `.gitignore` add `src/server/embedded.ts`.

In the `Makefile`, add an `embed` target and make the others depend on it:

```make
embed:
	bun run scripts/gen-embedded.ts

check: embed
	bunx tsc --noEmit

build: check check-clean test
	bun run build:web
	$(MAKE) embed
	bun build --compile --target=bun src/server/index.ts --outfile paddock
```

`make test` already runs `build:web` first via the `test` script, so add
`bun run scripts/gen-embedded.ts` to that script in `package.json`:

```json
"test": "bun run build:web && bun run scripts/gen-embedded.ts && bun test"
```

- [ ] **Step 7: Run the test**

Run: `make test`
Expected: PASS, including `tests/embedded.test.ts`.

- [ ] **Step 8: Prove it can fail**

Empty the `EMBEDDED` map by hand (`export const EMBEDDED = {};`) and re-run
`bun test tests/embedded.test.ts` — it must go RED with a 404. Then regenerate.

- [ ] **Step 9: Commit**

```bash
make check && make check-clean && make test
git add scripts/gen-embedded.ts src/shared/file-import.d.ts src/server/routes.ts Makefile package.json .gitignore tests/embedded.test.ts
git commit -m "feat: embed the built UI so the binary is the whole product

Measured before the fix: the compiled binary run from an empty directory
answered /api/health and connected to herdr, but GET / returned 404. Installing
it to ~/.local/bin gave an API with no dashboard.

The manifest is generated rather than committed because Vite content-hashes
asset names, so a committed one would drift from the bundle it describes. It
writes an empty map when dist/ is absent, which is what keeps a fresh clone's
make check working before anything is built."
```

---

### Task 2: Version and the CLI

**Files:**
- Create: `src/server/version.ts`, `src/server/cli.ts`
- Modify: `src/server/index.ts:23-33`, `Makefile`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `VERSION: string` from `@server/version`;
  `parseArgs(argv: string[]): { command: "serve" | "update"; flags: Set<string> }`
  from `@server/cli`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseArgs } from "@server/cli";

test("bare invocation serves — the Docker CMD and every doc depend on it", () => {
  expect(parseArgs([])).toEqual({ command: "serve", flags: new Set() });
});

test("--demo still serves", () => {
  expect(parseArgs(["--demo"])).toEqual({ command: "serve", flags: new Set(["--demo"]) });
});

test("update is a command, and carries its own flag", () => {
  expect(parseArgs(["update"])).toEqual({ command: "update", flags: new Set() });
  expect(parseArgs(["update", "--check"]))
    .toEqual({ command: "update", flags: new Set(["--check"]) });
});

test("flags may precede the command", () => {
  expect(parseArgs(["--check", "update"]))
    .toEqual({ command: "update", flags: new Set(["--check"]) });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — cannot resolve `@server/cli`.

- [ ] **Step 3: Implement**

Create `src/server/version.ts`:

```ts
/**
 * The version, injected at build time from the git tag via `bun build
 * --define`. The tag is the single source of truth — package.json's `version`
 * field is deliberately NOT used, because it drifts (it still reads 0.1.0 at
 * the time of writing, several releases later).
 *
 * A build with no tag reports `0.0.0-dev`, so a binary can always answer
 * whether it came from a release — which matters when a bug is reported
 * against a binary someone compiled themselves.
 */
export const VERSION: string = process.env.PADDOCK_VERSION ?? "0.0.0-dev";
```

Create `src/server/cli.ts`:

```ts
export type Command = "serve" | "update";

/**
 * Argument handling was `new Set(Bun.argv.slice(2))`, which is fine for flags
 * and cannot express a verb carrying its own flag (`update --check`).
 *
 * Bare invocation serves. That is not an accident to be tidied up later: the
 * Docker CMD, the README, and every screenshot caption assume it, and a
 * distribution change that broke the documented invocation would defeat its
 * own purpose.
 */
export function parseArgs(argv: string[]): { command: Command; flags: Set<string> } {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const verb = argv.find((a) => !a.startsWith("-"));
  return { command: verb === "update" ? "update" : "serve", flags };
}
```

- [ ] **Step 4: Wire into `index.ts`**

Replace lines 23-33 of `src/server/index.ts`:

```ts
const { command, flags } = parseArgs(Bun.argv.slice(2));
const DEMO = flags.has("--demo");
const PORT = Number(process.env.PADDOCK_PORT ?? 8787);
const HOSTNAME = "127.0.0.1"; // loopback only; exposure is the tunnel's job

if (flags.has("--version") || flags.has("-V")) {
  console.log(VERSION);
  process.exit(0);
}

for (const unimplemented of ["agent", "hub"]) {
  if (Bun.argv.includes(unimplemented)) {
    console.error(`paddock ${unimplemented}: not implemented — see docs/roadmap.md`);
    process.exit(2);
  }
}
```

(`command === "update"` is dispatched in Task 5; leave a single line
`if (command === "update") { console.error("paddock update: not implemented"); process.exit(2); }`
for now so the verb is never silently treated as `serve`.)

- [ ] **Step 5: Stamp the version in the build**

In the `Makefile`, change the compile line:

```make
VERSION := $(shell git describe --tags --exact-match 2>/dev/null || echo 0.0.0-dev)

build: check check-clean test
	bun run build:web
	$(MAKE) embed
	bun build --compile --target=bun \
	  --define 'process.env.PADDOCK_VERSION="$(VERSION)"' \
	  src/server/index.ts --outfile paddock
```

- [ ] **Step 6: Verify**

Run: `make check && bun test tests/cli.test.ts`
Expected: PASS. Then `bun src/server/index.ts --version` prints `0.0.0-dev`.

- [ ] **Step 7: Prove it can fail**

Make `parseArgs` always return `command: "serve"`; the update tests go RED.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/server/version.ts src/server/cli.ts src/server/index.ts Makefile tests/cli.test.ts
git commit -m "feat: a version and a command parser

The tag is the source of truth, injected via bun build --define; package.json's
version field is deliberately unused because it drifts — it still reads 0.1.0
several releases later. An untagged build reports 0.0.0-dev, so a binary can
always say whether it came from a release."
```

---

### Task 3: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `tests/release-workflow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/release-workflow.test.ts`:

```ts
import { expect, test } from "bun:test";

const wf = await Bun.file(".github/workflows/release.yml").text();

test("releases build exactly the four platforms herdr supports", () => {
  // herdr publishes linux-{aarch64,x86_64} and macos-{aarch64,x86_64} and no
  // Windows build. paddock reaches herdr over a unix socket, so a Windows
  // binary would start and find nothing to connect to.
  for (const t of ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"]) {
    expect(wf).toContain(t);
  }
  expect(wf).not.toContain("windows");
});

test("assets are named with herdr's vocabulary, so the two read as siblings", () => {
  for (const n of ["paddock-linux-x86_64", "paddock-linux-aarch64",
                   "paddock-macos-x86_64", "paddock-macos-aarch64"]) {
    expect(wf).toContain(n);
  }
});

test("checksums are published, and the version is stamped from the tag", () => {
  expect(wf).toContain("SHA256SUMS");
  expect(wf).toContain("PADDOCK_VERSION");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/release-workflow.test.ts`
Expected: FAIL — the workflow file does not exist.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release

# Tags only. ci.yml gates pull requests and pushes to main, so a red tree
# cannot be released around by pushing a tag.
on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile

      - run: make check
      - run: make check-clean
      - run: make test

      - name: Build the UI and the embed manifest
        run: |
          bun run build:web
          bun run scripts/gen-embedded.ts

      # One Linux runner builds every target. Bun cross-compiles: this was
      # verified producing genuine Mach-O arm64 and ELF aarch64 binaries from
      # x86_64 Linux, which is why there is no macOS runner here.
      - name: Compile
        run: |
          set -eu
          VERSION="${GITHUB_REF_NAME#v}"
          mkdir -p out
          build() {
            bun build --compile --target="$1" \
              --define "process.env.PADDOCK_VERSION=\"$VERSION\"" \
              src/server/index.ts --outfile "out/$2"
          }
          build bun-linux-x64    paddock-linux-x86_64
          build bun-linux-arm64  paddock-linux-aarch64
          build bun-darwin-x64   paddock-macos-x86_64
          build bun-darwin-arm64 paddock-macos-aarch64

      - name: Checksums
        run: cd out && sha256sum paddock-* > SHA256SUMS && cat SHA256SUMS

      - name: Attach to the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "$GITHUB_REF_NAME" out/* --clobber
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/release-workflow.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prove they can fail**

Add `bun-windows-x64` to the compile step; the first test goes RED. Remove it.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && make test
git add .github/workflows/release.yml tests/release-workflow.test.ts
git commit -m "ci: publish four binaries and their checksums on a tag

One ubuntu runner builds every target, because Bun's cross-compilation was
verified producing real Mach-O arm64 and ELF aarch64 binaries from x86_64
Linux — no macOS runner is needed. Asset names mirror herdr's vocabulary so
the two projects read as siblings."
```

---

### Task 4: `install.sh` and its hosting

**Files:**
- Create: `install.sh`
- Modify: `.github/workflows/demo.yml`
- Test: `tests/install-script.test.ts`

**Interfaces:**
- Produces: the platform mapping (`Linux`→`linux`, `Darwin`→`macos`,
  `x86_64`→`x86_64`, `aarch64`/`arm64`→`aarch64`) that Task 5 must match.

- [ ] **Step 1: Write the failing tests**

Create `tests/install-script.test.ts`:

```ts
import { expect, test } from "bun:test";

const sh = await Bun.file("install.sh").text();

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["sh", "install.sh", ...args], { env: { ...process.env, ...env } });

test("every supported platform maps to a real asset name", () => {
  for (const [os, arch, asset] of [
    ["Linux", "x86_64", "paddock-linux-x86_64"],
    ["Linux", "aarch64", "paddock-linux-aarch64"],
    ["Darwin", "arm64", "paddock-macos-aarch64"],
    ["Darwin", "x86_64", "paddock-macos-x86_64"],
  ] as const) {
    const r = run(["--print-asset"], { PADDOCK_UNAME_S: os, PADDOCK_UNAME_M: arch });
    expect(r.exitCode, `${os}/${arch} should resolve`).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe(asset);
  }
});

test("an unsupported platform exits non-zero rather than downloading something useless", () => {
  const r = run(["--print-asset"], { PADDOCK_UNAME_S: "Windows_NT", PADDOCK_UNAME_M: "x86_64" });
  expect(r.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(r.stderr)).toContain("unsupported");
});

test("the script never uses sudo and never pipes a download into a shell", () => {
  expect(sh).not.toContain("sudo");
  expect(sh).not.toMatch(/curl[^\n|]*\|\s*sh/);
});

test("the checksum is verified before the binary is installed", () => {
  const verifyAt = sh.search(/sha256sum|shasum/);
  const installAt = sh.search(/mv .*\$BIN|install -m/);
  expect(verifyAt).toBeGreaterThan(-1);
  expect(installAt).toBeGreaterThan(-1);
  expect(verifyAt).toBeLessThan(installAt);
});

test("errors are not swallowed", () => {
  expect(sh).toContain("set -eu");
  expect(sh).not.toContain("2>/dev/null");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/install-script.test.ts`
Expected: FAIL — `install.sh` does not exist.

- [ ] **Step 3: Write the installer**

Create `install.sh`:

```sh
#!/bin/sh
# paddock installer. Downloads the release binary for this platform, verifies
# its checksum, and installs it to ~/.local/bin.
#
# Read before running:
#   curl -fsSL https://trypaddock.vercel.app/install.sh | less
#
# No sudo. ~/.local/bin is user-writable, so nothing here needs privilege
# escalation — a one-liner that asks for root to install a dashboard is a habit
# worth not teaching.
set -eu

REPO="lntvan166/paddock"
BIN_DIR="${PADDOCK_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/paddock"

# Overridable so the platform table can be tested without four machines.
UNAME_S="${PADDOCK_UNAME_S:-$(uname -s)}"
UNAME_M="${PADDOCK_UNAME_M:-$(uname -m)}"

asset_name() {
  case "$UNAME_S" in
    Linux)  os=linux ;;
    Darwin) os=macos ;;
    *) echo "paddock: unsupported operating system: $UNAME_S" >&2
       echo "supported: Linux, Darwin (macOS)" >&2; exit 1 ;;
  esac
  case "$UNAME_M" in
    x86_64|amd64)  arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "paddock: unsupported architecture: $UNAME_M" >&2
       echo "supported: x86_64, aarch64" >&2; exit 1 ;;
  esac
  echo "paddock-$os-$arch"
}

ASSET="$(asset_name)"

if [ "${1:-}" = "--print-asset" ]; then echo "$ASSET"; exit 0; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BASE="https://github.com/$REPO/releases/latest/download"
echo "paddock: downloading $ASSET"
curl -fsSL "$BASE/$ASSET" -o "$TMP/paddock"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"

echo "paddock: verifying checksum"
EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')"
if [ -z "$EXPECTED" ]; then
  echo "paddock: $ASSET is not listed in SHA256SUMS — refusing to install" >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  ACTUAL="$(sha256sum "$TMP/paddock" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TMP/paddock" | awk '{print $1}')"
fi
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "paddock: CHECKSUM MISMATCH — refusing to install" >&2
  echo "  expected $EXPECTED" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$TMP/paddock"
mv "$TMP/paddock" "$BIN"
echo "paddock: installed to $BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "paddock: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "paddock: run 'paddock' to start the dashboard"
```

- [ ] **Step 4: Publish it with the Pages site**

In `.github/workflows/demo.yml`, before `upload-pages-artifact`:

```yaml
      # install.sh is served from the Pages site, so it must ride along in the
      # artifact. Without this the published install command 404s while every
      # other page on the site keeps working — a failure that looks like health.
      - run: cp install.sh dist-demo/install.sh
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/install-script.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Prove they can fail**

Move the `mv "$TMP/paddock" "$BIN"` line above the checksum block — the
verify-before-install test must go RED. Restore it.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add install.sh .github/workflows/demo.yml tests/install-script.test.ts
git commit -m "feat: an installer that verifies before it writes

Checksum is verified before the binary is moved into place, and a test asserts
that ordering rather than trusting it. No sudo: ~/.local/bin needs none, and a
one-liner that asks for root to install a dashboard teaches the wrong habit.

install.sh is copied into the Pages artifact, because dist-demo is what Pages
publishes — without that the install URL 404s while the rest of the site looks
perfectly healthy."
```

---

### Task 5: `paddock update`

**Files:**
- Create: `src/server/update.ts`
- Modify: `src/server/index.ts`
- Test: `tests/update.test.ts`

**Interfaces:**
- Consumes: `VERSION` (Task 2), the platform mapping (Task 4).
- Produces: `assetName(platform: string, arch: string): string | null`,
  `isNewer(latest: string, current: string): boolean`,
  `runUpdate(opts): Promise<number>` returning an exit code.

- [ ] **Step 1: Write the failing tests**

Create `tests/update.test.ts`:

```ts
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, isNewer, runUpdate } from "@server/update";

test("the asset table matches install.sh exactly, so the two cannot disagree", () => {
  expect(assetName("linux", "x64")).toBe("paddock-linux-x86_64");
  expect(assetName("linux", "arm64")).toBe("paddock-linux-aarch64");
  expect(assetName("darwin", "arm64")).toBe("paddock-macos-aarch64");
  expect(assetName("darwin", "x64")).toBe("paddock-macos-x86_64");
  expect(assetName("win32", "x64")).toBeNull();
});

test("version comparison is numeric, not lexicographic", () => {
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);   // string compare says false
  expect(isNewer("0.3.0", "0.3.0")).toBe(false);
  expect(isNewer("0.2.0", "0.3.0")).toBe(false);
  expect(isNewer("1.0.0", "0.0.0-dev")).toBe(true);
});

async function harness(body: string, sum: string) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  await chmod(self, 0o755);
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${sum}  paddock-linux-x86_64\n`);
    }
    return new Response(body);
  }) as unknown as typeof fetch;
  return { dir, self, fetchImpl };
}

const sha = async (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("a good update replaces the binary", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("NEW BINARY");
});

test("a CHECKSUM MISMATCH leaves the working binary untouched", async () => {
  // The failure this prevents is replacing a working install with a broken one.
  const h = await harness("TAMPERED", await sha("SOMETHING ELSE"));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("--check reports without changing anything", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {}, checkOnly: true,
  });
  expect(code).toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("an unwritable binary refuses rather than half-updating", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  await chmod(h.self, 0o555);
  await chmod(h.dir, 0o555);
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  await chmod(h.dir, 0o755);
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/update.test.ts`
Expected: FAIL — cannot resolve `@server/update`.

- [ ] **Step 3: Implement**

Create `src/server/update.ts`:

```ts
import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO = "lntvan166/paddock";

/**
 * The same mapping `install.sh` uses, so the installer and the updater cannot
 * disagree about which asset to fetch. Windows returns null deliberately:
 * herdr publishes no Windows build, so there is nothing to connect to.
 */
export function assetName(platform: string, arch: string): string | null {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  return os && cpu ? `paddock-${os}-${cpu}` : null;
}

/** Numeric compare. `0.10.0` is newer than `0.9.0`, which a string compare gets wrong. */
export function isNewer(latest: string, current: string): boolean {
  const nums = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((p) => Number(p) || 0);
  const [a, b] = [nums(latest), nums(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export interface UpdateOpts {
  selfPath: string;
  platform: string;
  arch: string;
  current: string;
  checkOnly?: boolean;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

/** Returns a process exit code. Never throws for an expected failure. */
export async function runUpdate(o: UpdateOpts): Promise<number> {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? console.log;

  const asset = assetName(o.platform, o.arch);
  if (!asset) {
    log(`paddock: no release build for ${o.platform}/${o.arch}`);
    return 1;
  }

  const rel = await f(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!rel.ok) { log(`paddock: could not reach the release API (HTTP ${rel.status})`); return 1; }
  const latest = String(((await rel.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  if (!latest) { log("paddock: the release API returned no tag"); return 1; }

  if (!isNewer(latest, o.current)) {
    log(`paddock: ${o.current} is current (latest is ${latest})`);
    return 0;
  }
  log(`paddock: ${o.current} -> ${latest}`);
  if (o.checkOnly) { log("paddock: run 'paddock update' to install it"); return 0; }

  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  const [binRes, sumRes] = await Promise.all([f(`${base}/${asset}`), f(`${base}/SHA256SUMS`)]);
  if (!binRes.ok || !sumRes.ok) { log("paddock: download failed"); return 1; }

  const bytes = new Uint8Array(await binRes.arrayBuffer());
  const expected = (await sumRes.text())
    .split("\n").find((l) => l.trim().endsWith(asset))?.trim().split(/\s+/)[0];
  if (!expected) { log(`paddock: ${asset} is not listed in SHA256SUMS`); return 1; }

  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // Nothing is written. Replacing a working install with a broken one is a
    // worse outcome than not updating.
    log("paddock: CHECKSUM MISMATCH — keeping the current binary");
    log(`  expected ${expected}`);
    log(`  actual   ${actual}`);
    return 1;
  }

  const tmp = join(dirname(o.selfPath), ".paddock.new");
  try {
    await writeFile(tmp, bytes);
    await chmod(tmp, 0o755);
    // rename(2) over a running executable is safe on Linux and macOS: the
    // running process keeps its inode and the next invocation gets the new
    // file. This is why dropping Windows simplified the design.
    await rename(tmp, o.selfPath);
  } catch (e) {
    log(`paddock: could not replace ${o.selfPath}: ${(e as Error).message}`);
    log("paddock: if it was installed by a package manager, update it there instead");
    return 1;
  }
  log(`paddock: updated to ${latest}`);
  return 0;
}
```

- [ ] **Step 4: Dispatch it in `index.ts`**

Replace the placeholder from Task 2:

```ts
if (command === "update") {
  process.exit(await runUpdate({
    selfPath: Bun.argv[0]!,
    platform: process.platform,
    arch: process.arch,
    current: VERSION,
    checkOnly: flags.has("--check"),
  }));
}
```

This must run before any server setup — `paddock update` should not open a
herdr socket or bind a port.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/update.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Prove they can fail**

Delete the checksum comparison; the mismatch test must go RED with the binary
overwritten. Restore it. Then change `isNewer` to use string comparison; the
`0.10.0` case must go RED.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server/update.ts src/server/index.ts tests/update.test.ts
git commit -m "feat: paddock update, explicit and checksum-verified

Nothing is written until the SHA-256 matches, and the test that matters asserts
the working binary survives a mismatch — replacing a working install with a
broken one is worse than not updating at all.

Version comparison is numeric: 0.10.0 is newer than 0.9.0, which a string
compare gets wrong, and that bug would only appear on the tenth minor release."
```

---

### Task 6: Knowing a new version exists

**Files:**
- Create: `src/server/update-check.ts`
- Modify: `src/server/routes.ts` (health body), `src/web/components/HostHeader.tsx`
- Test: `tests/update-check.test.ts`

**Interfaces:**
- Consumes: `isNewer` (Task 5).
- Produces: `checkForUpdate(opts): Promise<string | null>` returning the newer
  version or null; `latestKnown: string | null` on the health body.

- [ ] **Step 1: Write the failing tests**

Create `tests/update-check.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate } from "@server/update-check";

const dir = async () => mkdtemp(join(tmpdir(), "paddock-uc-"));

const fetchOk = (async () =>
  new Response(JSON.stringify({ tag_name: "v9.9.9" }))) as unknown as typeof fetch;

test("a fresh check reports the newer version and caches it", async () => {
  const d = await dir();
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk }))
    .toBe("9.9.9");
  expect(JSON.parse(await readFile(join(d, "update-check.json"), "utf8")).latest).toBe("9.9.9");
});

test("a second check inside 24h does NOT hit the network", async () => {
  const d = await dir();
  await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk });
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  await checkForUpdate({ dir: d, current: "0.1.0", now: 1000 + 60_000, fetchImpl: spy });
  expect(called).toBe(false);
});

test("PADDOCK_NO_UPDATE_CHECK disables it entirely", async () => {
  const d = await dir();
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await checkForUpdate({
    dir: d, current: "0.1.0", now: 1000, fetchImpl: spy, disabled: true,
  });
  expect(r).toBeNull();
  expect(called).toBe(false);
});

test("a network failure is silent to the operator, not an error about a working dashboard", async () => {
  const d = await dir();
  const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: boom }))
    .toBeNull();
});

test("a corrupt cache file does not crash the check", async () => {
  const d = await dir();
  await writeFile(join(d, "update-check.json"), "{ not json");
  expect(await checkForUpdate({ dir: d, current: "0.1.0", now: 1000, fetchImpl: fetchOk }))
    .toBe("9.9.9");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `bun test tests/update-check.test.ts`
Expected: FAIL — cannot resolve `@server/update-check`.

- [ ] **Step 3: Implement**

Create `src/server/update-check.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewer } from "@server/update";

const REPO = "lntvan166/paddock";
const EVERY_MS = 24 * 60 * 60 * 1000;

export interface CheckOpts {
  dir: string;
  current: string;
  now: number;
  disabled?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a newer version, or null.
 *
 * Deliberately NOT called on every start: that would phone GitHub each time
 * paddock runs, make a local dashboard depend on connectivity it does not
 * otherwise need, and leak usage timing. At most once per 24h, cached on disk.
 */
export async function checkForUpdate(o: CheckOpts): Promise<string | null> {
  if (o.disabled) return null;
  const file = join(o.dir, "update-check.json");

  let cache: { at?: number; latest?: string } = {};
  try {
    cache = JSON.parse(await readFile(file, "utf8")) as typeof cache;
  } catch {
    // Absent or corrupt. Either way the right move is to check again — this
    // cache is an optimisation, and losing it costs one HTTP request.
  }

  if (typeof cache.at === "number" && o.now - cache.at < EVERY_MS) {
    return cache.latest && isNewer(cache.latest, o.current) ? cache.latest : null;
  }

  let latest = "";
  try {
    const res = await (o.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  } catch (e) {
    // Logged, never surfaced in the UI: a version check that cannot reach
    // GitHub is not a reason to show an error about a dashboard that works.
    console.info(`paddock: update check skipped (${(e as Error).message})`);
    return null;
  }

  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ at: o.now, latest }, null, 2));
  return latest && isNewer(latest, o.current) ? latest : null;
}
```

- [ ] **Step 4: Surface it**

In `src/server/index.ts`, after the server starts, fire the check without
awaiting it (a version check must never delay the dashboard binding its port),
and store the result for the health body:

```ts
let latestKnown: string | null = null;
void checkForUpdate({
  dir: defaultConfigDir(),
  current: VERSION,
  now: Date.now(),
  disabled: process.env.PADDOCK_NO_UPDATE_CHECK === "1",
}).then((v) => { latestKnown = v; });
```

Add `latestKnown` and `version` to the health body (`HealthBody` in
`routes.ts`), both required fields, following the `lastNotifyError` precedent.

In `HostHeader.tsx`, when the store's health reports `latestKnown`, render one
dim line beside the counts: `paddock {latestKnown} available — run: paddock update`.
No colour token is added; reuse `--fg-dim`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/update-check.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Prove they can fail**

Remove the `o.now - cache.at < EVERY_MS` guard — the "does NOT hit the network"
test must go RED. Restore it.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server/update-check.ts src/server/index.ts src/server/routes.ts src/web/components/HostHeader.tsx tests/update-check.test.ts
git commit -m "feat: a once-a-day update check, off by one env var

Not on every start: that would phone GitHub each time paddock runs, make a
local dashboard depend on connectivity it does not need, and leak usage timing.
A failed check is logged and invisible — an unreachable GitHub is not a reason
to show an error about a dashboard that is working."
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`, `docs/roadmap.md`, `docs/architecture.md`

- [ ] **Step 1: README install section**

Add above Quick start:

````markdown
## Install

```bash
curl -fsSL https://trypaddock.vercel.app/install.sh | sh
```

Installs to `~/.local/bin/paddock`. No `sudo`. The script verifies the release
checksum before writing anything — read it first with
`curl -fsSL https://trypaddock.vercel.app/install.sh | less`.

Upgrade with `paddock update`. paddock never updates itself unasked.

Builds are published for Linux and macOS on x86_64 and aarch64 — the same four
platforms herdr supports.
````

- [ ] **Step 2: Record the signing gap in `docs/roadmap.md`**

State it in the roadmap's own voice: `SHA256SUMS` is published on the same
GitHub release as the binaries it describes, so it defends against a corrupted
download and a broken TLS path, and **not** against a compromised release or
account. Real protection needs a signature from a key that does not live on
GitHub. Note why it is not built — key management is its own project, and a
signing key stored in CI is theatre — and why it matters more here than for
most tools: paddock can send keystrokes to coding agents, so a bad update is
not merely a bad dashboard.

- [ ] **Step 3: Record the embedding boundary in `docs/architecture.md`**

Add: assets reach the browser from the embedded manifest first and `staticDir`
second; the manifest is generated per build because Vite content-hashes names;
`PADDOCK_STATIC_DIR` remains how the Docker image and `make dev` serve a
rebuilt UI without recompiling the binary.

- [ ] **Step 4: Commit**

```bash
make check && make check-clean && make test
git add README.md docs/roadmap.md docs/architecture.md
git commit -m "docs: install, upgrade, and what checksums do not protect"
```

---

## Self-review

**Spec coverage.** Section 1 → Task 1; section 2 → Task 2; section 3 → Task 3;
section 4 → Task 4 (including the `dist-demo` dependency the spec's own
self-review surfaced); section 5 → Task 5; section 6 → Task 6; section 7's
honesty requirement → Task 7 step 2; section 8's test list is distributed across
the tasks that own each behaviour.

**Placeholders.** None. Every code step carries real code.

**Type consistency.** `assetName`/`isNewer` (Task 5) are consumed by Task 6.
`VERSION` (Task 2) is consumed by Tasks 5 and 6. `EMBEDDED` (Task 1) is consumed
only by `routes.ts`. `parseArgs`'s return shape is identical in Tasks 2 and 5.
The platform mapping appears in `install.sh` (Task 4) and `assetName` (Task 5);
Task 5's first test asserts they agree, which is the only guard against them
drifting apart.

**Two risks worth stating.** Task 1's test compiles a binary and boots it, so it
is slower and heavier than anything else in this suite — if it proves flaky in
CI, the fix is to give it a longer timeout, not to delete it, because it is the
only test that proves the shipped artifact works. And Task 6 is the most
cuttable piece of the whole plan: if the UI notice becomes fiddly, `paddock
update --check` alone satisfies the goal.
