import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHealth, runTailscale, runTailscaleOff, type TailscaleOpts } from "@server/tailscale/command";
import { tailscaleConfigFile, writeTailscaleConfig } from "@server/tailscale/config";
import type { ServiceManager, ServiceStatus } from "@server/lifecycle/service/types";
import type { Run } from "@server/lifecycle/service/types";

const BIN = "/usr/bin/tailscale";
const HOST = "dev-box.example-tailnet.ts.net";
const STATUS = readFileSync("tests/fixtures/tailscale-status.json", "utf8");
const OURS = readFileSync("tests/fixtures/tailscale-serve-status.json", "utf8");
const serveJson = (proxy: string) =>
  JSON.stringify({ Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

const STATUS_ARGV = `${BIN} status --json`;
const SERVE_STATUS_ARGV = `${BIN} serve status --json`;
const SERVE_ON_ARGV = `${BIN} serve --bg --https=443 http://127.0.0.1:8789`;
const SERVE_OFF_ARGV = `${BIN} serve --https=443 off`;

type Answer = { code?: number; out?: string; err?: string };

/** One ordered log of everything the command did, across every fake. */
function world(o: {
  answers?: Record<string, Answer>;
  status?: ServiceStatus;
  serviceOk?: boolean;
  found?: string | null;
  container?: boolean;
  health?: string;
  localUp?: boolean;
  restartFails?: boolean;
} = {}) {
  const events: string[] = [];
  const lines: string[] = [];
  const answers: Record<string, Answer> = {
    [STATUS_ARGV]: { out: STATUS },
    [SERVE_STATUS_ARGV]: { out: "" },
    ...o.answers,
  };
  const run: Run = async (argv) => {
    const k = argv.join(" ");
    events.push(`run ${k}`);
    const a = answers[k] ?? {};
    return { code: a.code ?? 0, out: a.out ?? "", err: a.err ?? "" };
  };
  const manager: ServiceManager = {
    kind: "systemd", unitPath: "/path/to/unit", logHint: "journalctl --user -u paddock",
    startsAt: async () => "boot",
    install: async () => ({ warnings: [] }),
    uninstall: async () => {},
    inspect: async () => o.status ?? "active",
    restart: async () => {
      events.push("restart");
      if (o.restartFails) throw new Error("`systemctl --user restart paddock.service` failed: boom");
    },
  };
  const opts = (dir: string, over: Partial<TailscaleOpts> = {}): TailscaleOpts => ({
    dir,
    port: 8787,
    tailnetPort: 8789,
    service: o.serviceOk === false
      ? { ok: false, reason: "service management is off here (PADDOCK_NO_SERVICE=1)" }
      : { ok: true, manager },
    run,
    find: () => (o.found === undefined ? BIN : o.found),
    inContainer: () => o.container ?? false,
    fetchHealth: async (url) => {
      events.push(`health ${url}`);
      return o.health ?? "paddock";
    },
    localHealth: async (port) => {
      events.push(`local ${port}`);
      return o.localUp ?? true;
    },
    waitMs: 50,
    log: (l) => lines.push(l),
    colour: false,
    columns: 0,
    rows: 0,
    ...over,
  });
  return { events, lines, opts, out: () => lines.join("\n") };
}

const tmp = () => mkdtemp(join(tmpdir(), "paddock-ts-cmd-"));
const configOf = async (dir: string) => JSON.parse(await readFile(tailscaleConfigFile(dir), "utf8"));

/** No later step ran: nothing written, nothing served, nothing restarted. */
function nothingChanged(dir: string, events: string[]) {
  expect(existsSync(tailscaleConfigFile(dir))).toBe(false);
  expect(events).not.toContain(`run ${SERVE_ON_ARGV}`);
  expect(events).not.toContain("restart");
}

describe("runTailscale refusals", () => {
  test("1. in a container", async () => {
    const d = await tmp();
    const w = world({ container: true });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("container");
    expect(w.events).toEqual([]);
    nothingChanged(d, w.events);
  });

  test("2. no tailscale binary prints the install hint", async () => {
    const d = await tmp();
    const w = world({ found: null });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("tailscale.com/download");
    expect(w.events).toEqual([]);
    nothingChanged(d, w.events);
  });

  test("3a. status fails", async () => {
    const d = await tmp();
    const w = world({ answers: { [STATUS_ARGV]: { code: 1, err: "failed to connect to local tailscaled" } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("failed to connect to local tailscaled");
    nothingChanged(d, w.events);
  });

  test("3b. node not running points at `tailscale up`", async () => {
    const d = await tmp();
    const stopped = JSON.stringify({ ...JSON.parse(STATUS), BackendState: "NeedsLogin" });
    const w = world({ answers: { [STATUS_ARGV]: { out: stopped } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("tailscale up");
    nothingChanged(d, w.events);
  });

  test("3c. no HTTPS certificates points at the admin console", async () => {
    const d = await tmp();
    const noCerts = JSON.stringify({ ...JSON.parse(STATUS), CertDomains: null });
    const w = world({ answers: { [STATUS_ARGV]: { out: noCerts } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("DNS → HTTPS Certificates");
    nothingChanged(d, w.events);
  });

  test("3d. a node with no Tailscale user (tagged) needs --login", async () => {
    const d = await tmp();
    const tagged = JSON.stringify({ ...JSON.parse(STATUS), User: {} });
    const w = world({ answers: { [STATUS_ARGV]: { out: tagged } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("no Tailscale user");
    expect(w.out()).toContain("--login");
    nothingChanged(d, w.events);
  });

  test("3d'. a blank --login is no login either", async () => {
    const d = await tmp();
    const tagged = JSON.stringify({ ...JSON.parse(STATUS), User: {} });
    const w = world({ answers: { [STATUS_ARGV]: { out: tagged } } });
    expect(await runTailscale(w.opts(d, { loginOverride: "  " }))).toBe(1);
    expect(w.out()).toContain("--login");
    nothingChanged(d, w.events);
  });

  test("4a. no service manager here says to run paddock local", async () => {
    const d = await tmp();
    const w = world({ serviceOk: false });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("paddock local");
    nothingChanged(d, w.events);
  });

  test("4b. the service is not active says to run paddock local", async () => {
    const d = await tmp();
    const w = world({ status: "registered" });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("paddock local");
    nothingChanged(d, w.events);
  });

  test("4c. service undefined is the same refusal", async () => {
    const d = await tmp();
    const w = world();
    expect(await runTailscale(w.opts(d, { service: undefined }))).toBe(1);
    expect(w.out()).toContain("paddock local");
    nothingChanged(d, w.events);
  });

  test("5. refuses when 443 serves something else", async () => {
    const d = await tmp();
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { out: serveJson("http://127.0.0.1:3000") } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("http://127.0.0.1:3000");
    expect(w.out()).toContain("tailscale serve status");
    nothingChanged(d, w.events);
  });

  test("5'. a serve status that cannot be read is a refusal, not 'free'", async () => {
    const d = await tmp();
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { code: 1, err: "permission denied" } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("permission denied");
    nothingChanged(d, w.events);
  });

  test("5''. malformed serve JSON is a refusal too", async () => {
    const d = await tmp();
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { out: "{not json" } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    nothingChanged(d, w.events);
  });
});

describe("runTailscale", () => {
  test("happy path order", async () => {
    const d = await tmp();
    const w = world({
      answers: {
        [STATUS_ARGV]: {
          out: STATUS.replace("operator@github", "Operator@GitHub"),
        },
      },
    });
    expect(await runTailscale(w.opts(d))).toBe(0);
    expect(await configOf(d)).toEqual({ enabled: true, login: "operator@github", host: HOST });
    const i = (e: string) => w.events.indexOf(e);
    expect(i("restart")).toBeGreaterThan(i(`run ${SERVE_STATUS_ARGV}`));
    expect(i("local 8787")).toBeGreaterThan(i("restart"));
    expect(i(`run ${SERVE_ON_ARGV}`)).toBeGreaterThan(i("local 8787"));
    expect(i(`health https://${HOST}/api/health`)).toBeGreaterThan(i(`run ${SERVE_ON_ARGV}`));
    expect(w.out()).toContain(`✓ tailscale — https://${HOST}`);
    expect(w.out()).toContain(
      "open it on your phone, Share → Add to Home Screen, then enable push in Settings",
    );
    expect(w.events.some((e) => e.includes("funnel"))).toBe(false);
  });

  test("the gate's 403 also proves the name reaches the listener", async () => {
    const d = await tmp();
    const w = world({ health: "gate" });
    expect(await runTailscale(w.opts(d))).toBe(0);
  });

  test("--login overrides the owner", async () => {
    const d = await tmp();
    const w = world();
    expect(await runTailscale(w.opts(d, { loginOverride: "Someone@GitHub" }))).toBe(0);
    expect((await configOf(d)).login).toBe("someone@github");
    expect(w.out()).toContain("someone@github");
  });

  test("--login rescues a tagged node", async () => {
    const d = await tmp();
    const tagged = JSON.stringify({ ...JSON.parse(STATUS), User: {} });
    const w = world({ answers: { [STATUS_ARGV]: { out: tagged } } });
    expect(await runTailscale(w.opts(d, { loginOverride: "operator@github" }))).toBe(0);
    expect((await configOf(d)).login).toBe("operator@github");
  });

  test("verify failure → exit 1 and names what came back, config left in place", async () => {
    const d = await tmp();
    const w = world({ health: "HTTP 502 Bad Gateway" });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("HTTP 502 Bad Gateway");
    expect(w.out()).toContain("paddock tailscale off");
    expect(existsSync(tailscaleConfigFile(d))).toBe(true);
  });

  test("a service that never answers after restart → exit 1, no serve", async () => {
    const d = await tmp();
    const w = world({ localUp: false });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("journalctl --user -u paddock");
    expect(w.events).not.toContain(`run ${SERVE_ON_ARGV}`);
  });

  test("a failed restart is reported, exit 1, no serve", async () => {
    const d = await tmp();
    const w = world({ restartFails: true });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("boom");
    expect(w.events).not.toContain(`run ${SERVE_ON_ARGV}`);
  });

  test("a failed serve is reported, exit 1, no verify", async () => {
    const d = await tmp();
    const w = world({ answers: { [SERVE_ON_ARGV]: { code: 1, err: "serve config denied" } } });
    expect(await runTailscale(w.opts(d))).toBe(1);
    expect(w.out()).toContain("serve config denied");
    expect(w.events.some((e) => e.startsWith("health "))).toBe(false);
  });

  test("second run is idempotent", async () => {
    const d = await tmp();
    const first = world();
    expect(await runTailscale(first.opts(d))).toBe(0);
    const again = world({ answers: { [SERVE_STATUS_ARGV]: { out: OURS } } });
    expect(await runTailscale(again.opts(d))).toBe(0);
    expect(again.out()).toBe(first.out());
  });

  test("the QR is printed when the terminal can hold it", async () => {
    const d = await tmp();
    const w = world();
    expect(await runTailscale(w.opts(d, { colour: true, columns: 200, rows: 100 }))).toBe(0);
    expect(w.lines.length).toBeGreaterThan(20);
  });
});

describe("runTailscaleOff", () => {
  test("removes our serve, the config, and restarts the service", async () => {
    const d = await tmp();
    await writeTailscaleConfig(d, { enabled: true, login: "operator@github", host: HOST });
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { out: OURS } } });
    expect(await runTailscaleOff(w.opts(d))).toBe(0);
    expect(w.events).toContain(`run ${SERVE_OFF_ARGV}`);
    expect(existsSync(tailscaleConfigFile(d))).toBe(false);
    expect(w.events.indexOf("restart")).toBeGreaterThan(w.events.indexOf(`run ${SERVE_OFF_ARGV}`));
    expect(w.out()).toContain("✓ tailscale — off");
  });

  test("off removes only our serve", async () => {
    const d = await tmp();
    await writeTailscaleConfig(d, { enabled: true, login: "operator@github", host: HOST });
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { out: serveJson("http://127.0.0.1:3000") } } });
    expect(await runTailscaleOff(w.opts(d))).toBe(0);
    expect(w.events).not.toContain(`run ${SERVE_OFF_ARGV}`);
    expect(existsSync(tailscaleConfigFile(d))).toBe(false);
    expect(w.out()).toContain("http://127.0.0.1:3000");
  });

  test("a serve status that cannot be read is reported; config still removed, still restarted, exit 1", async () => {
    const d = await tmp();
    await writeTailscaleConfig(d, { enabled: true, login: "operator@github", host: HOST });
    const w = world({ answers: { [SERVE_STATUS_ARGV]: { code: 1, err: "permission denied" } } });
    expect(await runTailscaleOff(w.opts(d))).toBe(1);
    expect(w.out()).toContain("permission denied");
    expect(w.events).not.toContain(`run ${SERVE_OFF_ARGV}`);
    expect(existsSync(tailscaleConfigFile(d))).toBe(false);
    expect(w.events).toContain("restart");
  });

  test("no restart when the service is not active", async () => {
    const d = await tmp();
    const w = world({ status: "registered" });
    expect(await runTailscaleOff(w.opts(d))).toBe(0);
    expect(w.events).not.toContain("restart");
  });

  test("no tailscale binary: config still removed, exit 1", async () => {
    const d = await tmp();
    await writeTailscaleConfig(d, { enabled: true, login: "operator@github", host: HOST });
    const w = world({ found: null });
    expect(await runTailscaleOff(w.opts(d))).toBe(1);
    expect(existsSync(tailscaleConfigFile(d))).toBe(false);
    expect(w.events).toContain("restart");
  });
});

describe("fetchHealth (default)", () => {
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("paddock's health JSON is paddock", async () => {
    expect(await fetchHealth("https://x/api/health", reply(200, { ok: true, hostId: "h" }))).toBe("paddock");
  });
  test("the gate's 403 is gate", async () => {
    const body = { ok: false, detail: "tailnet: no Tailscale identity on this request" };
    expect(await fetchHealth("https://x/api/health", reply(403, body))).toBe("gate");
  });
  test("some other 403 is described, not gate", async () => {
    expect(await fetchHealth("https://x/api/health", reply(403, { detail: "nope" }))).toContain("403");
  });
  test("a 502 is described", async () => {
    expect(await fetchHealth("https://x/api/health", reply(502, "bad"))).toContain("502");
  });
  test("a 200 that is not paddock is described", async () => {
    expect(await fetchHealth("https://x/api/health", reply(200, { hello: 1 }))).not.toBe("paddock");
  });
  test("no answer is described", async () => {
    const f = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    expect(await fetchHealth("https://x/api/health", f)).toContain("ENOTFOUND");
  });
  test("a hang times out instead of hanging the CLI", async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const got = await fetchHealth("https://x/api/health", f, 30);
    expect(got).toContain("no answer");
  });
});
