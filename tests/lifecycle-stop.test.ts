import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "@server/lifecycle/commands";
import { stateFile, writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-stop-"));
const s = { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() };

/** Alive until the Nth liveness check, then dead — models a process obeying SIGTERM. */
function dyingProbe(afterChecks: number, args: string): { probe: Probe } {
  let n = 0;
  return { probe: { isAlive: () => ++n <= afterChecks, argsOf: () => args } };
}

test("stop on a recycled pid REFUSES to signal it", async () => {
  // The worst outcome this feature can produce is killing someone else's
  // process. Nothing may be signalled unless the args still match.
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "/usr/bin/postgres -D /var/lib/pg" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: () => {},
  });
  expect(sent, "a signal was sent to a process that is not paddock").toEqual([]);
  expect(code).not.toBe(0);
});

test("stop signals SIGTERM and reports success once it exits", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const { probe } = dyingProbe(1, "paddock");
  const code = await runStop({
    dir: d, probe, signal: (pid, sig) => sent.push(`${sig}->${pid}`), log: () => {}, waitMs: 500,
  });
  expect(sent).toEqual(["SIGTERM->4242"]);
  expect(code).toBe(0);
});

test("a process that will not die is reported, and is NOT killed automatically", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const out: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
    waitMs: 300,
  });
  expect(sent).toEqual(["SIGTERM->4242"]);
  expect(out.join(" ")).toContain("--force");
  expect(code).not.toBe(0);
});

test("--force escalates to SIGKILL, and only then", async () => {
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const code = await runStop({
    dir: d,
    force: true,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: () => {},
    waitMs: 300,
  });
  expect(sent).toEqual(["SIGTERM->4242", "SIGKILL->4242"]);
  expect(code).toBe(0);
});

test("stop with nothing running is not an error", async () => {
  const code = await runStop({
    dir: await dir(), probe: { isAlive: () => false, argsOf: () => null },
    signal: () => { throw new Error("must not signal"); }, log: () => {},
  });
  expect(code).toBe(0);
});

test("an unreadable state file is refused, not guessed at — and left in place", async () => {
  // Task 1's review added a fifth StateCheck variant: `unreadable`. Only
  // ENOENT collapses to "none"; anything else is "cannot tell", and stop
  // must neither signal on a guess nor delete the one clue an operator has.
  // A directory sitting where the state file should be is a real, portable
  // way to force readFile to fail with something other than ENOENT (EISDIR),
  // with no permissions hacks required.
  const d = await dir();
  await mkdir(stateFile(d));
  const sent: string[] = [];
  const out: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
  });
  expect(sent, "an unreadable state file must never be signalled against").toEqual([]);
  expect(code).not.toBe(0);
  expect(out.join(" ").toLowerCase()).toContain("could not read");
  // The third part of the requirement: don't delete it either. It is the one
  // clue an operator has, and adding a stray `removeState` to the
  // `unreadable` branch would leave the first two assertions above green.
  expect(existsSync(stateFile(d)), "the unreadable state file must be left in place").toBe(true);
});

test("a pid recycled right as the wait expires is treated as gone, not escalated", async () => {
  // The gap this closes: `isAlive` alone cannot tell "still exiting" from
  // "already gone and the number reused". The wait loop polls every 100ms,
  // so a recycle landing in the window AFTER its last poll but BEFORE the
  // pre-SIGKILL re-check is invisible to the loop itself — which is exactly
  // why a second, immediate check is required right before SIGKILL, not just
  // inside the loop. Modelled by time rather than a call count: `argsOf`
  // matches for the whole `waitMs` window (so every in-loop poll sees a
  // match and the loop runs to its natural timeout), then flips the instant
  // `waitMs` has elapsed — landing on the pre-SIGKILL re-check, not on any
  // poll before it.
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const out: string[] = [];
  const waitMs = 300;
  const start = Date.now();
  const code = await runStop({
    dir: d,
    force: true,
    probe: {
      isAlive: () => true,
      argsOf: () => (Date.now() - start < waitMs ? "paddock" : "/usr/bin/postgres -D /var/lib/pg"),
    },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
    waitMs,
  });
  expect(sent, "no SIGKILL may reach a pid that is no longer paddock").toEqual(["SIGTERM->4242"]);
  expect(code).not.toBe(0);
});

function errnoError(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

test("a pid that already exited between the check and the signal (ESRCH) is reported as gone", async () => {
  // process.kill can throw ESRCH if the process exits in the gap between our
  // liveness probe and the signal call. That is an ordinary race, not a bug
  // to crash on — it must be reported as "already gone", the same as a clean
  // stop, not let an unhandled exception escape runStop.
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: () => { throw errnoError("ESRCH"); },
    log: (l) => out.push(l),
  });
  expect(code).toBe(0);
  expect(out.join(" ").toLowerCase()).toContain("already gone");
});

test("a pid owned by another user (EPERM) is refused by name, not an unhandled throw", async () => {
  // systemProbe.isAlive deliberately treats EPERM as "alive" (see state.ts),
  // and /proc/<pid>/cmdline is world-readable, so a paddock started under a
  // different uid can reach the `running` case here and then fail to be
  // signalled. The operator must see a clear reason, not a raw stack trace.
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => "paddock" },
    signal: () => { throw errnoError("EPERM"); },
    log: (l) => out.push(l),
  });
  expect(code).not.toBe(0);
  expect(out.join(" ").toLowerCase()).toContain("permission denied");
});
