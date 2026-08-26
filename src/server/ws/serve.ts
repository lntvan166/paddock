import type { Server, WebSocketHandler } from "bun";
import type { AgentStore } from "@server/state/store";
import type { PresenceStore } from "@server/state/presence";
import type { Hub, HubClient } from "@server/ws/hub";
import { allowUpgrade, hostOf } from "@server/origin";
import type { ClientMessage } from "@shared/types";

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
  presence: PresenceStore;
}

/**
 * The frame cap. A `viewing` frame is about 120 bytes; 1 KB is generous and
 * finite, which is the property that matters for something a client controls.
 */
export const MAX_CLIENT_FRAME = 1024;

/** Longest plausible values. A pane id is `w1:p1`; a device key is 43 chars. */
const MAX_DEVICE_KEY = 128;
const MAX_AGENT_ID = 256;

/**
 * A client frame, or null for anything paddock does not recognise.
 *
 * NULL RATHER THAN A THROW, at every branch. Throwing inside Bun's `message`
 * handler drops the connection, which would turn a malformed frame into a way
 * to disconnect somebody's dashboard — and an unknown `type` is what a newer
 * client talking to an older server looks like, which must degrade to no
 * presence rather than to a broken socket.
 *
 * Exported so the parser is tested directly against hostile input rather than
 * only through a live socket.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > MAX_CLIENT_FRAME) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== "viewing") return null;
  const { deviceKey, agentId } = m;
  if (deviceKey !== null && typeof deviceKey !== "string") return null;
  if (agentId !== null && typeof agentId !== "string") return null;
  if (deviceKey !== null && deviceKey.length > MAX_DEVICE_KEY) return null;
  if (agentId !== null && agentId.length > MAX_AGENT_ID) return null;
  return { type: "viewing", deviceKey, agentId };
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
 *
 * The ORIGIN CHECK is here, before `srv.upgrade`, and it has to be: a WebSocket
 * handshake is exempt from CORS entirely, so no preflight and no browser rule
 * stopped a hostile page opening this socket — and `open` below sends the whole
 * snapshot, so a refusal that arrived any later would have already disclosed
 * every agent's name, id and screen. `allowUpgrade` refuses a MISSING `Origin`
 * as well as a mismatched one; `origin.ts` says why that is right here and wrong
 * for a write.
 *
 * `publicHosts` defaults to empty, which is the correct value for "no public
 * hostname is known" rather than a weakening — see `publicHostsFrom`.
 */
export function tryUpgradeWs(
  req: Request,
  srv: Server<WsData>,
  publicHosts: readonly string[] = [],
): Response | undefined | null {
  if (new URL(req.url).pathname !== "/ws") return null;
  if (!allowUpgrade(req.headers.get("origin"), hostOf(req), publicHosts)) {
    return new Response("cross-origin rejected", { status: 403 });
  }
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
      if (held) {
        deps.hub.remove(held);
        // Presence dies with the connection. This is the fast path of the three
        // that release a viewer; the TTL in `presence.ts` covers the socket iOS
        // never closes.
        deps.presence.drop(held);
      }
    },
    message(ws, raw) {
      const client = ws.data.client;
      if (client === undefined) return;
      // Sized BEFORE any conversion: measuring a Buffer by `byteLength` rather
      // than stringifying it first is what keeps the cap a cap.
      const size = typeof raw === "string" ? raw.length : raw.byteLength;
      if (size > MAX_CLIENT_FRAME) return;
      const msg = parseClientMessage(typeof raw === "string" ? raw : raw.toString());
      if (msg === null) return;
      // The agentId is a Map key, compared against ids the store already holds.
      // It never reaches herdr, so there is nothing behind it to reach.
      deps.presence.set(client, { deviceKey: msg.deviceKey, agentId: msg.agentId });
    },
  };
}
