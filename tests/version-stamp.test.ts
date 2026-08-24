import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The version is injected at compile time by `bun build --define`, and until
 * now nothing ever ran a binary and read it back.
 *
 * That gap is not cosmetic. If the `--define` quoting breaks — in the Makefile
 * or in .github/workflows/release.yml, both of which nest quotes inside a
 * shell string — every released binary reports `0.0.0-dev`. `src/server/
 * update.ts` refuses to update a `0.0.0-dev` build by design (a source
 * checkout must never overwrite the operator's `bun`), so `paddock update`
 * would then decline on *every* release: the headline feature of this branch,
 * dead, with the whole suite green.
 *
 * These tests exercise the real mechanism end to end — compile, run, read
 * stdout — rather than asserting on the shape of a build command. The
 * workflow's own quoting is verified separately, on the real artifact, by the
 * smoke step in release.yml (see tests/release-workflow.test.ts).
 */

/**
 * Compiled binaries never need the network or the operator's real config.
 *
 * And they must never inherit `PADDOCK_VERSION`. The Makefile derives it from
 * `git describe` and EXPORTS it (Makefile:23-24), so at a tagged checkout every
 * child process sees a real version — and a tagged checkout is precisely what a
 * release is. The unstamped test below then read 0.9.0 where it asserted
 * 0.0.0-dev, and `make test` failed inside the release pipeline while passing
 * on every branch and every PR. It cost a failed release to find, because
 * nothing else in the suite runs only at a tag.
 *
 * A test about the absence of a stamp has to construct that absence rather than
 * hope the environment lacks it.
 */
function isolatedEnv(configDir: string): Record<string, string> {
  const env = {
    ...process.env,
    PADDOCK_NO_UPDATE_CHECK: "1",
    PADDOCK_CONFIG_DIR: configDir,
  } as Record<string, string>;
  delete env.PADDOCK_VERSION;
  return env;
}

function compile(define: string | null): { out: string; work: string } {
  const work = mkdtempSync(join(tmpdir(), "paddock-version-"));
  const out = join(work, "paddock");
  const args = ["bun", "build", "--compile", "--target=bun"];
  // Passed as its own argv entry, exactly as the Makefile and release.yml
  // hand it to bun — no shell in between to re-interpret the quotes.
  if (define !== null) args.push("--define", define);
  args.push("src/server/index.ts", "--outfile", out);
  const build = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  return { out, work };
}

test("a compiled binary reports the version stamped into it", () => {
  const { out, work } = compile('process.env.PADDOCK_VERSION="9.9.9-stamped"');
  try {
    const r = Bun.spawnSync([out, "--version"], {
      env: isolatedEnv(join(work, "config")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("9.9.9-stamped");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("-V is the same thing, since the README and --help both offer it", () => {
  const { out, work } = compile('process.env.PADDOCK_VERSION="1.2.3"');
  try {
    const r = Bun.spawnSync([out, "-V"], {
      env: isolatedEnv(join(work, "config")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("1.2.3");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);

test("an unstamped build reports 0.0.0-dev, so a self-built binary always says so", () => {
  // The other half of the contract: a binary someone compiled themselves must
  // be identifiable in a bug report, and must be refused by `paddock update`.
  const { out, work } = compile(null);
  try {
    const r = Bun.spawnSync([out, "--version"], {
      env: isolatedEnv(join(work, "config")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("0.0.0-dev");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
