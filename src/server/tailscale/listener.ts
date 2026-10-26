import type { WebSocketHandler } from "bun";
import { errorCode } from "@server/startup-errors";
import { tailnetRefusal } from "@server/tailscale/gate";
import { tryUpgradeWs, type WsData } from "@server/ws/serve";

/**
 * Loopback, always, and never read from `PADDOCK_HOST`. The identity header is
 * trustworthy only because the one peer that can reach this socket is
 * `tailscale serve` on this machine, which overwrites it. Bound anywhere wider,
 * any host on that network could send the header itself.
 */
export const TAILNET_HOSTNAME = "127.0.0.1";

export interface TailnetListenerOpts {
  app: { fetch(req: Request): Response | Promise<Response> };
  websocket: WebSocketHandler<WsData>;
  port: number;
  /** The one Tailscale login let in. */
  login: string;
  /** This listener's own allowlist: the shared list plus the ts.net host. */
  publicHosts: () => readonly string[];
}

export type TailnetListener =
  | { ok: true; port: number; hostname: string; stop(): void }
  | { ok: false; error: string };

/**
 * The shared same-origin list plus this machine's tailnet host.
 *
 * Only the tailnet listener uses this. Adding the host to the SHARED list would
 * switch the origin check on for an operator who had none (an empty list means
 * "check off"), turning their Cloudflare hostname read-only.
 */
export function tailnetHosts(shared: readonly string[], host: string): readonly string[] {
  return shared.includes(host) ? shared : [...shared, host];
}

/**
 * The second, identity-gated listener `tailscale serve` forwards to.
 *
 * The gate runs HERE, at the socket, before anything else — the same reason
 * `serveGated` in `tunnel/run.ts` does it there: `/ws` is upgraded before
 * `app.fetch` is ever called, so app middleware could never gate it, and the
 * socket carries every agent's live output. Static files (`/sw.js`, the shell)
 * are gated too; the spec says every request.
 *
 * EADDRINUSE comes back as `{ok:false}` so the caller can warn and keep the
 * dashboard on its own port. Anything else rethrows with its stack intact.
 */
export function startTailnetListener(o: TailnetListenerOpts): TailnetListener {
  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = Bun.serve<WsData>({
      port: o.port,
      hostname: TAILNET_HOSTNAME,
      fetch(req, srv) {
        const refused = tailnetRefusal(req, o.login);
        if (refused !== null) return refused;
        const ws = tryUpgradeWs(req, srv, o.publicHosts());
        if (ws !== null) return ws;
        return o.app.fetch(req);
      },
      websocket: o.websocket,
    });
  } catch (err) {
    if (errorCode(err) !== "EADDRINUSE") throw err;
    return { ok: false, error: `port ${o.port} on ${TAILNET_HOSTNAME} is already in use` };
  }
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("paddock: the tailnet listener bound no port");
  }
  return {
    ok: true,
    port,
    // Bun's own answer for what it bound, not the constant echoed back, so a
    // test of this value tests the socket.
    hostname: server.hostname ?? "",
    stop: () => server.stop(true),
  };
}
