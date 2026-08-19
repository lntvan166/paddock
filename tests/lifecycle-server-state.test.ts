import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFile } from "@server/lifecycle/state";

test("a running paddock writes its state after binding, and clears it on exit", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const port = 8930 + Math.floor(performance.now() % 40);
  const proc = Bun.spawn(["bun", "src/server/index.ts", "--demo"], {
    env: {
      ...process.env,
      PADDOCK_PORT: String(port),
      PADDOCK_CONFIG_DIR: cfg,
      PADDOCK_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    let body: string | null = null;
    for (let i = 0; i < 60 && body === null; i++) {
      try { body = await readFile(stateFile(cfg), "utf8"); } catch { await Bun.sleep(100); }
    }
    expect(body, "state file never appeared").not.toBeNull();
    const s = JSON.parse(body!);
    expect(s.pid).toBe(proc.pid);
    expect(s.port).toBe(port);
    expect(typeof s.args).toBe("string");
    expect(s.args.length).toBeGreaterThan(0);
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }

  // Removed on a clean SIGTERM, or every crash-free stop would leave litter
  // that the next `status` has to reason about.
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    try { await readFile(stateFile(cfg), "utf8"); await Bun.sleep(100); } catch { gone = true; }
  }
  expect(gone, "state file survived a clean shutdown").toBe(true);
}, 60_000);

test("a second paddock that loses the port race does not clobber the first's state", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const port = 8970 + Math.floor(performance.now() % 40);
  const env = {
    ...process.env,
    PADDOCK_PORT: String(port),
    PADDOCK_CONFIG_DIR: cfg,
    PADDOCK_NO_UPDATE_CHECK: "1",
  };

  const a = Bun.spawn(["bun", "src/server/index.ts", "--demo"], { env, stdout: "pipe", stderr: "pipe" });
  try {
    let aState: string | null = null;
    for (let i = 0; i < 60 && aState === null; i++) {
      try { aState = await readFile(stateFile(cfg), "utf8"); } catch { await Bun.sleep(100); }
    }
    expect(aState, "instance A's state file never appeared").not.toBeNull();
    expect(JSON.parse(aState!).pid).toBe(a.pid);

    // Same port, same config dir: B must lose the bind and must never get the
    // chance to overwrite A's file with its own (losing) pid.
    const b = Bun.spawn(["bun", "src/server/index.ts", "--demo"], { env, stdout: "pipe", stderr: "pipe" });
    const bExit = await b.exited;
    expect(bExit, "instance B unexpectedly bound the port").not.toBe(0);

    const stillA = await readFile(stateFile(cfg), "utf8");
    expect(JSON.parse(stillA).pid, "A's state file was overwritten by B").toBe(a.pid);
  } finally {
    a.kill("SIGTERM");
    await a.exited;
  }
}, 60_000);
