import type { MiddlewareHandler } from "hono";
import { COOKIE_NAME, SESSION_MAX_AGE_S } from "@server/tunnel/pairing";

export type Decision =
  | { kind: "pass" }
  /** Serve the pairing form. `stale` means a dead cookie must be cleared. */
  | { kind: "page"; stale: boolean }
  | { kind: "deny"; stale: boolean };

export function tokenFromCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const value = rest.join("=");
      return value === "" ? null : value;
    }
  }
  return null;
}

/**
 * NO `Domain` ATTRIBUTE, EVER.
 *
 * `trycloudflare.com` is a suffix shared with every other quick tunnel in the
 * world. A cookie scoped to `.trycloudflare.com` would be attached to
 * strangers' tunnels — a session handed to whoever happens to be running one.
 * Omitting `Domain` makes the cookie host-only, which is the whole control.
 *
 * `Max-Age` is equally load-bearing. Without it this is a session cookie that
 * dies when the browser restarts, and a tunnel up for days would log the phone
 * out at the moment its owner is furthest from the terminal holding the code.
 */
export function setCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * The ONE rule, called from two places: `gateMiddleware` for ordinary
 * requests, and the gated listener's own `fetch` before it upgrades a
 * WebSocket — because `index.ts` intercepts `/ws` and calls `server.upgrade`
 * BEFORE `app.fetch` is reached, so a middleware alone would leave the socket
 * ungated. Two call sites, one function, no way for them to disagree.
 */
export function decide(req: Request, has: (t: string) => boolean): Decision {
  const url = new URL(req.url);

  // The exchange itself must be reachable without a session, or there is no
  // way to acquire one. This is the ONLY unauthenticated route.
  if (req.method === "POST" && url.pathname === "/pair") return { kind: "pass" };

  const token = tokenFromCookie(req.headers.get("cookie"));
  if (token !== null && has(token)) return { kind: "pass" };

  // A token we never issued is NOT "authenticated but wrong" — it is the same
  // case as no token at all. Anything else 401s the pairing page itself and
  // leaves the device stranded behind a cookie good for thirty days.
  const stale = token !== null;

  // Checked before Accept: a browser sends `Accept: text/html` on an upgrade
  // too, so an Accept-first order would answer the socket with a login page.
  if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
    return { kind: "deny", stale };
  }
  if (url.pathname.startsWith("/api/")) return { kind: "deny", stale };
  if ((req.headers.get("accept") ?? "").includes("text/html")) {
    return { kind: "page", stale };
  }
  return { kind: "deny", stale };
}

/**
 * Self-contained by necessity, not by preference. Every real asset stays behind
 * the gate; carving out an unauthenticated static path would be one more thing
 * to audit, so this page references nothing it cannot inline.
 */
export function pairingPage(opts: { insecure: boolean }): string {
  const warning = opts.insecure
    ? `<p class="warn">This page only works over <code>https</code>. The session
       cookie is <code>Secure</code>, so a browser will refuse it here. Open the
       tunnel URL instead.</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>paddock — pair this device</title>
<style>
  :root { color-scheme: light dark; --fg: #14171a; --bg: #fbfbfa; --muted: #5c6672; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6e8ea; --bg: #16191c; --muted: #9aa4b0; --bad: #f2b8b5; }
  }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: var(--bg); color: var(--fg);
         font: 16px/1.5 system-ui, -apple-system, sans-serif;
         padding: 1.5rem env(safe-area-inset-right)
                  calc(1.5rem + env(safe-area-inset-bottom)) env(safe-area-inset-left); }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { color: var(--muted); margin: 0 0 1.25rem; }
  input { width: 100%; box-sizing: border-box; font: inherit;
          font-family: ui-monospace, monospace; font-size: 1.5rem;
          letter-spacing: .12em; text-align: center; text-transform: uppercase;
          padding: .75rem; border: 2px solid var(--muted); border-radius: .5rem;
          background: transparent; color: inherit; }
  button { width: 100%; box-sizing: border-box; font: inherit; margin-top: .75rem;
           min-height: 3rem; border: 0; border-radius: .5rem;
           background: var(--fg); color: var(--bg); }
  .warn, .err { color: var(--bad); }
  .err { margin: .75rem 0 0; }
</style></head>
<body><main>
  <h1>Pair this device</h1>
  <p>Enter the code shown in the terminal running <code>paddock tunnel</code>.</p>
  ${warning}
  <form method="post" action="/pair" id="f">
    <input id="c" name="code" inputmode="latin" autocapitalize="characters"
           autocomplete="one-time-code" placeholder="XXXX-XXXX"
           aria-label="Pairing code" required>
    <button type="submit">Pair</button>
  </form>
  <p class="err" id="e" role="alert" hidden></p>
</main>
<script>
  var f = document.getElementById("f"), c = document.getElementById("c"), e = document.getElementById("e");
  f.addEventListener("submit", function (ev) {
    ev.preventDefault();
    e.hidden = true;
    fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: c.value })
    }).then(function (r) {
      if (r.ok) { location.reload(); return; }
      return r.json().then(function (b) {
        e.textContent = (b && b.detail) || "That did not work.";
        e.hidden = false;
      });
    }).catch(function () {
      e.textContent = "Could not reach paddock.";
      e.hidden = false;
    });
  });
</script>
</body></html>`;
}

/**
 * The byte-identical refusal response for a non-`pass` decision, factored out
 * so it exists in exactly one place. `gateMiddleware` below calls this from a
 * Hono `Context`, and the gated listener's own `Bun.serve` `fetch` handler
 * (which sees a WebSocket upgrade before `app.fetch` is ever reached, and so
 * cannot go through Hono middleware at all) calls it from a bare `Request`.
 * Transcribing this block at both call sites is exactly how they would end up
 * disagreeing — the entire reason `decide` returns a `Decision` instead of a
 * `Response` is so there is one place, not two, that turns a refusal into
 * bytes on the wire.
 *
 * Takes the full `Request`, not just its URL, because telling the pairing
 * page's plaintext warning apart from a real tunnel visit needs a header, not
 * only the URL's own scheme — see `clientIsSecure` below.
 *
 * A `pass` decision has no refusal to render — passing one here is a
 * programming error at the call site, not a reachable runtime state, so it
 * throws rather than quietly answering 401.
 */
export function gateResponse(d: Decision, req: Request): Response {
  if (d.kind === "pass") {
    throw new Error("gateResponse: a pass decision has no refusal to render");
  }

  const headers = new Headers({ "cache-control": "no-store" });
  if (d.stale) headers.append("set-cookie", clearCookie());

  if (d.kind === "page") {
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(pairingPage({ insecure: !clientIsSecure(req) }), {
      status: 200,
      headers,
    });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ ok: false, detail: "not paired" }), {
    status: 401,
    headers,
  });
}

/**
 * Whether the ORIGINAL client — the browser — spoke https, not whether this
 * hop did. Behind `paddock tunnel`, `cloudflared` always speaks plain http to
 * this listener even when the browser is on the https tunnel URL, so reading
 * the request URL's own protocol reports every real visitor as insecure and
 * shows the plaintext warning to precisely the people who are already doing
 * it right. `cloudflared` sets `x-forwarded-proto: https` for exactly this
 * reason, so it is read first; the request URL's protocol is the fallback,
 * which is correct for the direct `http://127.0.0.1:8788` case the warning
 * exists to catch.
 *
 * `x-forwarded-proto` is CLIENT-INFLUENCABLE — anything able to reach the
 * gated listener can set it to whatever it likes. It must gate NOTHING but
 * this cosmetic warning. Never let it become an input to an authentication or
 * authorisation decision; `decide()` does not read it and must not start.
 */
function clientIsSecure(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded !== null) {
    return (forwarded.split(",")[0] ?? "").trim().toLowerCase() === "https";
  }
  return new URL(req.url).protocol === "https:";
}

export function gateMiddleware(pairing: { has(t: string): boolean }): MiddlewareHandler {
  return async (c, next) => {
    const d = decide(c.req.raw, (t) => pairing.has(t));
    if (d.kind === "pass") return next();
    return gateResponse(d, c.req.raw);
  };
}
