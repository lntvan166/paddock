import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@server/cli";
import { runStatus } from "@server/lifecycle/commands";
import { writeState, type Probe } from "@server/lifecycle/state";
import { glyph } from "@server/term";

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
  // The loudest thing `status` can say — something is serving that paddock
  // cannot decide about or manage — must carry the same kind of marker every
  // other outcome does, not run unmarked.
  expect(said[0]).toStartWith(glyph("unknown"));
});

test("an uptime under a minute reads in seconds, not as 0m", async () => {
  // uptime() capped at minutes and printed "0m" for a server 30 seconds old,
  // which reads as "no uptime recorded" rather than "just started".
  const d = await dir();
  const now = Date.now();
  await writeState(d, { ...s, startedAt: now - 30_000 });
  const out: string[] = [];
  await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l), now: () => now });
  expect(out.join(" ")).toContain("30s");
});

test("an uptime over a day rolls into days", async () => {
  const d = await dir();
  const now = Date.now();
  await writeState(d, { ...s, startedAt: now - 361_800_000 });
  const out: string[] = [];
  await runStatus({ dir: d, probe: probe(true, "paddock"), log: (l) => out.push(l), now: () => now });
  expect(out.join(" ")).toContain("4d 4h");
});

// Five outcomes that used to be five identical greys. The glyph is the part
// that survives a pipe, so it is what is asserted.
test("each status outcome carries its own glyph", async () => {
  const running = await dir();
  await writeState(running, s);
  const out: string[] = [];
  await runStatus({ dir: running, probe: probe(true, "paddock"), log: (l) => out.push(l) });
  expect(out[0]).toStartWith("✓");

  const nothing: string[] = [];
  await runStatus({ dir: await dir(), probe: probe(false, null), log: (l) => nothing.push(l) });
  expect(nothing[0]).toStartWith("✗");
});

// The distinction runStatus's own comment insists on: "could not read the
// state" is not "nothing is running", and must not be typeset as if it were.
//
// Malformed JSON is NOT this case: checkState deliberately maps it to "none"
// (see state.ts's own comment on that branch), so it is triggered here the
// same way the pre-existing "distinct from absence" test above does — an
// ENOTDIR on the state file's parent, a real I/O failure.
test("an unreadable state is ⚠, not ✗ — it is undetermined, not absent", async () => {
  const parent = await dir();
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const d = join(blocker, "child");
  const out: string[] = [];
  const code = await runStatus({ dir: d, probe: probe(false, null), log: (l) => out.push(l) });
  expect(code).toBe(1);
  expect(out[0]).toStartWith("⚠");
});
