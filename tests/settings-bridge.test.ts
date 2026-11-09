import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { migrate, SettingsStore } from "@server/settings/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const dir = async () => mkdtemp(join(tmpdir(), "paddock-settings-bridge-"));

test("bridge is off by default", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  expect(s.current().bridge.enabled).toBe(false);
  expect(s.view().bridge.enabled).toBe(false);
});

test("migrate keeps an old file valid", () => {
  expect(migrate({ version: 2, telegram: {}, notify: {}, push: { enabled: false } }).bridge)
    .toEqual({ enabled: false });
});

test("migrate refuses a non-boolean, audibly", () => {
  const logs: string[] = [];
  expect(migrate({ version: 2, bridge: { enabled: "yes" } }, (m) => logs.push(m)).bridge.enabled).toBe(false);
  expect(logs.some((l) => l.includes("bridge.enabled"))).toBe(true);
});

test("patch turns it on and persists", async () => {
  const d = await dir();
  const s = new SettingsStore(d, {});
  await s.load();
  await s.patch({ bridge: { enabled: true } });
  const again = new SettingsStore(d, {});
  await again.load();
  expect(again.current().bridge.enabled).toBe(true);
});

function app(settings: SettingsStore) {
  const store = new AgentStore("dev-box");
  return createApp({
    store, hub: new Hub({ now: () => 0 }), settings, now: () => 0,
    health: () => ({ ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true, lastEventAt: 0, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, core: { connected: false, lastEventAt: null, generation: null, version: null, detail: null }, app: null, schemaWarning: null }),
  });
}

const put = (a: ReturnType<typeof app>, body: object) =>
  a.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PUT /api/settings toggles the bridge", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  const res = await put(app(s), { bridge: { enabled: true } });
  expect(res.status).toBe(200);
  expect((await res.json()).bridge.enabled).toBe(true);
  expect(s.current().bridge.enabled).toBe(true);
});

test("PUT /api/settings refuses a non-boolean bridge.enabled", async () => {
  const s = new SettingsStore(await dir(), {});
  await s.load();
  const res = await put(app(s), { bridge: { enabled: 1 } });
  expect(res.status).toBe(400);
  expect(s.current().bridge.enabled).toBe(false);
});
