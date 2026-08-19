import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedArgs, checkState, removeState, stateFile, writeState,
  type PaddockState, type Probe,
} from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-state-"));
const state = (over: Partial<PaddockState> = {}): PaddockState => ({
  pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: 1_700_000_000_000, ...over,
});
const probe = (alive: boolean, args: string | null): Probe =>
  ({ isAlive: () => alive, argsOf: () => args });

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
  const got = await checkState(d, probe(true, "/usr/bin/postgres -D /var/lib/pg"));
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

test("a corrupt state file is treated as absent, not as a crash", async () => {
  const d = await dir();
  await writeFile(stateFile(d), "{ not json");
  expect((await checkState(d, probe(true, "paddock"))).kind).toBe("none");
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
