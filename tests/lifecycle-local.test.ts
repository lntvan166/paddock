import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocal, type LocalOpts } from "@server/lifecycle/local";
import { writeState } from "@server/lifecycle/state";
import { ServiceError, type ServiceManager, type ServiceSpec } from "@server/lifecycle/service/types";

const alive = { isAlive: () => true, argsOf: () => "paddock" };
const rec = { pid: 4242, args: "paddock", port: 8787, version: "0.9.0", startedAt: 1 };

function fakeManager(over: Partial<ServiceManager> = {}) {
  const installed: ServiceSpec[] = [];
  const m: ServiceManager = {
    kind: "systemd",
    unitPath: "/path/to/userhome/.config/systemd/user/paddock.service",
    logHint: "journalctl --user -u paddock",
    startsAt: async () => "boot",
    install: async (s) => { installed.push(s); return { warnings: [] }; },
    uninstall: async () => {},
    inspect: async () => "active",
    restart: async () => {},
    ...over,
  };
  return { m, installed };
}

async function go(over: Partial<LocalOpts> & { manager?: ServiceManager }) {
  const lines: string[] = [];
  const dir = over.dir ?? await mkdtemp(join(tmpdir(), "paddock-local-"));
  const code = await runLocal({
    dir, port: 8787,
    service: { ok: true, manager: over.manager ?? fakeManager().m },
    argv: ["/path/to/paddock"],
    env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "systemd" },
    probe: alive,
    listener: async () => null,
    healthCheck: async () => true,
    publicUrl: async () => null,
    log: (l) => lines.push(l),
    waitMs: 300,
    ...over,
  });
  return { code, out: lines.join("\n") };
}

test("a fresh install registers, waits for health, and reports where it starts", async () => {
  const { m, installed } = fakeManager();
  const r = await go({ manager: m });
  expect(r.code).toBe(0);
  expect(installed).toEqual([{ argv: ["/path/to/paddock"], env: { HOME: "/path/to/userhome", PADDOCK_SERVICE: "systemd" } }]);
  expect(r.out).toContain("systemd service");
  expect(r.out).toContain("starts at boot");
  expect(r.out).toContain("paddock.service");
  // Names, never values: the captured env can hold paths worth not echoing.
  expect(r.out).toContain("HOME PADDOCK_SERVICE");
  expect(r.out).not.toContain("/path/to/userhome\n");
  expect(r.out).toContain("paddock start"); // the phone-access hint
});

test("an unsupported platform is refused with its reason", async () => {
  const r = await go({ service: { ok: false, reason: "needs systemd or launchd; this is win32" } });
  expect(r.code).toBe(1);
  expect(r.out).toContain("win32");
});

test("a foreground paddock already running is refused — no second one on the port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await writeState(dir, rec);
  const { m, installed } = fakeManager();
  const r = await go({ dir, manager: m });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
  expect(r.out).toContain("pid 4242");
  expect(r.out).toContain("paddock stop && paddock local");
});

test("an untracked paddock on the port is refused too", async () => {
  const { m, installed } = fakeManager();
  const r = await go({ manager: m, listener: async () => ({ version: "0.8.0" }) });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
});

test("re-running over the service's OWN instance refreshes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await writeState(dir, { ...rec, managedBy: "systemd" });
  const { m, installed } = fakeManager();
  const r = await go({ dir, manager: m, listener: async () => ({ version: "0.9.0" }) });
  expect(r.code).toBe(0);
  expect(installed.length).toBe(1);
});

test("a ServiceError is reported in one line, exit 1", async () => {
  const { m } = fakeManager({ install: async () => { throw new ServiceError("systemd has no user session here (No medium found)"); } });
  const r = await go({ manager: m });
  expect(r.code).toBe(1);
  expect(r.out).toContain("No medium found");
});

test("linger refused: success, but the warning and 'login' are both said", async () => {
  const { m } = fakeManager({
    install: async () => ({ warnings: ["could not enable linger (Access denied) — To fix: sudo loginctl enable-linger operator"] }),
    startsAt: async () => "login",
  });
  const r = await go({ manager: m });
  expect(r.code).toBe(0);
  expect(r.out).toContain("Access denied");
  expect(r.out).toContain("starts at login");
  expect(r.out).not.toContain("starts at boot");
});

test("registered but not answering: exit 1, says it keeps retrying and where to look", async () => {
  const r = await go({ healthCheck: async () => false });
  expect(r.code).toBe(1);
  expect(r.out).toContain("registered");
  expect(r.out).toContain("herdr");
  expect(r.out).toContain("journalctl --user -u paddock");
});

test("unreadable state is a refusal, not a guess", async () => {
  // ENOTDIR on the state file's parent — the trick lifecycle-status.test.ts
  // uses, because chmod would not stop root in CI.
  const parent = await mkdtemp(join(tmpdir(), "paddock-local-"));
  const blocker = join(parent, "blocker");
  await writeFile(blocker, "not a directory");
  const { m, installed } = fakeManager();
  const r = await go({ dir: join(blocker, "child"), manager: m });
  expect(r.code).toBe(1);
  expect(installed).toEqual([]);
  expect(r.out).toContain("refusing to guess");
});

// ---- tailscale: local re-applies the serve that stop removed ---------------

const TS_BIN = "/usr/bin/tailscale";
const TS_HOST = "dev-box.example-tailnet.ts.net";
const TS_SERVE_STATUS = `${TS_BIN} serve status --json`;
const TS_SERVE_ON = `${TS_BIN} serve --bg --https=443 http://127.0.0.1:8789`;
const servedTo = (proxy: string) =>
  JSON.stringify({ Web: { [`${TS_HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

async function tsLocal(o: {
  config?: boolean;
  found?: string | null;
  serve?: { code?: number; out?: string; err?: string };
  onFails?: boolean;
  installFails?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  if (o.config !== false) {
    await writeFile(join(dir, "tailscale.json"), JSON.stringify({
      enabled: true, login: "operator@github", host: TS_HOST,
    }));
  }
  const events: string[] = [];
  const { m } = fakeManager({
    install: async () => {
      events.push("install");
      if (o.installFails) throw new ServiceError("`systemctl --user enable paddock.service` failed: no bus");
      return { warnings: [] };
    },
  });
  const r = await go({
    dir, manager: m, tailnetPort: 8789,
    find: () => (o.found === undefined ? TS_BIN : o.found),
    run: async (argv) => {
      const k = argv.join(" ");
      events.push(`run ${k}`);
      if (k === TS_SERVE_ON && o.onFails) return { code: 1, out: "", err: "serve config denied" };
      if (k === TS_SERVE_STATUS) {
        const a = o.serve ?? { out: "" };
        return { code: a.code ?? 0, out: a.out ?? "", err: a.err ?? "" };
      }
      return { code: 0, out: "", err: "" };
    },
  });
  return { ...r, events };
}

test("tailscale: config enabled → serve is re-applied after the install", async () => {
  const r = await tsLocal({});
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install", `run ${TS_SERVE_STATUS}`, `run ${TS_SERVE_ON}`]);
  expect(r.out).toContain(`tailscale — https://${TS_HOST}`);
});

test("tailscale: no config → no tailscale calls at all", async () => {
  const r = await tsLocal({ config: false });
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install"]);
  expect(r.out).not.toContain("tailscale");
});

test("tailscale: a `serveOn` failure warns, and local still exits 0", async () => {
  const r = await tsLocal({ onFails: true });
  expect(r.code).toBe(0);
  expect(r.out).toContain("serve config denied");
  expect(r.out).toContain("paddock tailscale");
});

test("tailscale: another app's 443 serve is not overwritten; warns, exits 0", async () => {
  const r = await tsLocal({ serve: { out: servedTo("http://127.0.0.1:3000") } });
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install", `run ${TS_SERVE_STATUS}`]);
  expect(r.out).toContain("http://127.0.0.1:3000");
});

test("tailscale: serve already ours is left as is, not re-run", async () => {
  const r = await tsLocal({ serve: { out: servedTo("http://127.0.0.1:8789") } });
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install", `run ${TS_SERVE_STATUS}`]);
  expect(r.out).toContain(`tailscale — https://${TS_HOST}`);
});

test("tailscale: a failing `serve status` warns and does not serve blind; exits 0", async () => {
  const r = await tsLocal({ serve: { code: 1, err: "failed to connect to local tailscaled" } });
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install", `run ${TS_SERVE_STATUS}`]);
  expect(r.out).toContain("failed to connect to local tailscaled");
});

test("tailscale: the binary missing with a config present warns; exits 0", async () => {
  const r = await tsLocal({ found: null });
  expect(r.code).toBe(0);
  expect(r.events).toEqual(["install"]);
  expect(r.out).toContain("not found");
});

test("tailscale: a failed install touches no tailscale serve", async () => {
  const r = await tsLocal({ installFails: true });
  expect(r.code).toBe(1);
  expect(r.events).toEqual(["install"]);
});

test("tailscale: serve is re-applied even while the service is still coming up; exit stays local's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-local-"));
  await writeFile(join(dir, "tailscale.json"), JSON.stringify({
    enabled: true, login: "operator@github", host: TS_HOST,
  }));
  const ran: string[] = [];
  const r = await go({
    dir, healthCheck: async () => false, tailnetPort: 8789,
    find: () => TS_BIN,
    run: async (argv) => { ran.push(argv.join(" ")); return { code: 0, out: "", err: "" }; },
  });
  expect(r.code).toBe(1);
  expect(ran).toEqual([TS_SERVE_STATUS, TS_SERVE_ON]);
});
