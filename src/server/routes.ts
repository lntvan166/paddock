import { Hono } from "hono";
import type { HerdrActions } from "@server/herdr/actions";
import { parsePrompt } from "@server/herdr/prompt-parse";
import type { AgentStore } from "@server/state/store";
import type { Hub } from "@server/ws/hub";

export interface HealthBody {
  ok: boolean;
  hostId: string;
  agents: number;
  clients: number;
  herdrConnected: boolean;
  /**
   * Epoch ms of the last herdr event. Exposed deliberately: a stuck event stream
   * is otherwise invisible, which is how a comparable system dropped every
   * event while reporting success.
   */
  lastEventAt: number | null;
}

// Vite's content hash is base64url (letters, digits, "_", "-"), joined to the
// basename with a dash, e.g. "index-BRl8nQbG.js" or "index-Cj_7W-bH.css" — not
// the dot-separated lowercase-hex shape this used to require, which matched no
// real build output and so never actually set the immutable header.
export const IMMUTABLE_ASSET_RE = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/;

export interface AppDeps {
  store: AgentStore;
  hub: Hub;
  health: () => HealthBody;
  /** Built UI directory. Omit in tests that only exercise the API. */
  staticDir?: string;
  /** herdr actions. Omit in tests that only exercise the read-only API. */
  actions?: HerdrActions;
  /**
   * Clock for `/ack`'s `acknowledgedAt` stamp. Same injectable-clock pattern
   * as `Hub`, `Supervisor`, and `DemoSource` elsewhere in this codebase —
   * defaults to `Date.now` in production, overridden in tests so an
   * assertion can compare against a fixed fixture timestamp.
   */
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  // No authentication middleware. Cloudflare Access is the only gate — see
  // docs/decisions.md before adding one.
  app.get("/api/health", (c) => c.json(deps.health()));

  app.get("/api/agents", (c) =>
    c.json({ hostId: deps.store.hostId, agents: deps.store.snapshot() }),
  );

  if (deps.actions) {
    const actions = deps.actions;

    // POST, never GET: a payload in a query string lands in edge access logs.
    app.post("/api/agents/:id/output", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      const body = await c.req.json().catch(() => ({}) as { lines?: number });
      try {
        return c.json(await actions.readOutput(agent.agentId, agent.state, body.lines));
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/prompt", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);
      try {
        return c.json(parsePrompt(await actions.readDetection(agent.agentId)));
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/answer", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      // THE scope boundary. agent.prompt accepts arbitrary text, so "only a
      // blocked agent may be answered" is enforced here against the store, not
      // trusted to the UI. If someone answered at the desk first, the agent is
      // no longer blocked and this reply must not be typed into whatever is now
      // on screen.
      if (agent.state !== "blocked") {
        return c.json({ ok: false, detail: `agent is ${agent.state}, no longer blocked` }, 409);
      }

      const body = await c.req.json().catch(() => ({}) as { key?: string; text?: string });
      if (!body.key && !body.text) {
        return c.json({ ok: false, detail: "provide key or text" }, 400);
      }

      try {
        if (body.key) await actions.sendOptionKey(agent.agentId, body.key);
        else await actions.sendReply(agent.agentId, body.text!);
        await actions.waitUntilUnblocked(agent.agentId);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ ok: false, detail: String(err) }, 502);
      }
    });

    app.post("/api/agents/:id/ack", (c) => {
      const delta = deps.store.acknowledge(c.req.param("id"), now());
      if (!delta) return c.json({ ok: false, detail: "not a fresh done agent" }, 409);
      deps.hub.queue(delta); // reaches every other open browser
      return c.json({ ok: true });
    });
  }

  // API 404s must stay JSON, so this guard comes before the SPA fallback.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (deps.staticDir) {
    const dir = deps.staticDir;
    app.get("/*", async (c) => {
      const path = new URL(c.req.url).pathname;
      const candidate = Bun.file(`${dir}${path}`);
      if (path !== "/" && (await candidate.exists())) {
        // Content-hashed assets are safe to cache forever.
        const immutable = IMMUTABLE_ASSET_RE.test(path);
        return new Response(candidate, {
          headers: immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {},
        });
      }
      const index = Bun.file(`${dir}/index.html`);
      if (!(await index.exists())) return c.text("UI not built — run `make build`", 404);
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }

  return app;
}
