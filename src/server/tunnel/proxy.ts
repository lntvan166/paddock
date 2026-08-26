import type { ServerWebSocket } from "bun";

/**
 * Where an attached tunnel forwards to: the paddock already serving locally.
 */
export interface Upstream {
  host: string;
  port: number;
}

/** The origin an upstream paddock believes is its own. */
export function upstreamOrigin(u: Upstream): string {
  return `http://${u.host}:${u.port}`;
}

/**
 * Forward one HTTP request to the paddock already running, and return its
 * answer unchanged.
 *
 * ORIGIN AND HOST ARE REWRITTEN, and that is the whole subtlety here. paddock
 * refuses a cross-origin write (`server/origin.ts`) because it has no auth
 * token — the origin check is what stops another process on this host POSTing
 * to a TCP port every uid can reach. Forwarded verbatim, a request arriving
 * from `https://something.trycloudflare.com` fails that check and every write
 * through an attached tunnel is refused with a 403 the operator cannot explain.
 *
 * So the proxy presents itself as what it is: a local client of the upstream.
 * The rule on the upstream is untouched and no case is loosened — the same fix
 * the Vite dev proxy needed, for the same reason.
 *
 * The PUBLIC gate is not weakened by this either: `decide()` has already run
 * before anything reaches here, so a request without a valid pairing token
 * never becomes an upstream request at all.
 */
export async function proxyHttp(req: Request, u: Upstream): Promise<Response> {
  const from = new URL(req.url);
  const to = new URL(from.pathname + from.search, upstreamOrigin(u));

  const headers = new Headers(req.headers);
  headers.set("origin", upstreamOrigin(u));
  headers.set("host", `${u.host}:${u.port}`);
  // Hop-by-hop headers belong to the connection that carried them, not to the
  // message. Forwarding `connection`/`upgrade` onto a fresh fetch is how a
  // proxy produces a request that contradicts its own transport.
  headers.delete("connection");
  headers.delete("upgrade");
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");

  try {
    return await fetch(to, {
      method: req.method,
      headers,
      // GET and HEAD carry none, and Bun rejects a body on them outright.
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // Required by undici whenever a stream body is sent.
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { duplex: "half" }),
    } as RequestInit);
  } catch (err) {
    // Never swallowed, and never rendered as an application error: the
    // upstream being gone is a different fact from the upstream saying no, and
    // an operator whose paddock has stopped needs to be told THAT.
    const detail = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        ok: false,
        detail: `the paddock this tunnel is attached to is not answering on ${u.host}:${u.port} (${detail})`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

/**
 * The two ends of one proxied WebSocket.
 *
 * `up` is opened when the browser's socket opens and closed when it closes, so
 * an attached tunnel holds exactly one upstream socket per viewer rather than
 * one for the life of the process.
 */
export interface ProxySocket {
  up: WebSocket | null;
  /** Frames that arrived from the browser before `up` finished opening. */
  pending: (string | Uint8Array)[];
}

/**
 * Bridge a browser WebSocket to the upstream paddock's `/ws`.
 *
 * paddock's own upgrade check REFUSES a missing `Origin` (`allowUpgrade` in
 * `origin.ts`) — deliberately, since browsers always send one on a handshake
 * and requiring it shuts out a non-browser reader. So this sets the upstream's
 * own origin, exactly as the HTTP path does.
 *
 * Frames are forwarded verbatim in both directions. Nothing here inspects a
 * payload: the snapshot and delta shapes belong to `ws/hub.ts`, and a proxy
 * that parsed them would be a second place to keep in step with them.
 */
export function bridgeWebSocket(
  ws: ServerWebSocket<{ proxy: ProxySocket }>,
  u: Upstream,
  make: (url: string, opts: { headers: Record<string, string> }) => WebSocket =
    (url, opts) => new WebSocket(url, opts as unknown as string[]),
): void {
  const state = ws.data.proxy;
  const up = make(`ws://${u.host}:${u.port}/ws`, {
    headers: { origin: upstreamOrigin(u) },
  });
  state.up = up;

  up.addEventListener("open", () => {
    // Anything the browser said while the upstream was still connecting. A
    // socket that dropped these would lose whatever the client sent first,
    // which is the half of the conversation hardest to notice missing.
    for (const frame of state.pending) up.send(frame);
    state.pending.length = 0;
  });
  up.addEventListener("message", (e: MessageEvent) => {
    ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
  });
  // The browser is told, rather than left holding a socket that has quietly
  // stopped carrying anything. `ConnectionBanner` already renders a closed
  // socket; a half-open one it cannot see is worse than a closed one.
  up.addEventListener("close", () => ws.close());
  up.addEventListener("error", () => ws.close());
}

/** Forward one browser frame upstream, buffering until the upstream is open. */
export function forwardUp(state: ProxySocket, frame: string | Uint8Array): void {
  if (state.up !== null && state.up.readyState === 1) state.up.send(frame);
  else state.pending.push(frame);
}

/** Close the upstream socket when the browser's end goes away. */
export function closeUp(state: ProxySocket): void {
  state.up?.close();
  state.up = null;
  state.pending.length = 0;
}

/**
 * Is a paddock actually serving here?
 *
 * Attaching to nothing publishes a tunnel to a closed port — a public URL that
 * answers 502 for as long as it lives. Checked once, before cloudflared is
 * started, so the failure is a refusal at the terminal rather than a broken
 * link already handed out.
 */
export async function upstreamAlive(u: Upstream, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`${upstreamOrigin(u)}/api/health`, {
      headers: { origin: upstreamOrigin(u) },
    });
    return res.ok;
  } catch {
    return false;
  }
}
