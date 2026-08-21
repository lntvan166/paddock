import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFile } from "@server/lifecycle/state";
import { freePort } from "./support/port";

test("a running paddock writes its state after binding, and clears it on exit", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const port = freePort();
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
  const port = freePort();
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

  const port = freePort();
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

test("a second paddock on ANOTHER port neither takes over nor deletes the first's state", async () => {
  // THE ORPHAN BUG, at the level it actually bit: two instances that both bind
  // fine. `PADDOCK_PORT=8788 paddock`, a `--demo` on a spare port and a dev
  // server are separate serving processes sharing ONE state file, so
  // B used to overwrite A's record on start and delete the file outright on
  // exit. A then held its port for the rest of its life with nothing tracking
  // it: `stop` said "not running", and `start` refused the port it held.
  const cfg = await mkdtemp(join(tmpdir(), "paddock-cfg-"));
  const base = {
    ...process.env, PADDOCK_CONFIG_DIR: cfg, PADDOCK_NO_UPDATE_CHECK: "1",
  };
  const portA = freePort();
  const portB = freePort();

  const a = Bun.spawn(["bun", "src/server/index.ts", "--demo"],
    { env: { ...base, PADDOCK_PORT: String(portA) }, stdout: "pipe", stderr: "pipe" });
  try {
    let aState: string | null = null;
    for (let i = 0; i < 60 && aState === null; i++) {
      try { aState = await readFile(stateFile(cfg), "utf8"); } catch { await Bun.sleep(100); }
    }
    expect(aState, "instance A's state file never appeared").not.toBeNull();
    expect(JSON.parse(aState!).pid).toBe(a.pid);

    const b = Bun.spawn(["bun", "src/server/index.ts", "--demo"],
      { env: { ...base, PADDOCK_PORT: String(portB) }, stdout: "pipe", stderr: "pipe" });
    // B really is serving — this is not the losing-bind case.
    let bUp = false;
    for (let i = 0; i < 60 && !bUp; i++) {
      try { bUp = (await fetch(`http://127.0.0.1:${portB}/api/health`)).ok; } catch { await Bun.sleep(100); }
    }
    expect(bUp, "instance B never came up on its own port").toBe(true);

    // First instance wins the record.
    expect(JSON.parse(await readFile(stateFile(cfg), "utf8")).pid).toBe(a.pid);

    b.kill("SIGTERM");
    await b.exited;
    // And B's exit must leave A's record alone. This is the half that made the
    // orphan permanent.
    const afterB = await readFile(stateFile(cfg), "utf8");
    expect(JSON.parse(afterB).pid, "B's shutdown deleted or rewrote A's record").toBe(a.pid);
    expect(JSON.parse(afterB).port).toBe(portA);

    // A is still both serving and trackable.
    expect((await fetch(`http://127.0.0.1:${portA}/api/health`)).ok).toBe(true);
  } finally {
    a.kill("SIGTERM");
    await a.exited;
  }
}, 60_000);
