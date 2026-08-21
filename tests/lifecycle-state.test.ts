import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedArgs,
  checkState,
  recordState,
  removeOwnState,
  removeState,
  stateFile,
  writeState,
  type PaddockState,
  type Probe,
} from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-state-"));
const state = (over: Partial<PaddockState> = {}): PaddockState => ({
  pid: 4242,
  args: "paddock",
  port: 8787,
  version: "0.4.0",
  startedAt: 1_700_000_000_000,
  ...over,
});
const probe = (alive: boolean, args: string | null): Probe => ({
  isAlive: () => alive,
  argsOf: () => args,
});

test("no state file means not running", async () => {
  expect((await checkState(await dir(), probe(false, null))).kind).toBe("none");
});

test("the file is written 0600 and round-trips", async () => {
  const d = await dir();
  await writeState(d, state());
  expect((await stat(stateFile(d))).mode & 0o777).toBe(0o600);
  const back = JSON.parse(await readFile(stateFile(d), "utf8"));
  expect(back).toEqual(state());
});

test("a dead PID is stale, not running", async () => {
  const d = await dir();
  await writeState(d, state());
  expect((await checkState(d, probe(false, null))).kind).toBe("stale");
});

test("a live PID running something else is a MISMATCH, never running", async () => {
  // The failure this prevents: the kernel recycled the PID, and `stop` would
  // otherwise signal a stranger.
  const d = await dir();
  await writeState(d, state({ args: "paddock" }));
  const got = await checkState(
    d,
    probe(true, "/usr/bin/postgres -D /var/lib/pg"),
  );
  expect(got.kind).toBe("mismatch");
  if (got.kind === "mismatch") expect(got.actual).toContain("postgres");
});

test("alive and matching is running", async () => {
  const d = await dir();
  await writeState(d, state({ args: "paddock start" }));
  const got = await checkState(d, probe(true, "paddock start"));
  expect(got.kind).toBe("running");
  if (got.kind === "running") expect(got.state.port).toBe(8787);
});

test("a corrupt state file is treated as absent, not as a crash — but SAID, not swallowed", async () => {
  // "none" is the right answer and stays: treating garbage as "running" would
  // let one bad file block every start. The silence was the bug. A corrupt or
  // wrong-shaped file means `start` will spawn a second instance beside a live
  // one and `status` will report "not running" while paddock is serving, and
  // an empty catch block is exactly the shape CLAUDE.md forbids: the operator
  // gets a wrong answer with no way to find out why.
  const d = await dir();
  await writeFile(stateFile(d), "{ not json");
  const said: string[] = [];
  expect(
    (await checkState(d, probe(true, "paddock"), (l) => said.push(l))).kind,
  ).toBe("none");
  expect(
    said.length,
    "a corrupt state file was read and nothing was said",
  ).toBeGreaterThan(0);
  expect(said.join(" "), "the message must name the file").toContain(
    stateFile(d),
  );
});

test("a well-formed file of the wrong shape is reported too, not silently absent", async () => {
  // The other half of the same catch: valid JSON that is not a PaddockState.
  const d = await dir();
  await writeFile(stateFile(d), JSON.stringify({ pid: "not a number" }));
  const said: string[] = [];
  expect(
    (await checkState(d, probe(true, "paddock"), (l) => said.push(l))).kind,
  ).toBe("none");
  expect(said.length).toBeGreaterThan(0);
});

test("an I/O error reading the state file is reported, not swallowed as absent", async () => {
  // A permissions or other I/O failure must never look like "nothing ever ran
  // here" — that would let `start` believe the coast is clear and spawn a
  // second instance while one is already serving. chmod alone would not stop
  // root (CI containers commonly run as root), so make the directory itself
  // impossible to use rather than merely unreadable: point it at a path whose
  // PARENT is a regular file. That is ENOTDIR for every user, root included,
  // and it is a non-ENOENT I/O error, exercising the same branch a real
  // permissions failure would.
  const parent = await dir();
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const bogusDir = join(blocker, "child");

  const got = await checkState(bogusDir, probe(true, "paddock"));
  expect(got.kind).toBe("unreadable");
  if (got.kind === "unreadable") expect(got.error.length).toBeGreaterThan(0);
});

test("removeState is idempotent", async () => {
  const d = await dir();
  await removeState(d);
  await writeState(d, state());
  await removeState(d);
  expect((await checkState(d, probe(true, "paddock"))).kind).toBe("none");
});

test("capturedArgs reads a real process — this one — and agrees with ps", () => {
  // The value stored at startup must come from the same source that will be
  // asked at stop time. There are two implementations (/proc on Linux, ps on
  // macOS) and CI only ever runs one, so assert they agree wherever both exist.
  const mine = capturedArgs(process.pid);
  expect(mine, "nothing returned for our own pid").toBeTruthy();
  expect(mine!.length).toBeGreaterThan(0);

  const viaPs = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "args="]);
  if (viaPs.exitCode === 0) {
    const text = new TextDecoder().decode(viaPs.stdout).trim();
    if (text !== "") expect(mine).toBe(text);
  }

  expect(capturedArgs(0x7fffffff)).toBeNull();
});

// --- recordState: what a serving paddock writes about itself ---------------

test("an instance that cannot identify itself records NOTHING, and says why", async () => {
  // The bug this replaces: `args: capturedArgs(process.pid) ?? ""`.
  // capturedArgs maps empty to null on BOTH its branches, so it never returns
  // "" — meaning a recorded "" was an identity guaranteed to mismatch for
  // ever. The consequence was the opposite of what the fallback intended:
  // `status` and `stop` would both declare a perfectly healthy instance "pid
  // N is not paddock any more" and delete its state file. An untrackable
  // instance is more honest than a permanently mis-tracked one.
  const d = await dir();
  const said: string[] = [];
  const ok = await recordState(
    d,
    { pid: 4242, port: 8787, version: "0.4.0", startedAt: 1_700_000_000_000 },
    { capture: () => null, log: (l) => said.push(l) },
  );
  expect(ok).toBe(false);
  expect(
    (await checkState(d, probe(true, "paddock"))).kind,
    "an unmatchable identity was written",
  ).toBe("none");
  expect(
    said.join(" "),
    "silence would leave 'stop' mysteriously unable to find it",
  ).toContain("4242");
});

test("recordState writes the captured identity verbatim", async () => {
  const d = await dir();
  const ok = await recordState(
    d,
    { pid: 4242, port: 8787, version: "0.4.0", startedAt: 1_700_000_000_000 },
    { capture: () => "./bin/paddock --demo" },
  );
  expect(ok).toBe(true);
  const got = await checkState(d, probe(true, "./bin/paddock --demo"));
  expect(got.kind).toBe("running");
});

test("a config dir it cannot write is reported and NOT fatal — the server keeps serving", async () => {
  // Same posture as the commit that made an unwritable config dir non-fatal to
  // an already-bound paddock: the dashboard is the product, and `status` and
  // `stop` are conveniences on top of it. recordState must therefore report
  // and return, never throw. ENOTDIR (a parent that is a regular file) is the
  // portable way to force this — root ignores chmod.
  const parent = await dir();
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const said: string[] = [];
  const ok = await recordState(
    join(blocker, "child"),
    { pid: 4242, port: 8787, version: "0.4.0", startedAt: 1_700_000_000_000 },
    { capture: () => "paddock", warn: (l) => said.push(l) },
  );
  expect(ok).toBe(false);
  expect(said.join(" ")).toContain("could not record state");
});

test("a capture that throws does not take an already-bound server down", async () => {
  // capturedArgs falls back to Bun.spawnSync(["ps", ...]), which throws when
  // `ps` is missing rather than returning a non-zero exit. recordState runs
  // at top level immediately after the bind, so a throw escaping it would
  // kill a paddock that is already serving. It must be reported and swallowed
  // into `false`, the same as every other identity failure.
  const d = await dir();
  const warned: string[] = [];
  const ok = await recordState(
    d,
    { pid: 4242, port: 8787, version: "0.0.0-test", startedAt: 1787000000000 },
    {
      capture: () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn 'ps'");
      },
      log: () => {},
      warn: (l) => warned.push(l),
    },
  );
  expect(ok, "a failed capture is a false, never a throw").toBe(false);
  expect(
    existsSync(stateFile(d)),
    "no state file may be written from a failed capture",
  ).toBe(false);
  expect(
    warned.join(" "),
    "the failure must be announced, not swallowed",
  ).toContain("ps");
});

test("an argsOf that throws is 'cannot tell', not 'someone else owns this pid'", async () => {
  // The default probe's argsOf falls back to Bun.spawnSync(["ps", ...]), which
  // throws when `ps` is absent rather than returning a non-zero exit. Letting
  // that escape crashes status/stop/start; reporting it as `mismatch` would be
  // worse than crashing, because every mismatch arm DELETES the state file —
  // so a machine without `ps` would quietly untrack a healthy instance.
  // "Could not look" is the fact `unreadable` already names.
  const d = await dir();
  await writeState(d, {
    pid: 4242,
    args: "paddock",
    port: 8787,
    version: "t",
    startedAt: 1,
  });
  const got = await checkState(d, {
    isAlive: () => true,
    argsOf: () => {
      throw new Error("ENOENT: no such file or directory, posix_spawn 'ps'");
    },
  });
  expect(
    got.kind,
    "an unidentifiable pid is indeterminate, never a mismatch",
  ).toBe("unreadable");
  expect(
    existsSync(stateFile(d)),
    "nothing may be deleted on a 'cannot tell'",
  ).toBe(true);
});

// --- one state file, many instances ----------------------------------------
//
// THE ORPHAN BUG. There is one state file per config dir, but paddock is
// per-port: `PADDOCK_PORT=8788 paddock`, a `--demo` on another port, and dev
// or test servers are all separate serving processes writing this same file.
// (`paddock tunnel` is NOT one of them — it serves the dashboard itself and
// refuses to start beside a recorded instance.)
// Unguarded, the second to start overwrote the first's record and the first to
// EXIT deleted the file outright — so a long-running instance became
// permanently untrackable, and `stop` answered "not running" while the port
// stayed held and `start` refused it. Reproduced end to end before this
// guard existed.

test("recordState refuses to overwrite a DIFFERENT live instance's record", async () => {
  const d = await dir();
  await writeState(d, state({ pid: 4242, port: 8787, args: "paddock" }));
  const said: string[] = [];

  // A second instance, on another port, whose own identity captures fine.
  const ok = await recordState(
    d,
    { pid: 5150, port: 8788, version: "0.8.2", startedAt: 1_700_000_000_001 },
    {
      capture: () => "paddock",
      // The incumbent is alive and is what it says it is.
      probe: probe(true, "paddock"),
      warn: (l) => said.push(l),
      log: (l) => said.push(l),
    },
  );

  expect(ok).toBe(false);
  // The incumbent's record is intact — that is the whole point.
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(4242);
  // And the refusal is announced: an untracked instance the operator was not
  // told about is how this became invisible in the first place.
  expect(said.join("\n")).toContain("8787");
  expect(said.join("\n")).toContain("4242");
});

test("recordState still claims a record left by a DEAD instance", async () => {
  // The ordinary restart. A stale record must not lock the file for ever.
  const d = await dir();
  await writeState(d, state({ pid: 4242 }));
  const ok = await recordState(
    d,
    { pid: 5150, port: 8787, version: "0.8.2", startedAt: 1 },
    { capture: () => "paddock", probe: probe(false, null), warn: () => {}, log: () => {} },
  );
  expect(ok).toBe(true);
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(5150);
});

test("recordState overwrites its OWN earlier record", async () => {
  // Same pid, re-recording: not a conflict, and refusing would leave a live
  // instance describing itself with stale facts.
  const d = await dir();
  await writeState(d, state({ pid: 4242, port: 8787, version: "0.8.1" }));
  const ok = await recordState(
    d,
    { pid: 4242, port: 8787, version: "0.8.2", startedAt: 2 },
    { capture: () => "paddock", probe: probe(true, "paddock"), warn: () => {}, log: () => {} },
  );
  expect(ok).toBe(true);
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).version).toBe("0.8.2");
});

test("removeOwnState leaves a record that belongs to another instance", async () => {
  // The deletion half of the same bug. A demo or spare-port run exiting must not
  // untrack the instance that actually holds the dashboard's port.
  const d = await dir();
  await writeState(d, state({ pid: 4242, port: 8787 }));
  await removeOwnState(d, 5150);
  expect(existsSync(stateFile(d))).toBe(true);
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(4242);
});

test("removeOwnState removes its own record", async () => {
  const d = await dir();
  await writeState(d, state({ pid: 4242 }));
  await removeOwnState(d, 4242);
  expect(existsSync(stateFile(d))).toBe(false);
});

test("removeOwnState is quiet when there is no record at all", async () => {
  // Every exit path calls it, including those that never recorded anything.
  const d = await dir();
  await removeOwnState(d, 4242);
  expect(existsSync(stateFile(d))).toBe(false);
});

test("recordState survives a conflict check that THROWS, and still refuses", async () => {
  // recordState runs at top level immediately after the bind, and its contract
  // is that it never throws: an escaping rejection there kills a paddock that
  // is already serving — the failure this file's other guards exist to
  // prevent. The conflict check added a second way to throw (a probe reaching
  // for `ps`, a filesystem that fails in a new way) and it must be caught like
  // the identity capture below it.
  const d = await dir();
  await writeState(d, state({ pid: 4242 }));
  const said: string[] = [];
  const ok = await recordState(
    d,
    { pid: 5150, port: 8788, version: "0.8.2", startedAt: 1 },
    {
      capture: () => "paddock",
      probe: {
        isAlive: () => { throw new Error("ps: command not found"); },
        argsOf: () => "paddock",
      },
      warn: (l) => said.push(l),
      log: (l) => said.push(l),
    },
  );

  // Refused, not crashed. "Cannot tell who holds the record" must not become
  // "overwrite it": mis-tracking a live instance is the bug this guards.
  expect(ok).toBe(false);
  // And the incumbent's record is untouched.
  expect(JSON.parse(await readFile(stateFile(d), "utf8")).pid).toBe(4242);
  // Announced — an untracked instance nobody was told about is how this
  // became invisible in the first place.
  expect(said.join("\n")).toContain("ps: command not found");
});
