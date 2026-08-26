import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Probe } from "@server/lifecycle/state";
import { runPair } from "@server/tunnel/pair";
import { tunnelStateFile, type TunnelState } from "@server/tunnel/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-pair-cmd-"));

const STATE: TunnelState = {
  pid: 4242,
  args: "paddock tunnel --detach",
  url: "https://example-tunnel.trycloudflare.com",
  control: "/base/operator/.config/paddock/tunnel.sock",
  publishing: null,
  startedAt: 0,
  until: null,
};

const alive: Probe = { isAlive: () => true, argsOf: () => STATE.args };
const dead: Probe = { isAlive: () => false, argsOf: () => null };

const put = async (d: string, s: Partial<TunnelState> = {}) =>
  await writeFile(tunnelStateFile(d), JSON.stringify({ ...STATE, ...s }));

const answers = async () => ({
  ok: true as const,
  answer: { code: "H2FK68CG", expiresAt: 600_000, url: STATE.url },
});

function run(o: Parameters<typeof runPair>[0]) {
  const said: string[] = [];
  return runPair({ ...o, log: (l) => said.push(l) }).then((code) => ({
    code, text: said.join("\n"),
  }));
}

test("prints the URL, the code grouped, and the time left", async () => {
  const d = await dir();
  await put(d);
  const r = await run({ dir: d, probe: alive, ask: answers, now: () => 5_000, colour: false, columns: 80, rows: 40 });
  expect(r.code).toBe(0);
  expect(r.text).toContain(STATE.url);
  // Grouped as the pairing page formats it — an operator types what they read.
  expect(r.text).toContain("H2FK-68CG");
  expect(r.text).toMatch(/9m 55s|expires/);
});

test("draws the QR when the terminal has room, and not when it does not", async () => {
  const d = await dir();
  await put(d);
  const wide = await run({ dir: d, probe: alive, ask: answers, colour: true, columns: 80, rows: 40 });
  const short = await run({ dir: d, probe: alive, ask: answers, colour: true, columns: 80, rows: 8 });
  // Half-block rows: the QR is present in one and absent in the other.
  const blocks = (s: string) => (s.match(/[▀▄█]/g) ?? []).length;
  expect(blocks(wide.text)).toBeGreaterThan(50);
  expect(blocks(short.text)).toBe(0);
  // The code is still readable without the QR — a short terminal must not
  // leave the operator with nothing to type.
  expect(short.text).toContain("H2FK-68CG");
});

test("no tunnel at all says so, and exits non-zero", async () => {
  const r = await run({ dir: await dir(), probe: alive, ask: answers });
  expect(r.code).toBe(1);
  expect(r.text).toMatch(/no tunnel/i);
});

test("a recorded tunnel whose socket refuses is NOT reported as no tunnel", async () => {
  // The distinction the whole `Ask` type exists for. Told "no tunnel is
  // running", an operator starts a second one beside the first.
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d, probe: alive,
    ask: async () => ({ ok: false as const, detail: "ENOENT: no such file or directory" }),
  });
  expect(r.code).toBe(1);
  expect(r.text).not.toMatch(/no tunnel is running/i);
  expect(r.text).toContain("4242");
  expect(r.text).toContain("ENOENT");
});

test("a dead pid is reported as stale and the record is cleared", async () => {
  const d = await dir();
  await put(d);
  const r = await run({ dir: d, probe: dead, ask: answers });
  expect(r.code).toBe(1);
  expect(r.text).toMatch(/stale|not running/i);
  // Cleared, so the next `pair` says "no tunnel" rather than repeating this.
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(false);
});

test("a pid that is something else now is reported, not silently trusted", async () => {
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d, ask: answers,
    probe: { isAlive: () => true, argsOf: () => "vim src/server/index.ts" },
  });
  expect(r.code).toBe(1);
  expect(r.text).toContain("vim");
});

test("the QR carries the code in the fragment, never the query", async () => {
  // docs/decisions.md 22: the fragment is the entire reason a code may travel
  // in a URL at all — it reaches no access log. A `?code=` here would put the
  // pairing code into Cloudflare's edge logs.
  const d = await dir();
  await put(d);
  const r = await run({ dir: d, probe: alive, ask: answers, colour: false, columns: 80, rows: 40 });
  expect(r.text).toContain(`${STATE.url}/#H2FK68CG`);
  expect(r.text).not.toContain("?code=");
});

test("a tunnel publishing another paddock says which port it publishes", async () => {
  const d = await dir();
  await put(d, { publishing: 8787 });
  const r = await run({ dir: d, probe: alive, ask: answers, colour: false, columns: 80, rows: 40 });
  expect(r.text).toContain("8787");
});
