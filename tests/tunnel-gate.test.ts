import { expect, test } from "bun:test";
import { COOKIE_NAME, SESSION_MAX_AGE_S } from "@server/tunnel/pairing";
import {
  clearCookie, decide, gateResponse, pairingPage, setCookie, tokenFromCookie,
} from "@server/tunnel/gate";

const GOOD = "known-token";
const has = (t: string) => t === GOOD;

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://quiet-harbor-8f31.trycloudflare.com${path}`, init);

const withCookie = (path: string, token: string, init: RequestInit = {}) =>
  req(path, { ...init, headers: { ...(init.headers ?? {}), cookie: `${COOKIE_NAME}=${token}` } });

const html = { accept: "text/html,application/xhtml+xml" };

test("a known session passes on every kind of request", () => {
  expect(decide(withCookie("/", GOOD, { headers: html }), has).kind).toBe("pass");
  expect(decide(withCookie("/api/agents", GOOD), has).kind).toBe("pass");
  expect(decide(withCookie("/ws", GOOD, { headers: { upgrade: "websocket" } }), has).kind).toBe("pass");
});

test("a navigation with no cookie gets the pairing page, not a 401", () => {
  expect(decide(req("/", { headers: html }), has)).toEqual({ kind: "page", stale: false });
  // Any path, because the phone may hold a deeplink to one agent.
  expect(decide(req("/a1b2c3", { headers: html }), has)).toEqual({ kind: "page", stale: false });
});

test("api, assets and the upgrade are denied rather than shown a page", () => {
  expect(decide(req("/api/agents"), has)).toEqual({ kind: "deny", stale: false });
  expect(decide(req("/assets/index-BRl8nQbG.js"), has)).toEqual({ kind: "deny", stale: false });
  expect(decide(req("/ws", { headers: { upgrade: "websocket" } }), has))
    .toEqual({ kind: "deny", stale: false });
});

test("an upgrade is denied even when it asks for html", () => {
  // A browser sends Accept: text/html on an upgrade too, so an Accept-first
  // order would answer the WebSocket with a login page.
  expect(decide(req("/ws", { headers: { ...html, upgrade: "websocket" } }), has))
    .toEqual({ kind: "deny", stale: false });
});

test("POST /pair is always reachable — it is the way in", () => {
  expect(decide(req("/pair", { method: "POST" }), has).kind).toBe("pass");
});

test("a cookie the server never issued is treated as no cookie, and cleared", () => {
  // The stranding bug: if this 401s a navigation, the device has no route to
  // the form that would fix it for thirty days.
  expect(decide(withCookie("/", "forged", { headers: html }), has))
    .toEqual({ kind: "page", stale: true });
  expect(decide(withCookie("/api/agents", "forged"), has))
    .toEqual({ kind: "deny", stale: true });
});

test("tokenFromCookie finds the token among others, and tolerates absence", () => {
  expect(tokenFromCookie(`theme=dark; ${COOKIE_NAME}=abc; other=1`)).toBe("abc");
  expect(tokenFromCookie(null)).toBe(null);
  expect(tokenFromCookie("theme=dark")).toBe(null);
  expect(tokenFromCookie(`${COOKIE_NAME}=`)).toBe(null);
});

test("the session cookie is host-only, HttpOnly, Secure, Lax and persistent", () => {
  const c = setCookie("tok");
  expect(c).toContain(`${COOKIE_NAME}=tok`);
  expect(c).toContain("HttpOnly");
  expect(c).toContain("Secure");
  expect(c).toContain("SameSite=Lax");
  expect(c).toContain("Path=/");
  expect(c).toContain(`Max-Age=${SESSION_MAX_AGE_S}`);
  // trycloudflare.com is a suffix shared with every other quick tunnel. A
  // Domain attribute would hand this session to strangers' tunnels.
  expect(c.toLowerCase()).not.toContain("domain");
});

test("clearing the cookie expires it in place", () => {
  expect(clearCookie()).toContain("Max-Age=0");
  expect(clearCookie()).toContain(`${COOKIE_NAME}=`);
  expect(clearCookie().toLowerCase()).not.toContain("domain");
});

test("the pairing page depends on no asset", () => {
  const page = pairingPage({ insecure: false });
  expect(page).not.toMatch(/<script[^>]+src=/);
  expect(page).not.toMatch(/<link[^>]+href=/);
  expect(page).not.toMatch(/<img/);
  expect(page).toContain("<form");
});

test("the page explains a plaintext origin rather than silently failing", () => {
  // Secure cookies are refused over http, so pairing on 127.0.0.1:8788
  // directly can never work. Saying so beats looking broken.
  expect(pairingPage({ insecure: true })).toContain("only works over");
  expect(pairingPage({ insecure: false })).not.toContain("only works over");
});

test("gateResponse trusts x-forwarded-proto over the hop's own scheme", async () => {
  // cloudflared always speaks plain http to this listener, even when the
  // browser is on the https tunnel URL. Reading the request URL's own
  // protocol would warn every real tunnel visitor — the people already
  // doing it right.
  const forwardedHttps = new Request("http://127.0.0.1:8788/", {
    headers: { ...html, "x-forwarded-proto": "https" },
  });
  const page = await gateResponse({ kind: "page", stale: false }, forwardedHttps).text();
  expect(page).not.toContain("only works over");
});

test("gateResponse warns when there is no forwarded header and the hop itself is http", async () => {
  // The direct 127.0.0.1:8788 case, with no reverse proxy in front to have
  // set the header at all — the warning is correct here.
  const direct = new Request("http://127.0.0.1:8788/", { headers: html });
  const page = await gateResponse({ kind: "page", stale: false }, direct).text();
  expect(page).toContain("only works over");
});

test("gateResponse reads a list-valued x-forwarded-proto as its first entry", async () => {
  const listed = new Request("http://127.0.0.1:8788/", {
    headers: { ...html, "x-forwarded-proto": "https,http" },
  });
  const page = await gateResponse({ kind: "page", stale: false }, listed).text();
  expect(page).not.toContain("only works over");
});

/*
 * The three tests below asserted these properties through `gateMiddleware`,
 * which had no production call site and has been deleted — the gate lives on
 * the socket (`serveGated`), which cannot go through Hono middleware because it
 * answers a WebSocket upgrade before the app is reached. They now assert
 * `gateResponse` itself, which is the function that socket actually calls, and
 * `tests/tunnel-gate-scope.test.ts` plus `tests/tunnel-run.test.ts` cover the
 * wiring end to end over a real listener.
 */

test("a deny is a 401 of json; a page is a 200 carrying the form", async () => {
  const denied = gateResponse({ kind: "deny", stale: false }, req("/api/agents"));
  expect(denied.status).toBe(401);
  expect(denied.headers.get("content-type")).toContain("application/json");
  expect(await denied.json()).toEqual({ ok: false, detail: "not paired" });

  const page = gateResponse({ kind: "page", stale: false }, req("/", { headers: html }));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("<form");
});

test("a stale cookie is cleared by every refusal, and only by those", () => {
  // Both refusal shapes, because a device stranded behind its own dead cookie
  // is stranded whichever one it happens to ask for.
  expect(gateResponse({ kind: "page", stale: true }, req("/", { headers: html }))
    .headers.get("set-cookie")).toContain("Max-Age=0");
  expect(gateResponse({ kind: "deny", stale: true }, req("/api/agents"))
    .headers.get("set-cookie")).toContain("Max-Age=0");
  // No cookie was presented, so there is nothing to clear — and clearing one
  // here would log out a device that is merely unpaired on this request.
  expect(gateResponse({ kind: "page", stale: false }, req("/", { headers: html }))
    .headers.get("set-cookie")).toBeNull();
});

test("no refusal is ever cached", () => {
  // A cached pairing page is a device shown a form for a code that has since
  // rotated; a cached 401 outlives the session that would have fixed it.
  expect(gateResponse({ kind: "page", stale: false }, req("/", { headers: html }))
    .headers.get("cache-control")).toContain("no-store");
  expect(gateResponse({ kind: "deny", stale: false }, req("/api/agents"))
    .headers.get("cache-control")).toContain("no-store");
});

test("a pass decision is a programming error, not a quiet 401", () => {
  expect(() => gateResponse({ kind: "pass" }, req("/"))).toThrow(/no refusal/);
});
