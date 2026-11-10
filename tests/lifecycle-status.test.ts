import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@server/cli";
import { defaultHealthCheck, runStatus } from "@server/lifecycle/commands";
import { writeState, type Probe } from "@server/lifecycle/state";
import { writeTunnelState } from "@server/tunnel/state";
import { pairFact } from "@server/tunnel/pair";
import { glyph } from "@server/term";
import type { ServiceManager } from "@server/lifecycle/service/types";

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

function svc(status: "absent" | "registered" | "active", over: Partial<ServiceManager> = {}) {
  const calls: string[] = [];
  const manager: ServiceManager = {
    kind: "systemd", unitPath: "/path/to/unit", logHint: "journalctl --user -u paddock",
    startsAt: async () => "boot",
    install: async () => ({ warnings: [] }),
    uninstall: async () => { calls.push("uninstall"); },
    inspect: async () => status,
    restart: async () => {},
    ...over,
  };
  return { service: { ok: true as const, manager }, calls };
}

test("status names an active service and where it starts", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  await writeState(d, { pid: 4242, args: "paddock", port: 8787, version: "0.9.0", startedAt: Date.now(), managedBy: "systemd" });
  const { service } = svc("active");
  const lines: string[] = [];
  const code = await runStatus({ dir: d, service, probe: { isAlive: () => true, argsOf: () => "paddock" }, log: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain("service: systemd · starts at boot");
});

test("status names a registered service that is not serving, and where to look", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  const { service } = svc("registered");
  const lines: string[] = [];
  const code = await runStatus({ dir: d, service, log: (l) => lines.push(l) });
  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("registered");
  expect(lines.join("\n")).toContain("journalctl --user -u paddock");
});

test("no service: status prints no service line", async () => {
  const d = await mkdtemp(join(tmpdir(), "paddock-status-svc-"));
  const { service } = svc("absent");
  const lines: string[] = [];
  await runStatus({ dir: d, service, log: (l) => lines.push(l) });
  expect(lines.join("\n")).not.toContain("service");
});

// ---- tailscale: one block, silent when the feature is off -----------------

const TS_BIN = "/usr/bin/tailscale";
const TS_HOST = "dev-box.example-tailnet.ts.net";
const TS_SERVE_STATUS = `${TS_BIN} serve status --json`;
const servedTo = (proxy: string) =>
  JSON.stringify({ Web: { [`${TS_HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

async function tsStatus(o: {
  config?: boolean;
  found?: string | null;
  serve?: { code?: number; out?: string; err?: string };
  health?: true | string;
  running?: boolean;
}) {
  const d = await dir();
  if (o.running !== false) await writeState(d, s);
  if (o.config !== false) {
    await writeFile(join(d, "tailscale.json"), JSON.stringify({
      enabled: true, login: "operator@github", host: TS_HOST,
    }));
  }
  const ran: string[] = [];
  const probed: number[] = [];
  const out: string[] = [];
  const code = await runStatus({
    dir: d,
    probe: probe(o.running !== false, "paddock"),
    log: (l) => out.push(l),
    tailnetPort: 8789,
    find: () => (o.found === undefined ? TS_BIN : o.found),
    run: async (argv) => {
      ran.push(argv.join(" "));
      const a = o.serve ?? { out: servedTo("http://127.0.0.1:8789") };
      return { code: a.code ?? 0, out: a.out ?? "", err: a.err ?? "" };
    },
    tailnetHealth: async (port) => { probed.push(port); return o.health ?? true; },
  });
  return { code, out: out.join("\n"), ran, probed };
}

test("tailscale: silent when there is no tailscale.json, and asks tailscale nothing", async () => {
  const r = await tsStatus({ config: false });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("tailscale");
  expect(r.ran).toEqual([]);
  expect(r.probed).toEqual([]);
});

test("tailscale: ✓ block when the listener answers with the gate and serve points at it", async () => {
  const r = await tsStatus({});
  expect(r.code).toBe(0);
  expect(r.out).toContain(`${glyph("yes")} tailscale — https://${TS_HOST}`);
  expect(r.out).toContain("    allows operator@github · listener 127.0.0.1:8789");
  expect(r.probed).toEqual([8789]);
  expect(r.ran).toEqual([TS_SERVE_STATUS]);
});

test("tailscale: ✗ when the listener is not up, with why; exit code unchanged", async () => {
  const r = await tsStatus({ health: "nothing answers on 127.0.0.1:8789" });
  expect(r.code).toBe(0);
  expect(r.out).toContain(
    `${glyph("no")} tailscale — enabled but the listener is not up (nothing answers on 127.0.0.1:8789)`,
  );
  expect(r.out).not.toContain(`${glyph("yes")} tailscale`);
});

test("tailscale: ✗ when serve no longer points at the listener; exit code unchanged", async () => {
  for (const serve of [{ out: "" }, { out: servedTo("http://127.0.0.1:3000") }]) {
    const r = await tsStatus({ serve });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `${glyph("no")} tailscale — enabled but tailscale serve no longer points at it; run paddock tailscale`,
    );
  }
});

test("tailscale: the exit code follows paddock, not tailscale, when paddock is down", async () => {
  const r = await tsStatus({ running: false, health: "nothing answers on 127.0.0.1:8789" });
  expect(r.code).toBe(1);
  expect(r.out).toContain("enabled but the listener is not up");
});

test("tailscale: the binary missing is a ⚠ line, not ✓ and not ✗", async () => {
  const r = await tsStatus({ found: null });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`${glyph("unknown")} tailscale`);
  expect(r.out).toContain("not found");
  expect(r.ran).toEqual([]);
});

test("tailscale: a failing `serve status` is ⚠ naming the error — never ✓, never 'serve gone'", async () => {
  const r = await tsStatus({ serve: { code: 1, err: "failed to connect to local tailscaled" } });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`${glyph("unknown")} tailscale`);
  expect(r.out).toContain("failed to connect to local tailscaled");
  expect(r.out).not.toContain("no longer points");
  expect(r.out).not.toContain(`${glyph("yes")} tailscale`);
});

test("tailscale: malformed `serve status` JSON is ⚠ too", async () => {
  const r = await tsStatus({ serve: { out: "{not json" } });
  expect(r.out).toContain(`${glyph("unknown")} tailscale`);
  expect(r.out).not.toContain("no longer points");
});

test("defaultHealthCheck is bounded: a port that accepts and never answers reads as not up", async () => {
  const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new Error("timed out")));
  })) as unknown as typeof fetch;
  const t0 = Date.now();
  expect(await defaultHealthCheck(8787, hang, 50)).toBe(false);
  expect(Date.now() - t0).toBeLessThan(1_000);
});

// ---- --json: the same facts, for the Herdr app mod -------------------------

async function jsonStatus(o: Parameters<typeof runStatus>[0]) {
  const printed: string[] = [];
  const lines: string[] = [];
  const code = await runStatus({ ...o, json: true, out: (t) => printed.push(t), log: (l) => lines.push(l) });
  expect(printed, "exactly one JSON document").toHaveLength(1);
  expect(lines, "no human lines mixed into the JSON").toEqual([]);
  return { code, report: JSON.parse(printed[0]!) };
}

test("--json: nothing running is a stopped paddock, no service, tunnel or tailscale; exit code unchanged", async () => {
  const { code, report } = await jsonStatus({ dir: await dir(), probe: probe(false, null) });
  expect(code).toBe(1);
  expect(report).toEqual({ paddock: { state: "stopped" }, service: null, tunnel: null, tailscale: null });
});

test("--json: a running paddock under an active service", async () => {
  const d = await dir();
  await writeState(d, s);
  const { service } = svc("active");
  const { code, report } = await jsonStatus({ dir: d, probe: probe(true, "paddock"), service });
  expect(code).toBe(0);
  expect(report.paddock).toEqual({ state: "running", pid: 4242, port: 8787, version: "0.4.0", startedAt: s.startedAt });
  expect(report.service).toEqual({ kind: "systemd", state: "active", startsAt: "boot", logHint: "journalctl --user -u paddock" });
});

test("--json: an unreadable state is unknown with the error, not stopped", async () => {
  const parent = await dir();
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const { report } = await jsonStatus({ dir: join(blocker, "child"), probe: probe(false, null) });
  expect(report.paddock.state).toBe("unknown");
  expect(report.paddock.error).toBeString();
});

test("--json: a running tunnel carries its URL and the pairing code the control socket gives", async () => {
  const d = await dir();
  await writeState(d, s);
  await writeTunnelState(d, {
    pid: 5151, args: "paddock tunnel", url: "https://quick-words.trycloudflare.com",
    control: join(d, "tunnel.sock"), publishing: 8787, startedAt: 1000, until: null,
  });
  const asked: string[] = [];
  const pair = { code: "ABCD-EFGH", expiresAt: 9000, link: "https://quick-words.trycloudflare.com/#ABCDEFGH", qr: ["10", "01"] };
  const { report } = await jsonStatus({
    dir: d, probe: probe(true, "paddock tunnel"),
    pairInfo: async (control) => { asked.push(control); return pair; },
  });
  expect(asked).toEqual([join(d, "tunnel.sock")]);
  expect(report.tunnel).toEqual({
    state: "running", url: "https://quick-words.trycloudflare.com", pid: 5151, startedAt: 1000, publishing: 8787, pair,
  });
});

test("--json: tailscale up, and tailscale down with why", async () => {
  const up = await tsStatusJson({});
  expect(up.tailscale).toEqual({ state: "up", url: `https://${TS_HOST}`, login: "operator@github", port: 8789 });
  const down = await tsStatusJson({ health: "nothing answers on 127.0.0.1:8789" });
  expect(down.tailscale.state).toBe("down");
  expect(down.tailscale.detail).toContain("nothing answers");
});

async function tsStatusJson(o: { health?: true | string }) {
  const d = await dir();
  await writeState(d, s);
  await writeFile(join(d, "tailscale.json"), JSON.stringify({ enabled: true, login: "operator@github", host: TS_HOST }));
  const { report } = await jsonStatus({
    dir: d, probe: probe(true, "paddock"), tailnetPort: 8789, find: () => TS_BIN,
    run: async () => ({ code: 0, out: servedTo("http://127.0.0.1:8789"), err: "" }),
    tailnetHealth: async () => o.health ?? true,
  });
  return report;
}

test("pairFact: the link carries the code in the fragment, and the QR encodes that link", async () => {
  const fact = await pairFact("/path/to/tunnel.sock", async () => ({
    ok: true, answer: { url: "https://quick-words.trycloudflare.com", code: "ABCDEFGH", expiresAt: 9000 },
  }) as never);
  expect(fact!.link).toBe("https://quick-words.trycloudflare.com/#ABCDEFGH");
  expect(fact!.code).toBe("ABCD-EFGH");
  expect(fact!.qr.length).toBeGreaterThan(20);
  expect(fact!.qr.every((r) => /^[01]+$/.test(r) && r.length === fact!.qr.length)).toBe(true);
});

test("pairFact: a tunnel that does not answer gives null, not a guess", async () => {
  expect(await pairFact("/path/to/tunnel.sock", async () => ({ ok: false, detail: "ECONNREFUSED" }) as never)).toBeNull();
});
