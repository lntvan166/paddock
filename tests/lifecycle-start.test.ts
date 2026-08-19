import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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

test("a child that exits before binding fails loudly and surfaces the log", async () => {
  const d = await dir();
  const out: string[] = [];
  const code = await runStart({
    dir: d,
    probe: { isAlive: () => false, argsOf: () => null },
    log: (l) => out.push(l),
    waitMs: 3000,
    logTail: async () => "Error: port 8787 already in use",
    spawn: () => ({ pid: 778, exited: Promise.resolve(1) }),
    healthCheck: async () => false,
  });
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("already in use");
}, 15_000);

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
