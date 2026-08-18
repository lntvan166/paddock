import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The manifest `src/server/routes.ts` imports — `@server/embedded` — is
 * GENERATED and gitignored. Every build path must therefore generate it, and
 * the one that did not shipped a Docker image that could not start:
 *
 *   error: Cannot find module '@server/embedded' from '/app/src/server/routes.ts'
 *
 * That defect survived review because it is invisible on a developer's
 * machine. `COPY . .` does not honour `.gitignore`, so an image built where
 * `make build` has run copies that machine's local `embedded.ts` in and boots
 * fine; only a clean clone fails. Both halves are covered here — that the
 * import really is fatal without a manifest, and that each build path both
 * generates one and refuses to inherit somebody's.
 *
 * The Docker assertions are textual on purpose. Exercising them for real means
 * `docker build`, which pulls a base image and installs dependencies over the
 * network, and no test in this repo reaches the network.
 */

const dockerfile = await Bun.file("Dockerfile").text();
const dockerignore = await Bun.file(".dockerignore").text();
const devsh = await Bun.file("scripts/dev.sh").text();

/**
 * Materialises what a clean clone actually contains — `git archive HEAD`, i.e.
 * tracked files only — and links this checkout's `node_modules` in so the
 * server's own imports resolve without a network `bun install`.
 */
function cleanClone(): string {
  const dir = mkdtempSync(join(tmpdir(), "paddock-clean-clone-"));
  const archive = Bun.spawnSync(["git", "archive", "HEAD"], { stdout: "pipe" });
  expect(archive.exitCode, new TextDecoder().decode(archive.stderr)).toBe(0);
  const untar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
  expect(untar.exitCode, new TextDecoder().decode(untar.stderr)).toBe(0);
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  return dir;
}

test("a clean clone has no embed manifest, and the server cannot even load without one", () => {
  const dir = cleanClone();
  try {
    expect(
      existsSync(join(dir, "src/server/embedded.ts")),
      "embedded.ts is gitignored — if it is in the archive, the premise of every build-path fix here has changed",
    ).toBe(false);

    // Importing routes.ts is exactly what src/server/index.ts does first. No
    // port is bound and no herdr socket is opened by the import alone, so this
    // isolates module resolution from everything else the server does.
    const r = Bun.spawnSync(["bun", "-e", "await import('./src/server/routes.ts')"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, "the missing manifest must be fatal, not tolerated").not.toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toContain("Cannot find module '@server/embedded'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generating the manifest is all a clean clone needs to load the server", () => {
  const dir = cleanClone();
  try {
    // The exact command every build path runs: the Dockerfile's build stage,
    // scripts/dev.sh, `make embed`, and the release workflow.
    const gen = Bun.spawnSync(["bun", "run", "scripts/gen-embedded.ts"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(gen.exitCode, new TextDecoder().decode(gen.stderr)).toBe(0);

    const r = Bun.spawnSync(["bun", "-e", "await import('./src/server/routes.ts')"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Docker build stage generates the manifest, in the stage that copies src", () => {
  const genAt = dockerfile.indexOf("scripts/gen-embedded.ts");
  expect(genAt, "the image cannot boot without this step").toBeGreaterThan(-1);
  // It must run in the BUILD stage: the runtime stage copies /app/src from it,
  // and a manifest generated after that copy would never reach the image.
  const runtimeStageAt = dockerfile.indexOf("FROM oven/bun:1-alpine\n");
  expect(runtimeStageAt).toBeGreaterThan(-1);
  expect(genAt).toBeLessThan(runtimeStageAt);
});

test(".dockerignore stops a developer's local manifest from riding into the image", () => {
  // Without this the image inherits whatever is on the machine that built it,
  // which is precisely why a non-booting image passed review.
  for (const entry of [
    "src/server/embedded.ts",
    "dist/",
    "node_modules/",
    ".worktrees/",
    ".superpowers/",
  ]) {
    expect(dockerignore, `.dockerignore must exclude ${entry}`).toContain(entry);
  }
});

test("the dev loop generates the manifest before it starts the server", () => {
  // A new contributor's first command is `make dev`, which is only this
  // script. Without the generator it dies the same way the image did.
  //
  // Comments are stripped first: the script's header quotes the one-liner it
  // replaced, `bun run dev:server & bun run dev:web`, and an ordering check
  // against prose rather than code would compare the wrong two positions.
  const code = devsh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const genAt = code.indexOf("scripts/gen-embedded.ts");
  const serverAt = code.indexOf("bun run dev:server");
  expect(genAt).toBeGreaterThan(-1);
  expect(serverAt).toBeGreaterThan(-1);
  expect(genAt).toBeLessThan(serverAt);
});
