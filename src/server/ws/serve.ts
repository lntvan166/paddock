import type { Server, WebSocketHandler } from "bun";
import type { AgentStore } from "@server/state/store";
import type { Hub, HubClient } from "@server/ws/hub";

/**
 * What a socket carries: the hub client it was added as, so `close` can remove
 * exactly that one. Optional because Bun creates the data before `open` runs.
 */
export interface WsData {
  client?: HubClient;
}

export interface HubSocketDeps {
  hub: Hub;
  hostId: string;
  store: AgentStore;
}

/**
 * ONE definition of the `/ws` route, shared by BOTH listeners — the plain
 * `127.0.0.1:8787` one in `index.ts` and the gated one in `tunnel/run.ts`.
 *
 * It lived twice, character-for-character, and that is the hazard worth a
 * module: the upgrade path is the one the tunnel's gate has to cover, so a
 * change made to one copy and not the other is a difference in what the public
 * listener does with a WebSocket. A v2 that gives `message()` a job, or changes
 * what `open` sends, must be unable to land on one listener only.
 *
 * THREE return values, deliberately:
 *  - `null`  — not this route; the caller falls through to `app.fetch`.
 *  - `undefined` — upgraded. Bun's own signal that the response IS the upgrade.
 *  - a `Response` — the upgrade was refused.
 */
export function tryUpgradeWs(req: Request, srv: Server<WsData>): Response | undefined | null {
  if (new URL(req.url).pathname !== "/ws") return null;
  const upgraded = srv.upgrade(req, { data: {} });
  return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
}

/**
 * The hub's three handlers: join and get a snapshot, leave, and ignore
 * anything sent up.
 *
 * A factory rather than a constant because the handlers close over this
 * process's hub, host id and store — which `index.ts` holds as top-level
 * consts and `tunnel/run.ts` receives as deps.
 */
export function hubWebSocket(deps: HubSocketDeps): WebSocketHandler<WsData> {
  return {
    open(ws) {
      const client: HubClient = { send: (d) => ws.send(d) };
      ws.data.client = client;
      deps.hub.add(client);
      deps.hub.sendSnapshot(client, deps.hostId, deps.store.snapshot());
    },
    close(ws) {
      const held = ws.data.client;
      if (held) deps.hub.remove(held);
    },
    message() {
      // Read-only in v1: the browser sends nothing, on either listener.
    },
  };
}
