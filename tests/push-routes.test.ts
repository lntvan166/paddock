import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { PushStore } from "@server/push/store";
import { SettingsStore } from "@server/settings/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const dir = () => mkdtemp(join(tmpdir(), "paddock-pushroutes-"));

const GOOD = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

/**
 * Mirrors `tests/settings-routes.test.ts`'s harness rather than inventing a
 * second construction path — `{}` for the env explicitly, for the reason that
 * file records: `SettingsStore.load()` seeds from PADDOCK_TELEGRAM_* and a
 * machine where the operator followed the README would start pre-configured.
 */
async function harness() {
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-pr-")), {});
  await settings.load();
  const push = await PushStore.load(await dir());
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub({ build: () => "test" }),
    health: () => ({
      ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true,
      lastEventAt: null, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
      managedBy: null, herdrProtocol: null, schemaWarning: null,
    }),
    settings,
    push,
  });
  return { app, push };
}

/** Hono's `request` returns `Response | Promise<Response>`; awaiting handles both. */
type App = { request: (p: string, i?: RequestInit) => Response | Promise<Response> };

const post = (app: App, path: string, body: unknown): Promise<Response> =>
  Promise.resolve(app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

test("a valid subscription is stored", async () => {
  const { app, push } = await harness();
  const res = await post(app, "/api/push/subscribe", GOOD);
  expect(res.status).toBe(200);
  expect(push.list()).toHaveLength(1);
  expect(push.list()[0]!.endpoint).toBe(GOOD.endpoint);
});

test("a non-https endpoint is refused, loudly", async () => {
  const { app, push } = await harness();
  const res = await post(app, "/api/push/subscribe", {
    ...GOOD, endpoint: "http://insecure.example.com/push",
  });
  expect(res.status).toBe(400);
  expect((await res.json() as { detail: string }).detail).toContain("https");
  expect(push.list()).toEqual([]);
});

test("keys of the wrong length are refused", async () => {
  // Stored now, this fails at send time, hours later, with the operator
  // nowhere near the terminal. Refuse at the door instead.
  const { app, push } = await harness();
  for (const bad of [
    { ...GOOD.keys, p256dh: "c2hvcnQ" },
    { ...GOOD.keys, auth: "dG9vLXNob3J0" },
  ]) {
    const res = await post(app, "/api/push/subscribe", { ...GOOD, keys: bad });
    expect(res.status).toBe(400);
  }
  expect(push.list()).toEqual([]);
});

test("a key that is not base64url at all is refused, not thrown", async () => {
  const { app, push } = await harness();
  const res = await post(app, "/api/push/subscribe", {
    ...GOOD, keys: { ...GOOD.keys, p256dh: "!!!! not base64 !!!!" },
  });
  expect(res.status).toBe(400);
  expect(push.list()).toEqual([]);
});

test("unsubscribe removes exactly the endpoint given", async () => {
  const { app, push } = await harness();
  await push.add({ endpoint: GOOD.endpoint, ...GOOD.keys });
  await push.add({ endpoint: "https://fcm.googleapis.com/fcm/send/other", ...GOOD.keys });
  const res = await post(app, "/api/push/unsubscribe", { endpoint: GOOD.endpoint });
  expect(res.status).toBe(200);
  expect(push.list()).toHaveLength(1);
  expect(push.list()[0]!.endpoint).toBe("https://fcm.googleapis.com/fcm/send/other");
});

test("the settings view carries the public key, the device count and any error", async () => {
  const { app, push } = await harness();
  await push.add({ endpoint: GOOD.endpoint, ...GOOD.keys });
  const res = await app.request("/api/settings");
  const view = await res.json() as {
    push: { devices: number; vapidPublicKey: string | null; error: string | null };
  };
  expect(view.push.devices).toBe(1);
  expect(view.push.vapidPublicKey).toBe(push.publicKey());
  expect(view.push.error).toBeNull();
});

test("the private key never appears in the settings view", async () => {
  // The same rule SettingsView already states for the Telegram token.
  const { app, push } = await harness();
  const body = await (await app.request("/api/settings")).text();
  expect(body).not.toContain(push.keys()!.privateKey.d!);
  expect(body).not.toContain('"privateKey"');
});

test("push enabled is patchable and nothing else about push is", async () => {
  const { app } = await harness();
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ push: { enabled: true } }),
  });
  expect(res.status).toBe(200);
  const view = await (await app.request("/api/settings")).json() as {
    push: { enabled: boolean };
  };
  expect(view.push.enabled).toBe(true);
});
