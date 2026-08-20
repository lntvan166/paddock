import { expect, test } from "bun:test";
import {
  allowUpgrade,
  allowWrite,
  isLoopbackHost,
  publicHostsFrom,
  refusalReason,
} from "@server/origin";

/**
 * The gate these predicates implement is decision 12's missing half.
 *
 * That decision restored the CORS preflight requirement for the three settings
 * routes and said plainly what it did not cover: "the pre-existing action
 * routes are POST already and carry larger levers, so this is not new in kind.
 * It is a floor, not a fix." `POST /api/agents/:id/text` types arbitrary text
 * into a coding agent and reads a body with `jsonBody`, which never looks at
 * the content type — so it was reachable from an `enctype="text/plain"` form on
 * any page the operator visited, and `/ws` handed that same page every agent's
 * screen because a WebSocket handshake is exempt from CORS entirely.
 *
 * These tests pin the rule, not the plumbing. The two predicates differ in
 * exactly one place — a missing `Origin` — and that difference is load-bearing
 * enough to be asserted from both sides.
 */

const LOOPBACK = "127.0.0.1:8787";

test("a write with no Origin is allowed — a non-browser client is not a CSRF vector", () => {
  // curl, a script, `paddock doctor`: none of them carry an attacker's page.
  // The threat is a browser acting on a hostile page's behalf, and browsers
  // ALWAYS send Origin on a POST. Refusing here would buy nothing and break
  // every command-line use of the API.
  expect(allowWrite(null, LOOPBACK, [])).toBe(true);
});

test("a same-origin write is allowed", () => {
  expect(allowWrite("http://127.0.0.1:8787", LOOPBACK, [])).toBe(true);
});

test("a cross-origin write is refused", () => {
  // The drive-by: any page the operator visits POSTing into a live agent.
  expect(allowWrite("https://evil.example", LOOPBACK, [])).toBe(false);
});

test("an opaque Origin is refused", () => {
  // A sandboxed iframe or a `data:` document sends the literal string "null".
  // It parses as a URL nowhere, and it is nobody's first-party request.
  expect(allowWrite("null", LOOPBACK, [])).toBe(false);
});

test("an unparseable Origin is refused", () => {
  expect(allowWrite("not a url", LOOPBACK, [])).toBe(false);
});

test("a port mismatch is cross-origin", () => {
  // Same host, different port is a different origin to a browser, and must be
  // one here: another service on the operator's own machine is exactly the
  // attacker the loopback listener is exposed to.
  expect(allowWrite("http://127.0.0.1:9999", LOOPBACK, [])).toBe(false);
});

test("Host is compared case-insensitively", () => {
  // Hostnames are case-insensitive and a proxy may not preserve case; a 403
  // over letter case would be an unexplainable outage.
  expect(allowWrite("https://paddock.example.com", "Paddock.Example.COM", [])).toBe(true);
});

test("a rebinding request is refused once a public host is known", () => {
  // DNS rebinding is the one attack a bare same-origin check cannot see: the
  // browser is tricked into resolving evil.example to 127.0.0.1, so Host and
  // Origin AGREE and the comparison passes. The allowlist is what catches it.
  expect(allowWrite("https://evil.example", "evil.example", ["paddock.example.com"])).toBe(false);
});

test("a rebinding request passes when no public host is known — the documented limit", () => {
  // Deliberate, and the reason `publicUrl` stays optional. `publicUrl` lives in
  // the Notifications section: making it load-bearing for the reply path would
  // turn a Telegram setting into the difference between a working dashboard and
  // a read-only one, for a reason no operator could guess. So an empty
  // allowlist means "we do not know this deployment's hostname", not "allow
  // nothing" — CSRF is still closed, rebinding is not.
  expect(allowWrite("https://evil.example", "evil.example", [])).toBe(true);
});

test("loopback is allowed even when it is not on a populated allowlist", () => {
  // Desk browsing and `make dev` must not start failing the moment an operator
  // sets a public URL for notification deep links.
  expect(allowWrite("http://127.0.0.1:8787", LOOPBACK, ["paddock.example.com"])).toBe(true);
});

test("a known public host is allowed", () => {
  expect(
    allowWrite("https://paddock.example.com", "paddock.example.com", ["paddock.example.com"]),
  ).toBe(true);
});

test("a host outside a populated allowlist is refused even when Origin agrees", () => {
  expect(allowWrite("https://other.example", "other.example", ["paddock.example.com"])).toBe(false);
});

test("an upgrade with no Origin is REFUSED, unlike a write", () => {
  // The one place the two predicates disagree. Browsers always send Origin on
  // a WebSocket handshake — same-origin included, unlike a GET — so requiring
  // it costs a browser nothing and shuts out `websocat`. That matters because
  // herdr's socket is a FILE, whose permissions keep other local users out,
  // while paddock's port is TCP and every uid on the host can reach it. `/ws`
  // hands over every agent's screen on connect, so it is the read worth
  // closing.
  expect(allowUpgrade(null, LOOPBACK, [])).toBe(false);
});

test("a same-origin upgrade is allowed", () => {
  expect(allowUpgrade("http://127.0.0.1:8787", LOOPBACK, [])).toBe(true);
});

test("a cross-origin upgrade is refused", () => {
  expect(allowUpgrade("https://evil.example", LOOPBACK, [])).toBe(false);
});

test("an upgrade obeys the same allowlist as a write", () => {
  expect(allowUpgrade("https://evil.example", "evil.example", ["paddock.example.com"])).toBe(false);
});

test("isLoopbackHost accepts the three loopback spellings, with or without a port", () => {
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("127.0.0.1:8787")).toBe(true);
  expect(isLoopbackHost("localhost")).toBe(true);
  expect(isLoopbackHost("localhost:5173")).toBe(true);
  expect(isLoopbackHost("[::1]:8787")).toBe(true);
});

test("isLoopbackHost is not fooled by a hostname that merely starts with one", () => {
  // `127.0.0.1.evil.com` resolves wherever its owner points it.
  expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
  expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  expect(isLoopbackHost("notlocalhost")).toBe(false);
});

test("publicHostsFrom returns nothing when no public hostname is known", () => {
  // Empty is INACTIVE, not empty-so-deny. See the rebinding test above.
  expect(publicHostsFrom(null, null)).toEqual([]);
  expect(publicHostsFrom("", null)).toEqual([]);
});

test("publicHostsFrom takes the host of a configured publicUrl, port included", () => {
  expect(publicHostsFrom("https://paddock.example.com", null)).toEqual(["paddock.example.com"]);
  expect(publicHostsFrom("https://paddock.example.com:8443/", null)).toEqual([
    "paddock.example.com:8443",
  ]);
});

test("publicHostsFrom includes a live tunnel URL", () => {
  // A `paddock tunnel` run's hostname is different on every run and is never
  // written to settings.json, so it can only come from the live value.
  expect(publicHostsFrom(null, "https://apple-berry-cat-dog.trycloudflare.com")).toEqual([
    "apple-berry-cat-dog.trycloudflare.com",
  ]);
});

test("publicHostsFrom holds both a saved deployment and a live tunnel at once", () => {
  // `paddock tunnel` run against a host that also has a named-tunnel publicUrl
  // saved: both hostnames are legitimate for the life of that run.
  expect(
    publicHostsFrom("https://paddock.example.com", "https://apple-berry.trycloudflare.com"),
  ).toEqual(["paddock.example.com", "apple-berry.trycloudflare.com"]);
});

test("publicHostsFrom ignores a value that is not a URL", () => {
  // `publicUrl` is a free-text settings field. A typo must not silently
  // populate the allowlist with garbage and lock the operator out — an
  // unparseable value is no knowledge at all, which is the inactive case.
  expect(publicHostsFrom("paddock.example.com", null)).toEqual([]);
  expect(publicHostsFrom("¯\\_(ツ)_/¯", null)).toEqual([]);
});

test("publicHostsFrom lowercases what it stores, so the allowlist matches Host", () => {
  expect(publicHostsFrom("https://Paddock.Example.COM", null)).toEqual(["paddock.example.com"]);
});

/**
 * The refusal has TWO causes that need different fixes, and telling an operator
 * the wrong one costs them the afternoon. A mismatched `Origin`/`Host` means a
 * proxy is rewriting `Host`; a matched pair refused anyway means `publicUrl`
 * names a hostname this deployment is not actually reached on. The message that
 * blames a proxy for the second is worse than no message.
 */
test("refusalReason distinguishes a rewriting proxy from a wrong publicUrl", () => {
  // Origin and Host agree, and the allowlist is what refused: publicUrl's fault.
  expect(refusalReason("https://paddock.example.com", "paddock.example.com", ["stale.example"]))
    .toBe("host-not-allowed");
  // Origin and Host disagree: a hostile page, or a proxy that rewrote Host.
  expect(refusalReason("https://evil.example", "paddock.example.com", [])).toBe("cross-origin");
  expect(refusalReason(null, "paddock.example.com", [])).toBe("no-origin");
});
