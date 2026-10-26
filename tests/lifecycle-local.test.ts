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
