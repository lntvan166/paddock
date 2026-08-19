import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("an unwritable config dir does not kill an already-bound paddock", async () => {
  // A dir whose PARENT is a regular file is ENOTDIR for every user, root
  // included — the same trick tests/lifecycle-state.test.ts uses for its
  // "unreadable" case, chosen for the same reason: chmod alone would not
  // stop a CI container running as root.
  const parent = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const cfg = join(blocker, "child");

  const port = 9010 + Math.floor(performance.now() % 40);
  const proc = Bun.spawn(["bun", "src/server/index.ts", "--demo"], {
    env: {
      ...process.env,
      PADDOCK_PORT: String(port),
      PADDOCK_CONFIG_DIR: cfg,
      PADDOCK_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });

  let ok = false;
  try {
    for (let i = 0; i < 60 && !ok; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        ok = res.ok;
      } catch { await Bun.sleep(100); }
    }
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }

  // The dashboard is the product; a state file it could never write must not
  // take it down.
  expect(ok, "an unwritable config dir killed an already-bound paddock").toBe(true);

  const stderrText = await new Response(proc.stderr).text();
  expect(stderrText).toContain("could not record state");
}, 60_000);
