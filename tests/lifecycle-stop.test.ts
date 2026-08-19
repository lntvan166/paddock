import { expect, test } from "bun:test";
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
});
