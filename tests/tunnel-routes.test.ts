import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import { SettingsStore } from "@server/settings/store";
import { COOKIE_NAME, formatCode, Pairing } from "@server/tunnel/pairing";

const NOW = 1_700_000_000_000;
const TUNNEL = "https://quiet-harbor-8f31.trycloudflare.com";

const health = () => ({
  ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
});

// Mirrors tests/settings-routes.test.ts: a real SettingsStore over a fresh
// temp directory, never `{}` written outside one. `/api/settings` only exists
// when `deps.settings` is present, and this suite needs that route for the
// "tunnel" field it is adding to SettingsView.
async function settingsStore(): Promise<SettingsStore> {
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-tunnel-")), {});
  await settings.load();
  return settings;
}

async function harness() {
  let i = 0;
  const pairing = new Pairing({
    now: () => NOW,
    bytes: (n) => Uint8Array.from({ length: n }, () => i++ % 256),
  });
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    pairing,
    tunnelUrl: () => TUNNEL,
    health,
    settings: await settingsStore(),
  });
  return { app, pairing };
}

const postJson = (app: Awaited<ReturnType<typeof harness>>["app"], path: string, body: object) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the right code pairs and sets the session cookie", async () => {
  const { app, pairing } = await harness();
  const res = await postJson(app, "/pair", { code: formatCode(pairing.current().code) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`${COOKIE_NAME}=`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Max-Age=2592000");
  expect(pairing.pairedCount).toBe(1);
});

test("a wrong code is a 400 that says how many tries are left", async () => {
  const { app } = await harness();
  const res = await postJson(app, "/pair", { code: "00000000" });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { detail: string };
  expect(body.detail).toContain("4");
  expect(res.headers.get("set-cookie")).toBe(null);
});

test("burning the code answers 429, not 400", async () => {
  const { app } = await harness();
  let last = await postJson(app, "/pair", { code: "00000000" });
  for (let i = 0; i < 4; i++) last = await postJson(app, "/pair", { code: "00000000" });
  expect(last.status).toBe(429);
});

test("/pair requires application/json, like every other write", async () => {
  // Decision 12: the content type restores the CORS preflight that is the
  // whole CSRF control, and this route is reachable from the internet by design.
  const { app, pairing } = await harness();
  const res = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ code: pairing.current().code }),
  });
  expect(res.status).toBe(400);
  expect(pairing.pairedCount).toBe(0);
});

test("a missing or non-string code is rejected without counting an attempt", async () => {
  const { app } = await harness();
  expect((await postJson(app, "/pair", {})).status).toBe(400);
  expect((await postJson(app, "/pair", { code: 42 })).status).toBe(400);
  // A malformed body is not a guess — the budget must be intact.
  const res = await postJson(app, "/pair", { code: "00000000" });
  expect(((await res.json()) as { detail: string }).detail).toContain("4");
});

test("the invite route mints a fresh code and reports its expiry", async () => {
  const { app, pairing } = await harness();
  const before = pairing.current().code;
  const res = await postJson(app, "/api/pair/invite", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string; expiresAt: number };
  expect(body.code).not.toBe(formatCode(before));
  expect(body.code).toBe(formatCode(pairing.current().code));
  expect(body.expiresAt).toBe(pairing.current().expiresAt);
});

test("the settings view carries the tunnel and its paired count", async () => {
  const { app, pairing } = await harness();
  pairing.attempt(pairing.current().code);
  const res = await app.request("/api/settings");
  const body = (await res.json()) as { tunnel: { url: string; pairedDevices: number } | null };
  expect(body.tunnel).toEqual({ url: TUNNEL, pairedDevices: 1 });
});

test("without a pairing instance neither route exists and tunnel is null", async () => {
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    health,
    settings: await settingsStore(),
  });
  expect((await app.request("/pair", { method: "POST" })).status).toBe(404);
  expect((await app.request("/api/pair/invite", { method: "POST" })).status).toBe(404);
  const body = (await (await app.request("/api/settings")).json()) as { tunnel: unknown };
  expect(body.tunnel).toBe(null);
});
