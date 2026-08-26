import { chmod, rm } from "node:fs/promises";
import type { LiveCode } from "@server/tunnel/pairing";

/**
 * What a running tunnel will tell a local caller about itself.
 *
 * The code is here and NOT in the state file, because `Pairing.current()`
 * mints lazily: only the process holding the `Pairing` can advance the code,
 * so a file could offer nothing but a possibly-expired snapshot. Asking mints
 * on demand, which is strictly better than the foreground display's behaviour
 * rather than merely equal to it — the code an operator is handed always has
 * its full TTL ahead of it.
 */
export interface CodeAnswer {
  code: string;
  expiresAt: number;
  url: string;
}

export type Ask =
  | { ok: true; answer: CodeAnswer }
  | { ok: false; detail: string };

/** The one path. See the note on `serveControl`. */
const CODE_PATH = "/code";

/**
 * Serve one tunnel's control socket.
 *
 * A UNIX SOCKET, NOT A LOOPBACK PORT, and that is a control rather than a
 * preference. `cloudflared` runs on this same box and reaches the gated
 * listener over loopback, so a request that came from the public internet and
 * one that came from a local shell arrive with the SAME peer address — and
 * `gate.ts` documents at length that the `x-forwarded-*` headers cannot settle
 * it either, being client-influencable. A "localhost-only" HTTP route beside
 * the gate would therefore be a promise, and the thing it would leak is the
 * pairing code. A socket has no exposure path to close: no port, nothing for
 * `cloudflared` to be pointed at by mistake, and access is filesystem
 * permissions in a directory that is already 0700.
 *
 * ONE ROUTE. Everything else is 404 — see the test. This is not an internal
 * API to grow; it is the answer to one question.
 */
export function serveControl(opts: {
  socket: string;
  url: () => string;
  current: () => LiveCode;
}): { stop: () => void } {
  const srv = Bun.serve({
    unix: opts.socket,
    fetch: (req) => {
      if (new URL(req.url).pathname !== CODE_PATH) {
        return new Response("not found", { status: 404 });
      }
      // Read through `current()` on every request, never cached: caching would
      // reintroduce exactly the stale snapshot this channel exists to avoid.
      const live = opts.current();
      const body: CodeAnswer = {
        code: live.code,
        expiresAt: live.expiresAt,
        url: opts.url(),
      };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  });

  // The socket inherits the directory's 0700, but say it rather than rely on
  // it: this path hands out a live pairing code to anyone who can open it.
  // Failure is reported, not swallowed — a socket left group-readable is
  // something the operator needs told, even though the 0700 parent already
  // makes it unreachable in practice.
  void chmod(opts.socket, 0o600).catch((e: unknown) => {
    console.warn(`paddock: could not tighten ${opts.socket} (${String(e)})`);
  });

  return {
    stop: () => {
      srv.stop(true);
      // Bun does not unlink the socket on stop, and a path left behind is one
      // that accepts a connect and never answers — `removeTunnelState` clears
      // it too, for the case where this process died without reaching here.
      void rm(opts.socket, { force: true });
    },
  };
}

/**
 * Ask a tunnel for its current code.
 *
 * A failure is a REASON, never an absence. `pair` distinguishes "no tunnel is
 * running" from "a tunnel is recorded but is not answering", and collapsing
 * the second into the first would send an operator to start a tunnel that is
 * already up.
 */
export async function askControl(
  socket: string,
  f: typeof fetch = fetch,
): Promise<Ask> {
  let res: Response;
  try {
    res = await f(`http://localhost${CODE_PATH}`, { unix: socket } as RequestInit);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, detail: `control socket answered HTTP ${res.status}` };

  try {
    const body = (await res.json()) as CodeAnswer;
    if (typeof body.code !== "string" || typeof body.url !== "string" ||
        typeof body.expiresAt !== "number") {
      return { ok: false, detail: "control socket answered an unusable shape" };
    }
    return { ok: true, answer: body };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
