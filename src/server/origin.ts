/**
 * The same-origin gate: two predicates and the allowlist they consult.
 *
 * WHY THIS EXISTS. `docs/decisions.md` decision 12 required
 * `content-type: application/json` on the three settings writes, restoring the
 * CORS preflight that is paddock's only CSRF control — and said plainly what it
 * did not cover: "the pre-existing action routes are POST already and carry
 * larger levers, so this is not new in kind. It is a floor, not a fix."
 *
 * This is the fix. Two holes were open. `POST /api/agents/:id/text` types
 * arbitrary text into a live coding agent and reads its body with `jsonBody`,
 * which never inspects the content type, so it was a CORS-SIMPLE request: an
 * `enctype="text/plain"` form on any page the operator visited could post
 * syntactically valid JSON to it with no preflight and no same-origin check.
 * And `/ws` upgraded unconditionally — a WebSocket handshake is exempt from
 * CORS entirely — while `hubWebSocket.open` sends the full snapshot on connect,
 * so the same hostile page could read every agent's name, id and screen and
 * then use those ids against the write route.
 *
 * WHY IT IS NOT AN AUTH TOKEN. Decision 3 stands: an application token would
 * gate `/sw.js` and silently kill the service worker. Nothing here authenticates
 * anybody. It asks one question a browser cannot lie about — which page is this
 * request acting for — and refuses when the answer is "not paddock's own".
 *
 * PURE ON PURPOSE. No imports, no clock, no settings, no transport. Both
 * enforcement points (`routes.ts`'s middleware and `ws/serve.ts`'s upgrade) call
 * these, and `tests/origin.test.ts` calls them directly without booting
 * `Bun.serve` — the shape `docs/roadmap.md` asks for where composition is
 * otherwise untestable.
 */

/** The three spellings of loopback, as a `Host` header carries them. */
const LOOPBACK_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "::1"];

/**
 * The hostname of a `Host` header value, port stripped, lowercased — or null if
 * it does not parse.
 *
 * Parsed with `URL` rather than split on `:`, because `[::1]:8787` has two of
 * those and a hand-rolled split gets it wrong. The `http://` prefix is a parsing
 * scaffold and says nothing about the real scheme.
 */
function hostnameOf(host: string): string | null {
  try {
    const h = new URL(`http://${host}`).hostname;
    return h === "" ? null : h.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The host this request was addressed to.
 *
 * The `Host` HEADER first, because that is what a browser sent and what a proxy
 * may have rewritten — the value the check is actually about. The URL's host is
 * the fallback, and in production the two are the same value: Bun builds
 * `req.url` FROM the `Host` header, so neither can disagree with the other on a
 * real request. The fallback exists because a `Request` constructed in a test
 * carries no `Host` header at all — the header is added by the transport — and a
 * predicate that only worked over a live socket could not be tested at the one
 * layer worth testing it at.
 */
export function hostOf(req: Request): string {
  const header = req.headers.get("host");
  if (header !== null && header !== "") return header;
  try {
    return new URL(req.url).host;
  } catch {
    return "";
  }
}

/**
 * Whether a `Host` header names this machine.
 *
 * Matched on the parsed hostname, never on a prefix: `127.0.0.1.evil.com` and
 * `localhost.evil.com` are ordinary registrable names that resolve wherever
 * their owner points them, and a `startsWith` check would hand both of them the
 * allowlist bypass below.
 */
export function isLoopbackHost(host: string): boolean {
  const name = hostnameOf(host);
  return name !== null && LOOPBACK_HOSTNAMES.includes(name);
}

/** The `host` of an origin string (`https://h:port` -> `h:port`), or null. */
function hostOfOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Includes the literal "null" a sandboxed iframe or a `data:` document
    // sends — no scheme, so it parses as a URL nowhere.
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.host === "" ? null : url.host.toLowerCase();
}

/**
 * The hostnames this deployment is legitimately reached on, or **empty when
 * none is known**.
 *
 * Empty means INACTIVE, not "deny everything", and that distinction is the
 * whole reason `publicUrl` can stay optional. It lives in the Notifications
 * section — `docs/settings.md` calls it "what turns a bare 'docs-cleanup is
 * blocked' into a tap-through link" — so an operator on a named tunnel who does
 * not use Telegram has never had a reason to set it. Enforcing an allowlist
 * built from it unconditionally would make a notification setting the
 * difference between a working dashboard and a read-only one, for a reason no
 * operator could guess. That is the failure mode `CLAUDE.md` bans, so:
 * knowing a public hostname buys DNS-rebinding protection on top of the
 * same-origin check; not knowing one costs nothing that was already working.
 *
 * A live tunnel URL is included as well as the saved one. A `paddock tunnel`
 * run's hostname differs on every run and is deliberately never written to
 * `settings.json` (see `docs/settings.md`), so the live value is the only place
 * it exists.
 */
export function publicHostsFrom(
  publicUrl: string | null,
  tunnelUrl: string | null,
): readonly string[] {
  const hosts: string[] = [];
  for (const candidate of [publicUrl, tunnelUrl]) {
    if (candidate === null || candidate.trim() === "") continue;
    // An unparseable value is no knowledge at all, not a lockout: `publicUrl`
    // is a free-text field, and a typo in it must never populate the allowlist
    // with garbage that then refuses every write.
    const host = hostOfOrigin(candidate.trim());
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Whether the request's `Host` is one this deployment answers on.
 *
 * Checked BEFORE the origin comparison and fail-closed, because it is the only
 * one of the two that can see a rebinding attack: a browser tricked into
 * resolving `evil.example` to `127.0.0.1` sends `Host` and `Origin` that AGREE,
 * so the comparison below passes on its own.
 */
function hostAllowed(host: string, publicHosts: readonly string[]): boolean {
  if (publicHosts.length === 0) return true; // inactive — see publicHostsFrom
  if (isLoopbackHost(host)) return true; // the desk, and `make dev`
  return publicHosts.includes(host.toLowerCase());
}

function sameOrigin(origin: string, host: string, publicHosts: readonly string[]): boolean {
  if (!hostAllowed(host, publicHosts)) return false;
  const from = hostOfOrigin(origin);
  return from !== null && from === host.toLowerCase();
}

/**
 * Why a request was refused — because the two causes need OPPOSITE fixes, and
 * naming the wrong one sends an operator to the wrong file.
 *
 * `cross-origin`: `Origin` and `Host` disagree. Either a hostile page, or a
 * proxy in front rewriting `Host` (cloudflared's `httpHostHeader`, nginx's
 * `proxy_set_header Host`). The fix is in the proxy.
 *
 * `host-not-allowed`: they AGREE and the allowlist refused anyway, so this
 * deployment is being reached on a hostname `publicUrl` does not name. The fix
 * is in settings — and telling this operator to look at their proxy would be
 * actively misleading, since their proxy is behaving correctly.
 */
export type RefusalReason = "no-origin" | "cross-origin" | "host-not-allowed";

export function refusalReason(
  origin: string | null,
  host: string,
  publicHosts: readonly string[],
): RefusalReason {
  if (origin === null) return "no-origin";
  if (!hostAllowed(host, publicHosts)) return "host-not-allowed";
  return "cross-origin";
}

/**
 * Whether a state-changing request may proceed.
 *
 * A MISSING `Origin` is allowed, and that is not an oversight. Browsers always
 * send it on a POST, so its absence means the caller is not a browser — curl, a
 * script, a health check — and a non-browser caller carries no hostile page on
 * whose behalf it could be acting. Refusing here would buy nothing and break
 * every command-line use of the API.
 */
export function allowWrite(
  origin: string | null,
  host: string,
  publicHosts: readonly string[],
): boolean {
  if (origin === null) return true;
  return sameOrigin(origin, host, publicHosts);
}

/**
 * Whether a `/ws` upgrade may proceed.
 *
 * Identical to `allowWrite` except that a missing `Origin` is REFUSED, which is
 * the one asymmetry worth stating twice. Browsers send `Origin` on every
 * WebSocket handshake, same-origin included — unlike a GET, where they omit it —
 * so requiring it costs a browser nothing and shuts out a non-browser reader.
 * That is worth having: herdr's control socket is a FILE, so its permissions
 * keep other local users out, while paddock's port is TCP and every uid on the
 * host can reach it. `/ws` sends the whole snapshot on connect, so it is the
 * read worth closing.
 */
export function allowUpgrade(
  origin: string | null,
  host: string,
  publicHosts: readonly string[],
): boolean {
  if (origin === null) return false;
  return sameOrigin(origin, host, publicHosts);
}
