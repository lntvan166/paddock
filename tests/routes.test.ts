import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

function app(
  over: Partial<{
    lastEventAt: number | null; herdrConnected: boolean; lastNotifyError: string | null;
    managedBy: "homebrew" | null;
  }> = {},
) {
  const store = new AgentStore("dev-box");
  const hub = new Hub();
  return createApp({
    store,
    hub,
    health: () => ({
      ok: true, hostId: "dev-box", agents: store.snapshot().length,
      clients: hub.clientCount, herdrConnected: over.herdrConnected ?? true,
      lastEventAt: over.lastEventAt ?? null,
      lastNotifyError: over.lastNotifyError ?? null,
      version: "0.0.0-dev", latestKnown: null, herdrProtocol: null, schemaWarning: null,
      managedBy: over.managedBy ?? null,
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

// A broken Telegram token must be visible within seconds via /api/health, not
// never. Type-level requiredness on HealthBody protects the health() literal
// at the composition root; this protects the actual serialized response —
// a key silently dropped by a future refactor of health() would not show up
// as a type error if the object were spread or reshaped, only here.
test("GET /api/health exposes lastNotifyError", async () => {
  const res = await app({ lastNotifyError: "bad token" }).request("/api/health");
  const body = await res.json();
  expect(body).toHaveProperty("lastNotifyError");
  expect(body.lastNotifyError).toBe("bad token");
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

test("GET /api/health reports which package manager owns the install", async () => {
  // The same fact the banner rides the WS for, exposed where `paddock doctor`
  // and a human with curl can read it. Required in the type, not optional, so
  // a future edit to health() that drops it is a type error.
  const res = await app({ managedBy: "homebrew" }).request("/api/health");
  const body = await res.json();
  expect(body.managedBy).toBe("homebrew");
});

test("GET /api/health reports null when nothing owns the install", async () => {
  const body = await (await app({}).request("/api/health")).json();
  expect(body.managedBy).toBeNull();
});
