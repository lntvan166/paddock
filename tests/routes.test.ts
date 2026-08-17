import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

function app(over: Partial<{ lastEventAt: number | null; herdrConnected: boolean }> = {}) {
  const store = new AgentStore("dev-box");
  const hub = new Hub();
  return createApp({
    store,
    hub,
    health: () => ({
      ok: true, hostId: "dev-box", agents: store.snapshot().length,
      clients: hub.clientCount, herdrConnected: over.herdrConnected ?? true,
      lastEventAt: over.lastEventAt ?? null,
    }),
  });
}

test("GET /api/health returns ok and exposes lastEventAt", async () => {
  const res = await app({ lastEventAt: 1_700_000_000_000 }).request("/api/health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.lastEventAt).toBe(1_700_000_000_000);
  expect(body).toHaveProperty("herdrConnected");
});

test("GET /api/agents returns the snapshot", async () => {
  const res = await app().request("/api/agents");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hostId: "dev-box", agents: [] });
});

test("an unknown API path 404s rather than falling through", async () => {
  expect((await app().request("/api/nope")).status).toBe(404);
});

test("no route requires an auth token", async () => {
  // Access is the only gate; a token would 401 /sw.js and break the service worker.
  expect((await app().request("/api/health")).status).toBe(200);
  expect((await app().request("/api/agents")).status).toBe(200);
});
