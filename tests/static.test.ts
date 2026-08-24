import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

function app() {
  const store = new AgentStore("dev-box");
  const hub = new Hub();
  return createApp({
    store, hub,
    health: () => ({
      ok: true, hostId: "dev-box", agents: 0, clients: 0,
      herdrConnected: true, lastEventAt: null, lastNotifyError: null,
      version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null,
    }),
    staticDir: "dist",
  });
}

// These assert against a REAL dist/. `make test` builds the UI first; the
// previous version accepted [200, 404] and only checked "not JSON", which
// deleting the entire `if (deps.staticDir)` block would still have satisfied.
test("an unknown non-API path falls back to index.html for the SPA", async () => {
  const res = await app().request("/some/deep/link");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  // The actual SPA document, not merely some HTML: without the fallback the
  // deep link would 404 and a refresh on any route would break the app.
  expect(await res.text()).toContain('<div id="root">');
});

test("a real built asset is served with the immutable cache header", async () => {
  const asset = readdirSync("dist/assets").find((name) => name.endsWith(".js"));
  if (!asset) throw new Error("dist/assets has no JS bundle — run `make test`, not `bun test`");
  const res = await app().request(`/assets/${asset}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("API 404s stay JSON and never fall back to index.html", async () => {
  const res = await app().request("/api/nope");
  expect(res.status).toBe(404);
  // The name of this test was the only thing asserting the content type.
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  expect(await res.json()).toEqual({ error: "not found" });
});
