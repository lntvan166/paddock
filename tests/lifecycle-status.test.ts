import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@server/cli";
import { runStatus } from "@server/lifecycle/commands";
import { writeState, type Probe } from "@server/lifecycle/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-status-"));
const probe = (alive: boolean, args: string | null): Probe =>
  ({ isAlive: () => alive, argsOf: () => args });
const s = { pid: 4242, args: "paddock", port: 8787, version: "0.4.0", startedAt: Date.now() };

test("the three verbs parse", () => {
  expect(parseArgs(["start"]).command).toBe("start");
  expect(parseArgs(["stop"]).command).toBe("stop");
  expect(parseArgs(["status"]).command).toBe("status");
  expect(parseArgs(["stop", "--force"]).flags.has("--force")).toBe(true);
});

test("status exits 1 and says so when nothing is running", async () => {
  const out: string[] = [];
  const code = await runStatus({ dir: await dir(), probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out.join(" ")).toContain("not running");
});

test("status exits 0 and reports pid, port and version when running", async () => {
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l) });
  expect(code).toBe(0);
  const line = out.join(" ");
  expect(line).toContain("4242");
  expect(line).toContain("8787");
  expect(line).toContain("0.4.0");
});

test("a stale file is reported as stale, not silently as absence", async () => {
  // A crash left evidence; saying only "not running" throws it away.
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out.join(" ").toLowerCase()).toContain("stale");
});

test("a recycled pid is reported as such and names the real command", async () => {
  const d = await dir();
  await writeState(d, s);
  const out: string[] = [];
  const code = await runStatus({
    dir: d, probe: probe(true, "/usr/bin/postgres -D /var/lib/pg"), log: (l) => out.push(l),
  });
  expect(code).toBe(1);
  expect(out.join(" ")).toContain("postgres");
});

test("an unreadable state file is reported as such, distinct from absence", async () => {
  // "I could not read the state" and "nothing is running" are different
  // facts. Collapsing them into "not running" is exactly the guess this
  // module refuses to make. Same ENOTDIR trick lifecycle-state.test.ts uses:
  // chmod alone would not stop root, which CI containers commonly run as.
  const parent = await dir();
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const d = join(blocker, "child"); // stateFile(d)'s parent is a file: ENOTDIR, for every user

  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).not.toBe(0);
  const line = out.join(" ").toLowerCase();
  expect(line).not.toContain("not running");
  expect(line).toContain("could not");
});

test("status names an untracked instance instead of calling it 'not running'", async () => {
  // A record can vanish while the process it described keeps serving — a
  // SIGKILL leaves no cleanup behind. Reporting that as "not running" points
  // the operator at the wrong problem: they go on to `start`, which fails on a
  // port they were just told nothing was using.
  const d = await mkdtemp(join(tmpdir(), "paddock-status-"));
  const said: string[] = [];
  const code = await runStatus({
    dir: d,
    port: 8787,
    log: (l) => said.push(l),
    listener: async () => ({ version: "0.8.1" }),
  });

  // Still non-zero — it was non-zero before, and an instance nothing can stop
  // is not a healthy "running" either.
  expect(code).toBe(1);
  const text = said.join("\n");
  expect(text).not.toContain("not running");
  expect(text).toContain("0.8.1");
  expect(text).toContain("8787");
});
