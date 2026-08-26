import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "@server/lifecycle/commands";
import { stopTunnel } from "@server/tunnel/stop";
import { tunnelStateFile, type TunnelState } from "@server/tunnel/state";

const dir = () => mkdtemp(join(tmpdir(), "paddock-tunnel-stop-"));

const STATE: TunnelState = {
  pid: 4242, args: "paddock tunnel --detach",
  url: "https://example-tunnel.trycloudflare.com",
  control: "/base/operator/.config/paddock/tunnel.sock",
  publishing: null, startedAt: 0, until: null,
};

const put = async (d: string, s: Partial<TunnelState> = {}) =>
  await writeFile(tunnelStateFile(d), JSON.stringify({ ...STATE, ...s }));

function run(o: Parameters<typeof stopTunnel>[0]) {
  const said: string[] = [];
  const sent: string[] = [];
  return stopTunnel({
    ...o,
    log: (l) => said.push(l),
    signal: o.signal ?? ((pid, sig) => { sent.push(`${sig} ${pid}`); }),
  }).then((r) => ({ code: r.code, serving: r.stoppedServing, text: said.join("\n"), sent }));
}

test("no tunnel is a SILENT success", async () => {
  // `paddock stop` calls this on every run and most have no tunnel. A line on
  // all of them would be noise in the command's ordinary output.
  const r = await run({ dir: await dir() });
  expect(r.code).toBe(0);
  expect(r.text).toBe("");
  expect(r.sent).toEqual([]);
});

test("a live tunnel is SIGTERMed and reported stopped", async () => {
  const d = await dir();
  await put(d);
  let alive = true;
  const r = await run({
    dir: d, waitMs: 2_000,
    probe: { isAlive: () => alive, argsOf: () => STATE.args },
    signal: (_pid, _sig) => { alive = false; },
  });
  expect(r.code).toBe(0);
  expect(r.text).toContain("tunnel stopped (pid 4242)");
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(false);
  // This tunnel served the dashboard itself, so `paddock stop` must NOT go on
  // to say "paddock — not running" about the process it just stopped.
  expect(r.serving).toBe(true);
});

test("stopping a tunnel that PUBLISHED another paddock is not 'was serving'", async () => {
  // The paddock is still up — that is what --publish-running means — so the
  // paddock half of `paddock stop` has real work to do and its report stands.
  const d = await dir();
  await put(d, { publishing: 8787 });
  let alive = true;
  const r = await run({
    dir: d, waitMs: 2_000,
    probe: { isAlive: () => alive, argsOf: () => STATE.args },
    signal: () => { alive = false; },
  });
  expect(r.code).toBe(0);
  expect(r.serving).toBe(false);
});

test("SIGKILL IS NEVER SENT, even to a tunnel that will not exit", async () => {
  // The whole reason this is not a share of runStop. SIGKILL cannot be
  // handled, so it would skip the teardown that reaps cloudflared — leaving a
  // public URL resolving with nothing behind it, which is the worst failure
  // this feature has. A stubborn tunnel is reported, never escalated.
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d, waitMs: 250,
    probe: { isAlive: () => true, argsOf: () => STATE.args },
  });
  expect(r.code).toBe(1);
  expect(r.sent).toEqual(["SIGTERM 4242"]);
  expect(r.sent.join(" ")).not.toContain("SIGKILL");
  expect(r.text).toContain("did not exit after SIGTERM");
  expect(r.text).toContain("cloudflared");
  // Left running AND left recorded: the operator has to be able to find it.
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(true);
});

test("a pid that is something else now is refused, not signalled", async () => {
  // The worst thing either stop path can do. `runStop`'s discipline, not
  // relaxed because this process is 'only' a tunnel.
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d, probe: { isAlive: () => true, argsOf: () => "vim src/server/index.ts" },
  });
  expect(r.code).toBe(1);
  expect(r.sent).toEqual([]);
  expect(r.text).toContain("refusing to signal it");
  expect(r.text).toContain("vim");
});

test("a stale record is cleared and reported, nothing signalled", async () => {
  const d = await dir();
  await put(d);
  const r = await run({ dir: d, probe: { isAlive: () => false, argsOf: () => null } });
  expect(r.code).toBe(0);
  expect(r.sent).toEqual([]);
  expect(r.text).toContain("stale");
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(false);
});

test("an unreadable record refuses and signals nothing", async () => {
  const d = await dir();
  await Bun.$`mkdir -p ${tunnelStateFile(d)}`.quiet();
  const r = await run({ dir: d, probe: { isAlive: () => true, argsOf: () => STATE.args } });
  expect(r.code).toBe(1);
  expect(r.sent).toEqual([]);
  expect(r.text).toMatch(/refusing to guess/);
});

test("a pid that vanished between the check and the signal is a success", async () => {
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => STATE.args },
    signal: () => {
      const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    },
  });
  expect(r.code).toBe(0);
  expect(r.text).toContain("already gone");
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(false);
});

test("permission denied is reported and the record is KEPT", async () => {
  // Another user's tunnel. The record is the only thing naming it, so it must
  // survive a failure to signal.
  const d = await dir();
  await put(d);
  const r = await run({
    dir: d,
    probe: { isAlive: () => true, argsOf: () => STATE.args },
    signal: () => {
      const e = new Error("kill EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    },
  });
  expect(r.code).toBe(1);
  expect(r.text).toContain("permission denied");
  expect(await Bun.file(tunnelStateFile(d)).exists()).toBe(true);
});

test("runStop does not say 'not running' about the tunnel it just stopped", async () => {
  // The report an operator actually sees after `paddock tunnel --detach` then
  // `paddock stop`. A plain tunnel records BOTH files and clears the paddock
  // one as it exits, so the paddock half of `stop` finds nothing — and used to
  // print "paddock — not running" directly under "✓ tunnel stopped", one
  // command contradicting itself about a single process.
  const d = await dir();
  await put(d); // publishing: null — this tunnel IS the dashboard
  let alive = true;
  const said: string[] = [];
  const code = await runStop({
    dir: d,
    waitMs: 2_000,
    probe: { isAlive: () => alive, argsOf: () => STATE.args },
    signal: () => { alive = false; },
    log: (l) => said.push(l),
  });
  const text = said.join("\n");
  expect(code).toBe(0);
  expect(text).toContain("tunnel stopped");
  expect(text).not.toContain("paddock — not running");
});

test("runStop DOES say 'not running' when no tunnel was serving", async () => {
  // The suppression must be narrow: with no tunnel at all, the paddock line is
  // the only answer there is and removing it would leave `stop` silent.
  const said: string[] = [];
  const code = await runStop({ dir: await dir(), log: (l) => said.push(l) });
  expect(code).toBe(0);
  expect(said.join("\n")).toContain("paddock — not running");
});
