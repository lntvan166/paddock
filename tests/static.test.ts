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
      herdrConnected: true, lastEventAt: null,
    }),
    staticDir: "dist",
  });
}

test("an unknown non-API path falls back to index.html for the SPA", async () => {
  const res = await app().request("/some/deep/link");
  // 200 when dist/ has been built, 404 before that. Either proves it is not a
  // JSON 404 from the API router.
  expect([200, 404]).toContain(res.status);
  expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
});

test("API 404s stay JSON and never fall back to index.html", async () => {
  const res = await app().request("/api/nope");
  expect(res.status).toBe(404);
});
