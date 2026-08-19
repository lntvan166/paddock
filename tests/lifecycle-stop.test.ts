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

// --- The wait loop's two very different "argsOf disagrees" cases ------------

test("a pid recycled DURING the wait is refused and reported, not called a success", async () => {
  // The in-loop branch used to print "already gone, nothing further to do",
  // delete the state file and exit 0 — for the identical condition that the
  // pre-SIGKILL re-check treats as a refusal with a non-zero exit. So a
  // paddock that was still very much running could be made permanently
  // untrackable by a stop that reported success. The design's failure table
  // has one row for this: "stop where the PID is now someone else -> Name
  // the PID and its real command, remove the file, exit non-zero."
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const out: string[] = [];
  let calls = 0;
  const code = await runStop({
    dir: d,
    // Matches for checkState and the first poll, then the number belongs to
    // something else. Alive throughout: this is a recycle, not an exit.
    probe: { isAlive: () => true, argsOf: () => (++calls <= 2 ? "paddock" : "/usr/bin/postgres -D /var/lib/pg") },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
    waitMs: 2000,
  });
  expect(sent, "nothing further may be signalled once the pid is not ours").toEqual(["SIGTERM->4242"]);
  expect(code, "a recycled pid is a refusal, not a success").not.toBe(0);
  expect(out.join(" ")).toContain("not paddock any more");
  expect(out.join(" ")).toContain("postgres");
  expect(existsSync(stateFile(d)), "the file names a pid that is no longer ours").toBe(false);
});

test("an indeterminate argsOf during the wait concludes nothing and keeps polling", async () => {
  // The zombie window, and the reason the in-loop check must NOT simply
  // refuse whenever argsOf returns null: during an ordinary stop the process
  // is briefly a zombie, where /proc/<pid>/cmdline reads empty — so argsOf
  // says null while kill(pid, 0) still succeeds. Treating that as a recycle
  // would turn every normal stop into a refusal; treating it as success (the
  // old behaviour) declares victory over a process that has not gone
  // anywhere. It is neither: it is "cannot tell", so conclude nothing and
  // let the loop end on a fact — the pid going away, below.
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  let liveness = 0;
  let args = 0;
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => ++liveness <= 4, argsOf: () => (++args <= 1 ? "paddock" : null) },
    signal: () => {},
    log: (l) => out.push(l),
    waitMs: 2000,
  });
  expect(code, "the pid did go away — that is an ordinary successful stop").toBe(0);
  expect(liveness, "success was declared before the pid was observed gone").toBeGreaterThan(2);
  expect(out.join(" ")).toContain("stopped");
  expect(out.join(" "), "nothing was concluded from the null — there was nothing to conclude")
    .not.toContain("nothing further to do");
});

test("an indeterminate argsOf on a pid that will not die is a timeout, not a success", async () => {
  // The other way the loop can end once null stops being a conclusion: the
  // process is alive for the whole window and never becomes identifiable.
  // Still not a success, and still no automatic escalation.
  const d = await dir();
  await writeState(d, s);
  const sent: string[] = [];
  const out: string[] = [];
  let args = 0;
  const code = await runStop({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => (++args <= 1 ? "paddock" : null) },
    signal: (pid, sig) => sent.push(`${sig}->${pid}`),
    log: (l) => out.push(l),
    waitMs: 300,
  });
  expect(sent).toEqual(["SIGTERM->4242"]);
  expect(code).not.toBe(0);
  expect(out.join(" ")).toContain("--force");
});
