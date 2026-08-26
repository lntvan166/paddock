import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childCommand } from "@server/lifecycle/commands";
import type { Probe } from "@server/lifecycle/state";
import { runDetach } from "@server/tunnel/detach";
import { tunnelStateFile, type TunnelState } from "@server/tunnel/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-detach-"));

const STATE: TunnelState = {
  pid: 4242, args: "paddock tunnel",
  url: "https://example-tunnel.trycloudflare.com",
  control: "/base/operator/.config/paddock/tunnel.sock",
  publishing: null, startedAt: 0, until: null,
};
const alive: Probe = { isAlive: () => true, argsOf: () => STATE.args };
const answers = async () => ({
  ok: true as const,
  answer: { code: "H2FK68CG", expiresAt: 600_000, url: STATE.url },
});
const refuses = async () => ({ ok: false as const, detail: "ENOENT" });

const put = async (d: string, s: Partial<TunnelState> = {}) =>
  await writeFile(tunnelStateFile(d), JSON.stringify({ ...STATE, ...s }));

function run(o: Parameters<typeof runDetach>[0]) {
  const said: string[] = [];
  return runDetach({ ...o, log: (l) => said.push(l) })
    .then((code) => ({ code, text: said.join("\n") }));
}

/** A spawn that never dies, and never publishes unless a test makes it. */
const spawnAlive = () => ({ pid: 999_999, exited: new Promise<number>(() => {}) });

test("a child that publishes and answers is reported with its code and URL", async () => {
  const d = await dir();
  const r = await run({
    dir: d, probe: alive, waitMs: 2_000, ask: answers,
    colour: false, columns: 80, rows: 40,
    // The child's job, faked: write the record the way runTunnel does.
    spawn: () => { void put(d); return spawnAlive(); },
  });
  expect(r.code).toBe(0);
  expect(r.text).toContain("background");
  expect(r.text).toContain(STATE.url);
  expect(r.text).toContain("H2FK-68CG");
  expect(r.text).toContain("paddock stop");
});

test("a record without a working socket is NOT success", async () => {
  // Either half alone is a tunnel the operator cannot use: a record with no
  // socket is a code nobody can read. Reporting success here would hand back
  // the shell and a URL that cannot be paired.
  const d = await dir();
  const r = await run({
    dir: d, probe: alive, waitMs: 400, ask: refuses,
    spawn: () => { void put(d); return spawnAlive(); },
    logTail: async () => "",
  });
  expect(r.code).toBe(1);
  expect(r.text).toMatch(/did not publish/i);
});

test("a child that dies is reported with its own output, not as a timeout", async () => {
  const d = await dir();
  const r = await run({
    dir: d, probe: alive, waitMs: 10_000, ask: answers,
    spawn: () => ({ pid: 999_999, exited: Promise.resolve(1) }),
    logTail: async () => "cloudflared: failed to dial edge",
  });
  expect(r.code).toBe(1);
  expect(r.text).toContain("exited before it published");
  expect(r.text).toContain("failed to dial edge");
  // Not a timeout: the wait was 10s and this returned at once.
  expect(r.text).not.toMatch(/did not publish a URL within/);
});

test("a tunnel already running is refused, and pointed at pair", async () => {
  const d = await dir();
  await put(d);
  let spawned = 0;
  const r = await run({
    dir: d, probe: alive, ask: answers, spawn: () => { spawned += 1; return spawnAlive(); },
  });
  expect(r.code).toBe(1);
  expect(spawned).toBe(0); // refused BEFORE spawning, not after
  expect(r.text).toContain("already running");
  expect(r.text).toContain("paddock pair");
});

test("a stale record is cleared and the detach proceeds", async () => {
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d, waitMs: 2_000, ask: answers, colour: false, columns: 80, rows: 40,
    // Dead on the first look, alive once the child has written its own record.
    probe: { isAlive: () => false, argsOf: () => null },
    spawn: () => spawnAlive(),
    logTail: async () => "",
  });
  expect(r.text).toContain("stale");
});

test("an unreadable record refuses rather than guessing", async () => {
  const d = await dir();
  // A directory where the state file should be: readFile fails with EISDIR,
  // which is `unreadable` and must never collapse into "nothing is running".
  await Bun.$`mkdir -p ${tunnelStateFile(d)}`.quiet();
  let spawned = 0;
  const r = await run({
    dir: d, probe: alive, ask: answers, spawn: () => { spawned += 1; return spawnAlive(); },
  });
  expect(r.code).toBe(1);
  expect(spawned).toBe(0);
  expect(r.text).toMatch(/refusing to guess/);
});

test("the child command carries every flag that changes what the tunnel is", async () => {
  // A dropped flag here is not cosmetic. Without --for the child outlives its
  // deadline; without --publish-running it becomes a SECOND paddock with a
  // second notifier, which is the failure preflight exists to prevent.
  const plain = childCommand({ tunnel: {} });
  expect(plain.at(-1)).toBe("tunnel");

  const both = childCommand({ tunnel: { for: "2h", publishRunning: true } });
  expect(both).toContain("tunnel");
  expect(both).toContain("--publish-running");
  expect(both.join(" ")).toContain("--for 2h");

  // And never --detach: the child would try to detach again, forever.
  expect(both).not.toContain("--detach");
  // `--demo` is not a tunnel flag and must not leak in through this path.
  expect(childCommand({ tunnel: {}, demo: true })).not.toContain("--demo");
});
