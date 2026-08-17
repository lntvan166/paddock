import { Hono } from "hono";
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

export interface AppDeps {
  store: AgentStore;
  hub: Hub;
  health: () => HealthBody;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // No authentication middleware. Cloudflare Access is the only gate — see
  // docs/decisions.md before adding one.
  app.get("/api/health", (c) => c.json(deps.health()));

  app.get("/api/agents", (c) =>
    c.json({ hostId: deps.store.hostId, agents: deps.store.snapshot() }),
  );

  return app;
}
