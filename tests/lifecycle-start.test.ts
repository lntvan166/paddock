import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childCommand, runStart } from "@server/lifecycle/commands";
import { stateFile, writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-start-"));

test("the child command re-invokes this build, not a guess at it", () => {
  // Under `bun src/...` argv[1] is the script; in a compiled binary it is
  // /$bunfs/root/... and must NOT be passed on — the executable is self-contained.
  const cmd = childCommand();
  expect(cmd.length).toBeGreaterThan(0);
  expect(cmd[0]).toBe(process.execPath);
  expect(cmd.some((a) => a.startsWith("/$bunfs/"))).toBe(false);
});

test("childCommand forwards --demo only when the parent was started with it", () => {
  // `paddock start --demo` used to silently detach a REAL, non-demo instance
  // — the flag was typed and discarded. That is the same shape as `paddock
  // updte` once silently becoming `serve` (see cli.ts): a flag or verb typed
  // and thrown away instead of acted on or refused. Forward it; do not
  // refuse it — a detached demo instance is a legitimate thing to want, and
  // this project's own screenshots depend on `--demo` being a real mode.
  const withDemo = childCommand({ demo: true });
  expect(withDemo).toContain("--demo");
  const without = childCommand();
  expect(without).not.toContain("--demo");
  expect(childCommand({ demo: false })).not.toContain("--demo");
});

test("start refuses when one is already running, and does not spawn", async () => {
  const d = await dir();
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
  const probe: Probe = { isAlive: () => true, argsOf: () => "paddock" };
  let spawned = 0;
  const out: string[] = [];
  const code = await runStart({
    dir: d, probe, log: (l) => out.push(l), spawn: () => { spawned++; return { pid: 1, exited: new Promise(() => {}) }; },
  });
  expect(spawned).toBe(0);
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("4242");
});

test("a detached child that binds is reported as started", async () => {
  const d = await dir();
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    log: () => {},
    waitMs: 3000,
    spawn: () => {
      // Model a child that writes its state shortly after being spawned.
      void (async () => {
        await Bun.sleep(50);
        await writeState(d, { pid: 777, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
      })();
      return { pid: 777, exited: new Promise(() => {}) };
    },
    healthCheck: async () => true,
  });
  expect(code).toBe(0);
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(777);
});

test("a child that exits before binding fails loudly, surfaces the log, and does NOT wait out the timeout", async () => {
  // The design requires the early exit to be "an immediate failure rather
  // than waiting out the timeout", and until now nothing asserted the second
  // half: with `waitMs` at 3s this passed whether or not `if (childGone)
  // break` existed, because waiting the full 3s reaches the same message and
  // the same exit code. The generous `waitMs` below is the whole point —
  // 30s is far longer than any child needs to fail, so a run that takes
  // anywhere near it is a run that watched the child die and kept polling
  // anyway. Deleting the break makes this red on the elapsed assertion, not
  // on a harness timeout.
  const d = await dir();
  const out: string[] = [];
  const started = Date.now();
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => false, argsOf: () => null },
    log: (l) => out.push(l),
    waitMs: 30_000,
    logTail: async () => "Error: port 8787 already in use",
    spawn: () => ({ pid: 778, exited: Promise.resolve(1) }),
    healthCheck: async () => false,
  });
  const elapsed = Date.now() - started;
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("already in use");
  expect(elapsed, `start waited ${elapsed}ms for a child that had already exited`)
    .toBeLessThan(5_000);
}, 60_000);

// --- Cases that post-date the original brief -------------------------------

test("an unreadable state file is refused, not guessed at — start never spawns", async () => {
  // Same reasoning as runStatus/runStop: an I/O error reading the state file
  // is "cannot tell", not "nothing running". Guessing "nothing running" here
  // would let start spawn a second instance right alongside one already
  // serving — exactly the hazard this whole module exists to prevent.
  const d = await dir();
  await mkdir(stateFile(d));
  let spawned = 0;
  const out: string[] = [];
  const code = await runStart({
    dir: d,
    log: (l) => out.push(l),
    spawn: () => { spawned++; return { pid: 1, exited: new Promise(() => {}) }; },
  });
  expect(spawned, "an unreadable state file must never lead to a spawn").toBe(0);
  expect(code).not.toBe(0);
  expect(out.join(" ").toLowerCase()).toContain("could not read");
});

test("a stale state file is cleared before spawning, not left for the poll loop to trip over", async () => {
  // Ruling: if start fell through on `stale` without clearing it, the poll
  // loop below would read the dead instance's own (still "running"-shaped)
  // file until the new child happened to overwrite it — working by
  // accident, since `probe.isAlive` here always says dead so `checkState`
  // would keep reporting "stale" (not "running") on the OLD file forever.
  // The child in this test never writes a state file of its own, so success
  // is impossible unless the loop is looking at the dead instance's leftover
  // file — proving the clear happened is exactly what makes this time out
  // rather than falsely report the old pid as started.
  const d = await dir();
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
  const probe: Probe = { isAlive: () => false, argsOf: () => null }; // the old pid is dead
  const code = await runStart({
    dir: d,
    probe,
    log: () => {},
    waitMs: 300,
    spawn: () => ({ pid: 999, exited: new Promise(() => {}) }),
    healthCheck: async () => true,
  });
  expect(code, "no child ever wrote state, so this must time out, not succeed").not.toBe(0);
  // The old stale file must be gone, not left in place for a future poll to
  // misread as "running".
  await expect(readFile(stateFile(d), "utf8")).rejects.toThrow();
});

test("a mismatched state file (pid recycled) is cleared before spawning, not left for the poll loop to trip over", async () => {
  // `mismatch` and `stale` are structurally identical in runStart — both
  // clear the old state and fall through to spawning — but only `stale` had
  // a test. Same proof as above, applied to the other untested arm: the
  // recorded pid is alive but running something else now, so if the old
  // file were left in place the poll loop could misread it. The child in
  // this test never writes a state file of its own, so success is
  // impossible unless the mismatched file was actually cleared.
  const d = await dir();
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() });
  const probe: Probe = { isAlive: () => true, argsOf: () => "/usr/bin/postgres -D /var/lib/pg" };
  const code = await runStart({
    dir: d,
    probe,
    log: () => {},
    waitMs: 300,
    spawn: () => ({ pid: 999, exited: new Promise(() => {}) }),
    healthCheck: async () => true,
  });
  expect(code, "no child ever wrote state, so this must time out, not succeed").not.toBe(0);
  await expect(readFile(stateFile(d), "utf8")).rejects.toThrow();
});

test("a child still running at the timeout is reported as running, by pid — not as 'did not start'", async () => {
  // Ruling on the review's finding: do NOT kill it. Everything else here
  // refuses to signal on its own, and a child that bound but answers
  // /api/health slowly is a working paddock, not garbage to clean up. What
  // was wrong was the report, not the restraint — it said "the detached
  // process did not start" and exited, leaving a live process holding the
  // port and an operator with no pid and no next step.
  const d = await dir();
  const out: string[] = [];
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    log: (l) => out.push(l),
    waitMs: 300,
    logTail: async () => "",
    // Never exits, so this is the timeout arm and not the early-exit one.
    spawn: () => ({ pid: 4242, exited: new Promise(() => {}) }),
    healthCheck: async () => false,
  });
  const said = out.join(" ");
  expect(code).not.toBe(0);
  expect(said, "the operator cannot act without the pid").toContain("4242");
  expect(said).toContain("/api/health");
  expect(said, "must point at the command that deals with it").toContain("paddock stop");
  expect(said, "it WAS started — saying otherwise is the bug being fixed here")
    .not.toContain("did not start");
});

test("start refuses before spawning when the config dir cannot hold the log", async () => {
  // The design's failure table: "start where the config dir is unwritable ->
  // Refuse before spawning, exit non-zero." It used to throw EACCES with a
  // stack trace out of spawnDetached instead. (The ENOTDIR variant already
  // refused, because checkState reports `unreadable` first and start stops
  // there; this is the EACCES-on-an-existing-directory case that got past it.)
  const d = await dir();
  let why: string;
  if (process.getuid?.() === 0) {
    // chmod means nothing to root, and CI is entitled to run as root. A
    // directory sitting where the log file goes is EISDIR for everyone, and
    // reaches the identical mkdir/open failure path.
    await mkdir(join(d, "paddock.log"));
    why = "a directory where paddock.log goes";
  } else {
    await chmod(d, 0o500);
    why = "an existing config dir with no write permission";
  }
  const out: string[] = [];
  // No injected `spawn`: the real path is the one that used to throw, and a
  // stub would test nothing. It is safe because the refusal happens before
  // any spawn — if that regresses, this test starts a real detached paddock
  // and the missing refusal message fails it either way.
  const code = await runStart({ dir: d, log: (l) => out.push(l), waitMs: 300 });
  expect(code, why).not.toBe(0);
  expect(out.join(" "), "the refusal must name the directory").toContain(d);
  expect(out.join(" ").toLowerCase()).toContain("not start");
});
