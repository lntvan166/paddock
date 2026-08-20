import { expect, test } from "bun:test";
import { Hono } from "hono";
import { gateMiddleware } from "@server/tunnel/gate";
import { Pairing } from "@server/tunnel/pairing";

/**
 * The gate must exist on the tunnel's listener and NOWHERE ELSE. If it leaks
 * onto 8787, every desk browser and every `make dev` session starts asking for
 * a pairing code, and the cause is not obvious from the symptom.
 */
test("the plain app is ungated; only the wrapped one asks for a code", async () => {
  const routes = (app: Hono) => {
    app.get("/api/agents", (c) => c.json({ agents: [] }));
    return app;
  };

  const plain = routes(new Hono());
  expect((await plain.request("/api/agents")).status).toBe(200);

  const gated = new Hono();
  gated.use("*", gateMiddleware(new Pairing({ now: () => 0 })));
  routes(gated);
  expect((await gated.request("/api/agents")).status).toBe(401);
});
