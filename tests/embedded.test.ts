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
  // `--demo` rather than a live/nonexistent herdr socket: index.ts exits
  // non-zero when it cannot reach herdr at startup at all (a separate,
  // pre-existing behavior — see `checkProtocol` in src/server/index.ts —
  // that this task does not touch), which would fail this test for a reason
  // that has nothing to do with embedded assets. Demo mode is the sanctioned
  // way to run paddock with no herdr connection at all.
  const proc = Bun.spawn([out, "--demo"], {
    cwd: runDir,
    env: { ...process.env, PADDOCK_PORT: String(port) },
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
