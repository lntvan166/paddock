# `paddock tunnel` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator publish the dashboard to their phone with one
command, without owning a domain, and without publishing an unauthenticated
dashboard while doing it.

**Architecture:** `paddock tunnel` is a mode of serving. One process binds the
existing `127.0.0.1:8787` unchanged, binds a second loopback listener wrapped in
a pairing gate, and runs `cloudflared --url` against the second one. The gate is
a pure decision function called from both the Hono middleware and the gated
listener's `fetch`, because the WebSocket upgrade never reaches the Hono app.
Sessions and codes live in memory only.

**Tech Stack:** Bun (`Bun.serve`, `Bun.spawn`), Hono, `node:crypto`
(`timingSafeEqual`, `randomBytes`), `cloudflared` as an external binary.

**Spec:** `docs/design/2026-08-20-quick-tunnel-design.md`

## Global Constraints

- **This repository is PUBLIC.** No real hostnames, home paths, usernames or
  machine names in any file, comment, test or commit message. **Quick-tunnel
  hostnames found on the internet may be live** — every fixture uses the
  invented `quiet-harbor-8f31.trycloudflare.com`.
- **The gate and the tunnel ship together.** No task may leave a state where
  the gated listener serves anything before a session exists. A quick tunnel
  cannot take a Cloudflare Access policy, so this gate is the only one there is.
- **`127.0.0.1:8787` is never gated.** The plain listener keeps behaving exactly
  as it does today. `tests/tunnel-gate-scope.test.ts` (Task 8) is the guard.
- **An unrecognised cookie is treated as no cookie**, and cleared with
  `Max-Age=0`. Treating it as "authenticated but wrong" `401`s the pairing page
  itself and strands the device for 30 days.
- **The session cookie is `HttpOnly; Secure; SameSite=Lax; Path=/;
  Max-Age=2592000` and NEVER carries a `Domain` attribute.** `trycloudflare.com`
  is a suffix shared with every other quick tunnel in the world.
- **Never swallow errors.** No empty catch blocks, no `2>/dev/null`, no
  unconditional `exit 0`. `cloudflared`'s output is forwarded, and its
  unexpected exit ends paddock non-zero.
- **The public URL is read from `cloudflared`'s output, never constructed.** A
  failed parse is a loud failure.
- **`publicUrl` is set in memory only** and never written to `settings.json` —
  that field may hold a real named-tunnel hostname.
- **No test may reach the network, spawn `cloudflared`, or write outside a temp
  directory.** Every spawn, clock, byte source and `which` lookup is injected.
- Run `make check && make check-clean && make test` before every commit.
- **Prove each test can fail** by breaking the code it guards.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/tunnel/pairing.ts` (new) | Codes: alphabet, minting, TTL, the burn counter, timing-safe compare. Sessions: the in-memory token set. |
| `src/server/tunnel/gate.ts` (new) | The one `decide()` rule, cookie headers, and the dependency-free pairing page |
| `src/server/tunnel/cloudflared.ts` (new) | Locating the binary, the install hint, spawning it, extracting the URL, child lifecycle |
| `src/server/tunnel/preflight.ts` (new) | The three refusals, each with its message, plus the discoverability hint |
| `src/server/tunnel/display.ts` (new) | Pure render of the terminal block; colour and TTY decisions |
| `src/server/tunnel/run.ts` (new) | Wiring: both listeners, the child, the display loop, shutdown |
| `src/server/cli.ts` (mod) | The `tunnel` verb, `--for`, flag values, `USAGE` |
| `src/server/routes.ts` (mod) | `POST /pair`, `POST /api/pair/invite`, `tunnel` in the settings view |
| `src/server/index.ts` (mod) | Dispatch to `run.ts`; the discoverability hint |
| `src/server/doctor.ts` (mod) | One line reporting whether `cloudflared` is present |
| `src/shared/quick-tunnel.ts` (new) | The ONE quick-tunnel hostname regex, and `isQuickTunnelUrl` — used by the server's hint and the UI's warning alike |
| `src/shared/types.ts` (mod) | `SettingsView["tunnel"]` |
| `src/web/components/settings/TunnelSection.tsx` (new) | Paired count and "add a device" |

---

### Task 1: Pairing codes and the session set

**Files:**
- Create: `src/server/tunnel/pairing.ts`
- Test: `tests/tunnel-pairing-codes.test.ts`

**Interfaces:**
- Produces:
  `ALPHABET: string`; `CODE_LEN: 8`; `CODE_TTL_MS: 600_000`; `MAX_ATTEMPTS: 5`;
  `SESSION_MAX_AGE_S: 2_592_000`; `COOKIE_NAME: "paddock_pair"`;
  `formatCode(raw: string): string`; `normalise(input: string): string`;
  `interface LiveCode { code: string; expiresAt: number }`;
  `type Attempt = { kind: "paired"; token: string } | { kind: "wrong"; remaining: number } | { kind: "burned" }`;
  `class Pairing` with
  `constructor(opts?: { now?: () => number; bytes?: (n: number) => Uint8Array })`,
  `current(): LiveCode`, `reissue(): LiveCode`, `attempt(input: string): Attempt`,
  `has(token: string): boolean`, `get pairedCount(): number`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-pairing-codes.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  ALPHABET, CODE_LEN, CODE_TTL_MS, MAX_ATTEMPTS,
  formatCode, normalise, Pairing,
} from "@server/tunnel/pairing";

/** Deterministic byte source: 0,1,2,... so the code is predictable. */
function counter(): (n: number) => Uint8Array {
  let i = 0;
  return (n) => Uint8Array.from({ length: n }, () => i++ % 256);
}

test("the alphabet excludes the four ambiguous letters", () => {
  for (const ch of "ILOU") expect(ALPHABET).not.toContain(ch);
  // Crockford base32 is 32 symbols; a shorter one silently loses entropy.
  expect(ALPHABET.length).toBe(32);
  expect(new Set(ALPHABET).size).toBe(32);
});

test("a code is CODE_LEN symbols from the alphabet, shown with a dash", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  expect(code).toHaveLength(CODE_LEN);
  for (const ch of code) expect(ALPHABET).toContain(ch);
  expect(formatCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
});

test("current() is stable until the TTL elapses, then re-mints", () => {
  let t = 0;
  const p = new Pairing({ now: () => t, bytes: counter() });
  const first = p.current().code;
  t += CODE_TTL_MS - 1;
  expect(p.current().code).toBe(first);
  t += 2;
  expect(p.current().code).not.toBe(first);
});

test("a code is always live — expiry never leaves us without one", () => {
  let t = 0;
  const p = new Pairing({ now: () => t, bytes: counter() });
  p.current();
  t += CODE_TTL_MS * 5;
  const { code, expiresAt } = p.current();
  expect(code).toHaveLength(CODE_LEN);
  expect(expiresAt).toBe(t + CODE_TTL_MS);
});

test("the right code pairs, and the token is then recognised", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  const r = p.attempt(code);
  expect(r.kind).toBe("paired");
  if (r.kind !== "paired") throw new Error("unreachable");
  expect(p.has(r.token)).toBe(true);
  expect(p.pairedCount).toBe(1);
});

test("the dash and the case are cosmetic", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  expect(p.attempt(formatCode(code).toLowerCase()).kind).toBe("paired");
});

test("normalise strips anything that is not an alphabet symbol", () => {
  expect(normalise(" 4f7k-qp2m\n")).toBe("4F7KQP2M");
});

test("a wrong code reports the attempts remaining and pairs nothing", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const r = p.attempt("00000000");
  expect(r).toEqual({ kind: "wrong", remaining: MAX_ATTEMPTS - 1 });
  expect(p.pairedCount).toBe(0);
});

test("MAX_ATTEMPTS wrong guesses burn the code and mint a new one", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const original = p.current().code;
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    expect(p.attempt("00000000").kind).toBe("wrong");
  }
  expect(p.attempt("00000000").kind).toBe("burned");
  expect(p.current().code).not.toBe(original);
  // The burned code must not still work.
  expect(p.attempt(original).kind).toBe("wrong");
  // ...and the fresh code must, with a full budget behind it.
  expect(p.attempt(p.current().code).kind).toBe("paired");
});

test("the attempt budget resets with each new code", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  for (let i = 0; i < MAX_ATTEMPTS; i++) p.attempt("00000000");
  const r = p.attempt("00000000");
  expect(r).toEqual({ kind: "wrong", remaining: MAX_ATTEMPTS - 1 });
});

test("reissue replaces the live code immediately", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const first = p.current().code;
  const next = p.reissue();
  expect(next.code).not.toBe(first);
  expect(p.current().code).toBe(next.code);
  expect(p.attempt(first).kind).toBe("wrong");
});

test("an unknown token is not a session, and a token is long", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  expect(p.has("")).toBe(false);
  expect(p.has("nope")).toBe(false);
  const r = p.attempt(p.current().code);
  if (r.kind !== "paired") throw new Error("unreachable");
  // 32 bytes, base64url — never shorter than the code it replaces.
  expect(r.token.length).toBeGreaterThanOrEqual(40);
  expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("two pairings are two sessions", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const a = p.attempt(p.current().code);
  const b = p.attempt(p.current().code);
  if (a.kind !== "paired" || b.kind !== "paired") throw new Error("unreachable");
  expect(a.token).not.toBe(b.token);
  expect(p.pairedCount).toBe(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-pairing-codes.test.ts`
Expected: FAIL — `Cannot find module '@server/tunnel/pairing'`

- [ ] **Step 3: Write the implementation**

Create `src/server/tunnel/pairing.ts`:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Crockford base32: `I`, `L`, `O` and `U` are absent so a code read off a
 * terminal and typed on a phone cannot be lost to `1`/`I` or `0`/`O`. Exactly
 * 32 symbols — a shorter alphabet would silently cost entropy.
 */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LEN = 8;
/** ~40 bits. Entropy is not the control here; MAX_ATTEMPTS is. */
export const CODE_TTL_MS = 600_000;
export const MAX_ATTEMPTS = 5;
/** 30 days. Load-bearing — see the note on `setCookie` in gate.ts. */
export const SESSION_MAX_AGE_S = 2_592_000;
export const COOKIE_NAME = "paddock_pair";

export interface LiveCode {
  code: string;
  expiresAt: number;
}

export type Attempt =
  | { kind: "paired"; token: string }
  | { kind: "wrong"; remaining: number }
  | { kind: "burned" };

export function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** The dash and the case are presentation. Anything else is dropped. */
export function normalise(input: string): string {
  const upper = input.toUpperCase();
  let out = "";
  for (const ch of upper) if (ALPHABET.includes(ch)) out += ch;
  return out;
}

/**
 * Constant-time comparison of two codes.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length
 * through an exception — so a wrong-length input is compared against itself
 * and then reported false. The work is done either way.
 */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export interface PairingOptions {
  now?: () => number;
  /** Injected so a test can predict a code. Never used in production. */
  bytes?: (n: number) => Uint8Array;
}

/**
 * The live pairing code and the set of sessions it has minted.
 *
 * There is exactly ONE live code at a time, and there is ALWAYS one: `current()`
 * re-mints lazily once the TTL has passed rather than reporting an expiry. A
 * window with no code would mean an operator who wants to add a tablet on day
 * three has nothing to type, and expiry must never be a reason to tear the
 * tunnel down.
 *
 * Sessions are a plain `Set` with no expiry sweep and no revoke: the process
 * ending is the revoke, and it changes the tunnel's URL too, which is what is
 * actually wanted after a device is lost.
 */
export class Pairing {
  readonly #now: () => number;
  readonly #bytes: (n: number) => Uint8Array;
  readonly #sessions = new Set<string>();
  #code: LiveCode;
  #attempts = 0;

  constructor(opts: PairingOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#bytes = opts.bytes ?? ((n) => new Uint8Array(randomBytes(n)));
    this.#code = this.#mint();
  }

  #mint(): LiveCode {
    const raw = this.#bytes(CODE_LEN);
    let code = "";
    // Modulo bias over a 32-symbol alphabet and a 256-value byte is nil:
    // 256 is a whole multiple of 32.
    for (const b of raw) code += ALPHABET[b % ALPHABET.length];
    this.#attempts = 0;
    return { code, expiresAt: this.#now() + CODE_TTL_MS };
  }

  current(): LiveCode {
    if (this.#now() > this.#code.expiresAt) this.#code = this.#mint();
    return this.#code;
  }

  reissue(): LiveCode {
    this.#code = this.#mint();
    return this.#code;
  }

  attempt(input: string): Attempt {
    const live = this.current();
    if (sameCode(normalise(input), live.code)) {
      const token = Buffer.from(this.#bytes(32)).toString("base64url");
      this.#sessions.add(token);
      return { kind: "paired", token };
    }
    this.#attempts += 1;
    if (this.#attempts >= MAX_ATTEMPTS) {
      this.reissue();
      return { kind: "burned" };
    }
    return { kind: "wrong", remaining: MAX_ATTEMPTS - this.#attempts };
  }

  has(token: string): boolean {
    return token !== "" && this.#sessions.has(token);
  }

  get pairedCount(): number {
    return this.#sessions.size;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tunnel-pairing-codes.test.ts`
Expected: PASS

- [ ] **Step 5: Prove the tests can fail**

Temporarily change `ALPHABET` to include `I`, and `MAX_ATTEMPTS` to `50`. Confirm
the alphabet test and the burn test fail. Revert both.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && bun test tests/tunnel-pairing-codes.test.ts
git add src/server/tunnel/pairing.ts tests/tunnel-pairing-codes.test.ts
git commit -m "feat: pairing codes and the in-memory session set"
```

---

### Task 2: The gate decision, cookie headers and the pairing page

**Files:**
- Create: `src/server/tunnel/gate.ts`
- Test: `tests/tunnel-gate.test.ts`
- Modify: `docs/decisions.md`

**Interfaces:**
- Consumes: `COOKIE_NAME`, `SESSION_MAX_AGE_S` from `@server/tunnel/pairing`.
- Produces:
  `type Decision = { kind: "pass" } | { kind: "page"; stale: boolean } | { kind: "deny"; stale: boolean }`;
  `decide(req: Request, has: (t: string) => boolean): Decision`;
  `tokenFromCookie(header: string | null): string | null`;
  `setCookie(token: string): string`; `clearCookie(): string`;
  `pairingPage(opts: { insecure: boolean }): string`;
  `gateMiddleware(pairing: { has(t: string): boolean }): MiddlewareHandler`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-gate.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { COOKIE_NAME, SESSION_MAX_AGE_S } from "@server/tunnel/pairing";
import {
  clearCookie, decide, gateMiddleware, pairingPage, setCookie, tokenFromCookie,
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

test("the middleware gates a real app and lets a paired session through", async () => {
  const app = new Hono();
  app.use("*", gateMiddleware({ has }));
  app.get("/api/agents", (c) => c.json({ agents: [] }));
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));

  const anon = await app.request("/api/agents");
  expect(anon.status).toBe(401);

  const page = await app.request("/", { headers: html });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<form");

  const paired = await app.request("/", {
    headers: { ...html, cookie: `${COOKIE_NAME}=${GOOD}` },
  });
  expect(await paired.text()).toContain("dashboard");
});

test("the middleware clears a stale cookie on its way past", async () => {
  const app = new Hono();
  app.use("*", gateMiddleware({ has }));
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));
  const res = await app.request("/", {
    headers: { ...html, cookie: `${COOKIE_NAME}=forged` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("the pairing page is never cached", async () => {
  const app = new Hono();
  app.use("*", gateMiddleware({ has }));
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));
  const res = await app.request("/", { headers: html });
  expect(res.headers.get("cache-control")).toContain("no-store");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-gate.test.ts`
Expected: FAIL — `Cannot find module '@server/tunnel/gate'`

- [ ] **Step 3: Write the implementation**

Create `src/server/tunnel/gate.ts`:

```ts
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

export function gateMiddleware(pairing: { has(t: string): boolean }): MiddlewareHandler {
  return async (c, next) => {
    const d = decide(c.req.raw, (t) => pairing.has(t));
    if (d.kind === "pass") return next();

    const headers = new Headers({ "cache-control": "no-store" });
    if (d.stale) headers.append("set-cookie", clearCookie());

    if (d.kind === "page") {
      headers.set("content-type", "text/html; charset=utf-8");
      const insecure = new URL(c.req.url).protocol !== "https:";
      return new Response(pairingPage({ insecure }), { status: 200, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ok: false, detail: "not paired" }), {
      status: 401,
      headers,
    });
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tunnel-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Prove the stranding test can fail**

Temporarily change the `page` branch so an unknown token returns
`{ kind: "deny", stale: true }` for navigations too. Confirm the "treated as no
cookie" test fails. Revert.

- [ ] **Step 6: Record the decision**

Append to `docs/decisions.md`:

```markdown
13. **A pairing gate on its own socket, for quick tunnels only.** Decision 3
    stands for the default listener: `127.0.0.1:8787` has no authentication and
    Cloudflare Access in front of a named tunnel remains the recommended
    deployment. But a *quick* tunnel cannot take an Access policy — Access
    applications are keyed by a domain in your own account and
    `trycloudflare.com` is Cloudflare's — so `paddock tunnel` without a gate
    would publish keystroke access to every agent on the machine, which is the
    plain-`200` outcome `docs/deploy-cloudflare.md` §3 exists to warn about.

    This is not the mechanism decision 3 forbids, for three reasons. The
    credential is a same-origin cookie, not a token in a URL or header, so a
    browser attaches it to page requests and to the WebSocket upgrade alike —
    the exact property decision 3 observes a shared secret lacks. The gate lives
    on a second listener that exists only while `paddock tunnel` runs, so the
    default socket is untouched. And paddock has no service worker: Web Push was
    superseded by Telegram in v2, so `/sw.js` does not exist to be broken — and
    `docs/gotchas.md` already records that an expired Access session breaks a
    service-worker fetch the same way, so this introduces no constraint the
    recommended deployment does not already impose.

    Rejected: exempting loopback by `Host` header on a single port. `cloudflared`
    connects over loopback like any local client, so a tunnel request and a desk
    request are indistinguishable at the socket; the only difference is a header
    the REMOTE client controls, and `Host: localhost` through the tunnel would
    take the exempt path. Two listeners make the gate a property of the socket a
    request arrived on, which nothing outside the machine can forge.

    Not a token, and not a precedent for one. See
    `docs/design/2026-08-20-quick-tunnel-design.md`.
```

Then add the forward pointer to decision 3, so a later reader does not take it
as absolute. After its last line ("Do not reintroduce a token as a 'hardening'
improvement."), append:

```markdown
   Scope, added later: this governs the DEFAULT listener, which is still
   unauthenticated and loopback-only. `paddock tunnel` adds a separate,
   temporary listener with a cookie gate, because a quick tunnel cannot have
   Access in front of it at all — see decision 13 for why that is not the
   mechanism this decision rules out.
```

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && bun test tests/tunnel-gate.test.ts
git add src/server/tunnel/gate.ts tests/tunnel-gate.test.ts docs/decisions.md
git commit -m "feat: the pairing gate's one decision rule, cookies and page"
```

---

### Task 3: `POST /pair`, the invite route, and `tunnel` in the settings view

**Files:**
- Modify: `src/shared/types.ts`, `src/server/routes.ts`,
  `src/server/settings/store.ts`
- Test: `tests/tunnel-routes.test.ts`

**Interfaces:**
- Consumes: `Pairing`, `formatCode` from `@server/tunnel/pairing`;
  `setCookie` from `@server/tunnel/gate`.
- Produces:
  `SettingsView["tunnel"]: { url: string; pairedDevices: number } | null`;
  `AppDeps.pairing?` (see Step 4 for the exact shape);
  `AppDeps.tunnelUrl?: () => string | null`;
  `POST /pair` → `200 {ok:true}` + `set-cookie`, or `400`/`429`;
  `POST /api/pair/invite` → `200 {code, expiresAt}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-routes.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import { COOKIE_NAME, formatCode, Pairing } from "@server/tunnel/pairing";

const NOW = 1_700_000_000_000;
const TUNNEL = "https://quiet-harbor-8f31.trycloudflare.com";

const health = () => ({
  ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
});

function harness() {
  let i = 0;
  const pairing = new Pairing({
    now: () => NOW,
    bytes: (n) => Uint8Array.from({ length: n }, () => i++ % 256),
  });
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    pairing,
    tunnelUrl: () => TUNNEL,
    health,
  });
  return { app, pairing };
}

const postJson = (app: ReturnType<typeof harness>["app"], path: string, body: object) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the right code pairs and sets the session cookie", async () => {
  const { app, pairing } = harness();
  const res = await postJson(app, "/pair", { code: formatCode(pairing.current().code) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`${COOKIE_NAME}=`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Max-Age=2592000");
  expect(pairing.pairedCount).toBe(1);
});

test("a wrong code is a 400 that says how many tries are left", async () => {
  const { app } = harness();
  const res = await postJson(app, "/pair", { code: "00000000" });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { detail: string };
  expect(body.detail).toContain("4");
  expect(res.headers.get("set-cookie")).toBe(null);
});

test("burning the code answers 429, not 400", async () => {
  const { app } = harness();
  let last = await postJson(app, "/pair", { code: "00000000" });
  for (let i = 0; i < 4; i++) last = await postJson(app, "/pair", { code: "00000000" });
  expect(last.status).toBe(429);
});

test("/pair requires application/json, like every other write", async () => {
  // Decision 12: the content type restores the CORS preflight that is the
  // whole CSRF control, and this route is reachable from the internet by design.
  const { app, pairing } = harness();
  const res = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ code: pairing.current().code }),
  });
  expect(res.status).toBe(400);
  expect(pairing.pairedCount).toBe(0);
});

test("a missing or non-string code is rejected without counting an attempt", async () => {
  const { app } = harness();
  expect((await postJson(app, "/pair", {})).status).toBe(400);
  expect((await postJson(app, "/pair", { code: 42 })).status).toBe(400);
  // A malformed body is not a guess — the budget must be intact.
  const res = await postJson(app, "/pair", { code: "00000000" });
  expect(((await res.json()) as { detail: string }).detail).toContain("4");
});

test("the invite route mints a fresh code and reports its expiry", async () => {
  const { app, pairing } = harness();
  const before = pairing.current().code;
  const res = await postJson(app, "/api/pair/invite", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string; expiresAt: number };
  expect(body.code).not.toBe(formatCode(before));
  expect(body.code).toBe(formatCode(pairing.current().code));
  expect(body.expiresAt).toBe(pairing.current().expiresAt);
});

test("the settings view carries the tunnel and its paired count", async () => {
  const { app, pairing } = harness();
  pairing.attempt(pairing.current().code);
  const res = await app.request("/api/settings");
  const body = (await res.json()) as { tunnel: { url: string; pairedDevices: number } | null };
  expect(body.tunnel).toEqual({ url: TUNNEL, pairedDevices: 1 });
});

test("without a pairing instance neither route exists and tunnel is null", async () => {
  const app = createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    health,
  });
  expect((await app.request("/pair", { method: "POST" })).status).toBe(404);
  expect((await app.request("/api/pair/invite", { method: "POST" })).status).toBe(404);
  const body = (await (await app.request("/api/settings")).json()) as { tunnel: unknown };
  expect(body.tunnel).toBe(null);
});
```

Note: the last test needs `settings` on `AppDeps` for `/api/settings` to exist.
Check how `tests/settings*.test.ts` build their harness and mirror it — pass the
same `SettingsStore` over a temp directory those tests use, in both harnesses
here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-routes.test.ts`
Expected: FAIL — `pairing` is not a known property of `AppDeps`

- [ ] **Step 3: Add the shared type**

In `src/shared/types.ts`, add to `SettingsView`, after `publicUrl`:

```ts
  /**
   * Non-null only while `paddock tunnel` is running. The UI renders its
   * "add a device" control from this, so `null` means the section is absent
   * rather than empty — a paddock served the ordinary way has no tunnel to
   * describe and must not offer to pair one.
   */
  tunnel: { url: string; pairedDevices: number } | null;
```

`SettingsStore.view()` must then return `tunnel: null` — the store knows nothing
about tunnels and must not learn. Add that literal to the object `view()` builds
in `src/server/settings/store.ts`.

- [ ] **Step 4: Add the deps and the routes**

In `src/server/routes.ts`, add to `AppDeps`:

```ts
  /**
   * Present only in `paddock tunnel`. Its presence is what registers `/pair`
   * and the invite route — the same pattern `actions` uses: a paddock with no
   * tunnel 404s them honestly rather than offering a pairing flow that could
   * not gate anything.
   *
   * Structurally typed rather than importing `Pairing`, so `routes.ts` does not
   * depend on the tunnel module for a type it only reads.
   */
  pairing?: {
    attempt(input: string):
      | { kind: "paired"; token: string }
      | { kind: "wrong"; remaining: number }
      | { kind: "burned" };
    reissue(): { code: string; expiresAt: number };
    current(): { code: string; expiresAt: number };
    readonly pairedCount: number;
  };
  /** The live tunnel URL, for the settings view. */
  tunnelUrl?: () => string | null;
```

Inside `createApp`, after the `/ack` route:

```ts
  const pairing = deps.pairing;
  if (pairing) {
    /**
     * The ONE route reachable without a session — `gate.decide` passes it
     * explicitly, because there is otherwise no way to acquire one.
     *
     * `strictJsonBody` for decision 12's reason, and more sharply than
     * anywhere else in this file: this route is reachable from the public
     * internet by design, so the preflight it restores is the only thing
     * standing between a drive-by page and an attempt at the code.
     */
    app.post("/pair", async (c) => {
      const parsed = await strictJsonBody(c);
      if (!parsed.ok) return c.json({ ok: false, detail: parsed.detail }, 400);
      const code = parsed.body.code;
      // A malformed body is NOT a guess and must not spend the budget —
      // otherwise anyone can burn codes without ever sending one.
      if (typeof code !== "string") {
        return c.json({ ok: false, detail: "code must be a string" }, 400);
      }

      const r = pairing.attempt(code);
      if (r.kind === "paired") {
        c.header("set-cookie", setCookie(r.token));
        return c.json({ ok: true });
      }
      if (r.kind === "burned") {
        return c.json(
          { ok: false, detail: "too many attempts — a new code is on the terminal" },
          429,
        );
      }
      return c.json(
        { ok: false, detail: `that code is not right — ${r.remaining} attempts left` },
        400,
      );
    });

    /**
     * Mints a fresh code from an ALREADY PAIRED device: after several days the
     * assumption that the operator is at their desk is the weaker one. It sits
     * under `/api/`, so the gate covers it like every other API route — a
     * trusted device in the operator's hand vouching for the next one.
     */
    app.post("/api/pair/invite", (c) => {
      const { code, expiresAt } = pairing.reissue();
      return c.json({ code: formatCode(code), expiresAt });
    });
  }
```

Add the imports at the top of `routes.ts`:

```ts
import { formatCode } from "@server/tunnel/pairing";
import { setCookie } from "@server/tunnel/gate";
```

- [ ] **Step 5: Compose `tunnel` into the settings view**

Find the `GET /api/settings` handler and wrap its body so the route — not the
store — supplies the tunnel:

```ts
    app.get("/api/settings", (c) => {
      const url = deps.tunnelUrl?.() ?? null;
      return c.json({
        ...settings.view(now()),
        tunnel: url !== null && pairing ? { url, pairedDevices: pairing.pairedCount } : null,
      });
    });
```

`SettingsView` is now a required field wider than before, so `tsc` will flag any
test fixture that builds one by hand. Add `tunnel: null` to each; expect a
handful of one-line edits under `tests/`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/tunnel-routes.test.ts && make check`
Expected: PASS, `tsc` clean.

- [ ] **Step 7: Prove the budget test can fail**

Temporarily move the `typeof code !== "string"` check below
`pairing.attempt(...)`. Confirm "without counting an attempt" fails. Revert.

- [ ] **Step 8: Commit**

```bash
make check && make check-clean && make test
git add src/shared/types.ts src/server/routes.ts src/server/settings/store.ts tests/
git commit -m "feat: POST /pair, the invite route, and tunnel in the settings view"
```

---

### Task 4: The `cloudflared` child

**Files:**
- Create: `src/shared/quick-tunnel.ts`, `src/server/tunnel/cloudflared.ts`
- Test: `tests/quick-tunnel.test.ts`, `tests/tunnel-cloudflared.test.ts`

**Interfaces:**
- Produces:
  `QUICK_TUNNEL_RE: RegExp` and `isQuickTunnelUrl(url: string | null): boolean`
  from `@shared/quick-tunnel`;
  `extractUrl(chunk: string): string | null`;
  `installHint(platform: string): string`;
  `findCloudflared(which?: (bin: string) => string | null): string | null`;
  `interface Child { stdout: ReadableStream<Uint8Array> | null; stderr: ReadableStream<Uint8Array> | null; exited: Promise<number>; kill(sig?: number | string): void }`;
  `type SpawnFn = (cmd: string[]) => Child`;
  `interface Tunnel { url: string; exited: Promise<number>; stop(): Promise<void> }`;
  `startTunnel(opts: { port: number; bin?: string; spawn?: SpawnFn; timeoutMs?: number; onLog?: (line: string) => void }): Promise<Tunnel>`.

- [ ] **Step 1: Write the shared predicate and its test**

The hostname shape is needed in three places — extracting the URL from
`cloudflared`'s output, deciding whether a saved `publicUrl` is a real
deployment (Task 6), and warning about a stale one in the UI (Task 9). The UI
cannot import from `@server`, so it lives in `@shared`, and there is exactly ONE
regex. Two definitions of "is this a quick tunnel" is how one of them ends up
accepting `a.trycloudflare.com.example.net`.

Create `tests/quick-tunnel.test.ts`:

```ts
import { expect, test } from "bun:test";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";

test("a quick-tunnel host is recognised", () => {
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com")).toBe(true);
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com/")).toBe(true);
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com/a1b2c3")).toBe(true);
});

test("a real deployment is not one, and neither is nothing", () => {
  expect(isQuickTunnelUrl("https://paddock.example.com")).toBe(false);
  expect(isQuickTunnelUrl(null)).toBe(false);
  expect(isQuickTunnelUrl("")).toBe(false);
  expect(isQuickTunnelUrl("not a url")).toBe(false);
});

test("a lookalike suffix is somebody else's domain", () => {
  // The whole reason there is one regex: this case is easy to get wrong twice.
  expect(isQuickTunnelUrl("https://a.trycloudflare.com.example.net")).toBe(false);
  expect(isQuickTunnelUrl("https://trycloudflare.com.example.net")).toBe(false);
});

test("the check is on the host, not the string", () => {
  // A path or query mentioning the suffix proves nothing about where it points.
  expect(isQuickTunnelUrl("https://paddock.example.com/?x=quiet.trycloudflare.com")).toBe(false);
});
```

Create `src/shared/quick-tunnel.ts`:

```ts
/**
 * The ONE definition of the quick-tunnel hostname shape.
 *
 * Imported by `server/tunnel/cloudflared.ts` to read the URL out of
 * `cloudflared`'s output, by `server/tunnel/preflight.ts` to decide whether a
 * saved `publicUrl` is a real deployment, and by the settings UI to flag a
 * stale one. It lives here because the UI may not import from `@server`, and
 * because a second copy would drift — one of the two would end up accepting
 * `a.trycloudflare.com.example.net`, which is somebody else's domain wearing
 * the suffix as a prefix.
 *
 * Anchored on BOTH ends for exactly that reason. `https` only: a quick tunnel
 * is always TLS, so a plaintext match means we misread the line.
 */
export const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![.\w-])/i;

/**
 * Is this URL a quick tunnel?
 *
 * Parsed rather than pattern-matched against the whole string: a path or query
 * that mentions the suffix says nothing about where the URL points, and
 * `isQuickTunnelUrl` is used to decide whether an operator has a real
 * deployment. Getting that backwards silences a hint they need.
 */
export function isQuickTunnelUrl(url: string | null): boolean {
  if (url === null || url === "") return false;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname;
  } catch {
    // Not a URL at all. Not a quick tunnel either.
    return false;
  }
  return /^[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/i.test(host);
}
```

Run: `bun test tests/quick-tunnel.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the failing cloudflared tests**

Create `tests/tunnel-cloudflared.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  extractUrl, findCloudflared, installHint, startTunnel, type Child,
} from "@server/tunnel/cloudflared";

const HOST = "https://quiet-harbor-8f31.trycloudflare.com";

/** cloudflared boxes the URL in its log output, on stderr. */
const REAL_ISH = [
  "2026-08-20T09:14:02Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-08-20T09:14:04Z INF +------------------------------------------------------+",
  "2026-08-20T09:14:04Z INF |  Your quick Tunnel has been created! Visit it at:    |",
  `2026-08-20T09:14:04Z INF |  ${HOST}  |`,
  "2026-08-20T09:14:04Z INF +------------------------------------------------------+",
].join("\n");

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

function child(over: Partial<Child> = {}): Child {
  return {
    stdout: stream(""),
    stderr: stream(REAL_ISH),
    exited: new Promise<number>(() => {}),
    kill() {},
    ...over,
  };
}

test("the URL is extracted from cloudflared's own boxed output", () => {
  expect(extractUrl(REAL_ISH)).toBe(HOST);
});

test("extraction accepts only a trycloudflare host, and never guesses", () => {
  expect(extractUrl("INF no url here")).toBe(null);
  expect(extractUrl("visit https://paddock.example.com/ instead")).toBe(null);
  expect(extractUrl("http://quiet-harbor-8f31.trycloudflare.com")).toBe(null);
  // A lookalike suffix is somebody else's domain wearing ours as a prefix.
  expect(extractUrl("https://a.trycloudflare.com.example.net")).toBe(null);
});

test("the install hint names a command for each platform", () => {
  expect(installHint("darwin")).toContain("brew install cloudflared");
  expect(installHint("linux")).toContain("cloudflared");
  expect(installHint("win32")).toContain("winget");
  // Every hint carries the docs URL, since no one-liner covers every distro.
  for (const p of ["darwin", "linux", "win32", "freebsd"]) {
    expect(installHint(p)).toContain("developers.cloudflare.com");
  }
});

test("findCloudflared reports the path, or null", () => {
  expect(findCloudflared(() => "/somewhere/cloudflared")).toBe("/somewhere/cloudflared");
  expect(findCloudflared(() => null)).toBe(null);
});

test("startTunnel resolves with the URL and passes the port to the child", async () => {
  let cmd: string[] = [];
  const t = await startTunnel({
    port: 8788,
    bin: "/somewhere/cloudflared",
    spawn: (c) => { cmd = c; return child(); },
  });
  expect(t.url).toBe(HOST);
  expect(cmd[0]).toBe("/somewhere/cloudflared");
  expect(cmd).toContain("--url");
  expect(cmd).toContain("http://127.0.0.1:8788");
});

test("a child that prints no URL is a loud failure, not a guess", async () => {
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 20,
    spawn: () => child({ stderr: stream("INF starting\nINF connected\n") }),
  })).rejects.toThrow(/no url/i);
});

test("a child that dies before printing a URL reports its exit status", async () => {
  await expect(startTunnel({
    port: 8788,
    bin: "cf",
    timeoutMs: 500,
    spawn: () => child({ stderr: stream("ERR failed to connect\n"), exited: Promise.resolve(1) }),
  })).rejects.toThrow(/exited 1/i);
});

test("every line is forwarded, so a failure is never silent", async () => {
  const seen: string[] = [];
  await startTunnel({
    port: 8788, bin: "cf",
    spawn: () => child(),
    onLog: (l) => seen.push(l),
  });
  expect(seen.some((l) => l.includes("Requesting new quick Tunnel"))).toBe(true);
});

test("stop kills the child and waits for it", async () => {
  const killed: (number | string | undefined)[] = [];
  let resolveExit: (n: number) => void = () => {};
  const t = await startTunnel({
    port: 8788, bin: "cf",
    spawn: () => child({
      exited: new Promise<number>((r) => { resolveExit = r; }),
      kill: (s) => { killed.push(s); resolveExit(0); },
    }),
  });
  await t.stop();
  expect(killed.length).toBeGreaterThan(0);
  expect(await t.exited).toBe(0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/tunnel-cloudflared.test.ts`
Expected: FAIL — `Cannot find module '@server/tunnel/cloudflared'`

- [ ] **Step 4: Write the implementation**

Create `src/server/tunnel/cloudflared.ts`:

```ts
/**
 * The one place that knows `cloudflared` exists. Nothing here imports anything
 * from paddock, and nothing in paddock imports it except `tunnel/run.ts`.
 */

import { QUICK_TUNNEL_RE } from "@shared/quick-tunnel";

/**
 * The regex is imported, not restated. It is anchored on BOTH ends so that
 * `a.trycloudflare.com.example.net` — somebody else's domain wearing the suffix
 * as a prefix — does not match, and a second copy of that reasoning here would
 * be a second chance to get it wrong.
 */
export function extractUrl(chunk: string): string | null {
  return chunk.match(QUICK_TUNNEL_RE)?.[0] ?? null;
}

export function installHint(platform: string): string {
  const docs =
    "  other platforms: https://developers.cloudflare.com/cloudflare-one/\n" +
    "                   connections/connect-networks/downloads/";
  const one =
    platform === "darwin"
      ? "    brew install cloudflared"
      : platform === "win32"
        ? "    winget install --id Cloudflare.cloudflared"
        : platform === "linux"
          ? "    install the cloudflared package for your distro, or the binary"
          : "    download the cloudflared binary for your platform";
  return `${one}\n\n${docs}`;
}

export function findCloudflared(
  which: (bin: string) => string | null = (b) => Bun.which(b),
): string | null {
  return which("cloudflared");
}

export interface Child {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(sig?: number | string): void;
}

export type SpawnFn = (cmd: string[]) => Child;

export interface Tunnel {
  url: string;
  exited: Promise<number>;
  stop(): Promise<void>;
}

const defaultSpawn: SpawnFn = (cmd) =>
  Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as Child;

/**
 * Spawn `cloudflared` and resolve once it has told us the URL.
 *
 * The URL is READ, never constructed: the hostname is Cloudflare's to choose
 * and there is no way to derive it. A run that never prints one rejects rather
 * than returning a plausible string, because a wrong URL printed confidently is
 * worse than a failure — the operator would send it to their phone and blame
 * paddock for the 404.
 *
 * BOTH pipes are drained. cloudflared logs to stderr, but draining only the
 * pipe we expect would let the other fill its buffer and stall the child.
 */
export async function startTunnel(opts: {
  port: number;
  bin?: string;
  spawn?: SpawnFn;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}): Promise<Tunnel> {
  const bin = opts.bin ?? "cloudflared";
  const spawn = opts.spawn ?? defaultSpawn;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const log = opts.onLog ?? ((l: string) => console.info(`[cloudflared] ${l}`));

  const child = spawn([
    bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`,
  ]);

  let found: string | null = null;
  let resolveUrl: (u: string) => void = () => {};
  const urlSeen = new Promise<string>((r) => { resolveUrl = r; });

  const take = (line: string) => {
    if (line !== "") log(line);
    const u = extractUrl(line);
    if (u !== null && found === null) {
      found = u;
      resolveUrl(u);
    }
  };

  const drain = async (s: ReadableStream<Uint8Array> | null) => {
    if (s === null) return;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const bytes of s as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(bytes, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    if (buf !== "") take(buf);
  };

  // Not awaited: these run for the life of the child. The rejection is
  // reported rather than dropped — Bun ends the process on an unhandled one.
  void Promise.all([drain(child.stdout), drain(child.stderr)]).catch((e) =>
    console.error(`[cloudflared] could not read output: ${String(e)}`),
  );

  const died = child.exited.then<never>((code) => {
    throw new Error(`cloudflared exited ${code} before publishing a URL`);
  });
  const timedOut = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`cloudflared printed no url within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref?.();
  });

  const url = await Promise.race([urlSeen, died, timedOut]);

  return {
    url,
    exited: child.exited,
    async stop() {
      child.kill("SIGTERM");
      const grace = new Promise<"grace">((r) => {
        setTimeout(() => r("grace"), 3000).unref?.();
      });
      if ((await Promise.race([child.exited, grace])) === "grace") child.kill("SIGKILL");
      await child.exited;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/tunnel-cloudflared.test.ts`
Expected: PASS

- [ ] **Step 6: Prove the URL test can fail**

Temporarily relax `URL_RE` to `/https?:\/\/\S+/i`. Confirm "accepts only a
trycloudflare host" fails on three of its four cases. Revert.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && bun test tests/quick-tunnel.test.ts tests/tunnel-cloudflared.test.ts
git add src/shared/quick-tunnel.ts src/server/tunnel/cloudflared.ts tests/quick-tunnel.test.ts tests/tunnel-cloudflared.test.ts
git commit -m "feat: spawn cloudflared and read the URL it publishes"
```

---

### Task 5: The `tunnel` verb, `--for`, and flag values

**Files:**
- Modify: `src/server/cli.ts`
- Test: `tests/cli.test.ts` (extend)

**Interfaces:**
- Produces: `Command` gains `"tunnel"`; `ParsedArgs` gains
  `values: Map<string, string>`; `parseDuration(input: string): number | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cli.test.ts` (add `parseDuration` to the existing import from
`@server/cli`):

```ts
test("tunnel is a command", () => {
  expect(parseArgs(["tunnel"]).command).toBe("tunnel");
});

test("--for carries its value in both spellings", () => {
  expect(parseArgs(["tunnel", "--for", "2h"]).values.get("--for")).toBe("2h");
  expect(parseArgs(["tunnel", "--for=2h"]).values.get("--for")).toBe("2h");
});

test("a --for value is never mistaken for the verb", () => {
  // `verb` was "the first token that does not start with a dash", so without
  // consuming the value, `paddock --for 2h tunnel` read "2h" as the verb —
  // which `commandFor` calls unknown, and the operator gets no tunnel.
  const p = parseArgs(["--for", "2h", "tunnel"]);
  expect(p.command).toBe("tunnel");
  expect(p.values.get("--for")).toBe("2h");
});

test("--demo still composes with tunnel", () => {
  const p = parseArgs(["tunnel", "--demo"]);
  expect(p.command).toBe("tunnel");
  expect(p.flags.has("--demo")).toBe(true);
});

test("the existing verb behaviour is unchanged", () => {
  // Guards the regressions cli.ts's own comments describe, now that the
  // parser has been rewritten to consume flag values.
  expect(parseArgs([]).command).toBe("serve");
  expect(parseArgs(["--demo"]).command).toBe("serve");
  expect(parseArgs(["--help"]).command).toBe("help");
  expect(parseArgs(["-h"]).command).toBe("help");
  expect(parseArgs(["updte"]).command).toBe("unknown");
  expect(parseArgs(["updte", "--help"]).command).toBe("unknown");
  expect(parseArgs(["--demo", "agent"]).command).toBe("agent");
  expect(parseArgs(["update", "--check"]).command).toBe("update");
  expect(parseArgs(["update", "--check"]).flags.has("--check")).toBe(true);
});

test("durations parse in seconds, minutes and hours", () => {
  expect(parseDuration("45s")).toBe(45_000);
  expect(parseDuration("90m")).toBe(5_400_000);
  expect(parseDuration("2h")).toBe(7_200_000);
});

test("a malformed duration is null, never a default", () => {
  // A mistyped deadline that silently becomes "no deadline" defeats the flag.
  for (const bad of ["", "2", "h", "2d", "-2h", "2.5h", "0h", "two hours", "2h30m"]) {
    expect(parseDuration(bad)).toBe(null);
  }
});

test("USAGE documents the verb", () => {
  expect(USAGE).toContain("paddock tunnel");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — `values` does not exist on `ParsedArgs`

- [ ] **Step 3: Extend the types and usage**

In `src/server/cli.ts`:

```ts
export type Command =
  | "serve" | "update" | "start" | "stop" | "status" | "doctor" | "tunnel"
  | "help" | "agent" | "hub"
  | "unknown";

export interface ParsedArgs {
  command: Command;
  flags: Set<string>;
  /** Values for the flags that take one, e.g. `--for` → `"2h"`. */
  values: Map<string, string>;
  verb: string | null;
}

/** The only flags that consume the token after them. */
const VALUE_FLAGS = new Set(["--for"]);
```

Add to `USAGE`, after the `doctor` line:

```ts
  "       paddock tunnel [--for D]  publish it on a quick tunnel, gated by a code",
```

- [ ] **Step 4: Rewrite the scan**

Replace the body of `parseArgs`:

```ts
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let verb: string | null = null;

  // A POSITIONAL scan, not two independent filters. The old
  // `argv.find(a => !a.startsWith("-"))` had no way to know that the token
  // after `--for` belongs to the flag, so `paddock --for 2h tunnel` read "2h"
  // as the verb.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) {
      verb ??= a;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const name = a.slice(0, eq);
      flags.add(name);
      values.set(name, a.slice(eq + 1));
      continue;
    }
    flags.add(a);
    if (VALUE_FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      values.set(a, argv[++i]!);
    }
  }

  const command = commandFor(verb);
  if (command === "serve" && (flags.has("--help") || flags.has("-h"))) {
    return { command: "help", flags, values, verb };
  }
  return { command, flags, values, verb };
}
```

Add `tunnel` to `commandFor`, beside `doctor`:

```ts
  if (verb === "tunnel") return "tunnel";
```

And append the duration parser:

```ts
/**
 * `45s`, `90m`, `2h`. Returns null for anything else — including `2`, `2d` and
 * `2h30m`.
 *
 * Null is a REFUSAL, not a default. `--for` exists to bound how long a public
 * URL lives; a typo that quietly became "no deadline" would defeat the only
 * reason to type the flag.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)([smh])$/.exec(input);
  if (m === null) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
  return n * unit;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/cli.test.ts && make check`
Expected: PASS. `ParsedArgs` gained a required field, so if `index.ts`
constructs one anywhere, add `values: new Map()` there.

- [ ] **Step 6: Prove the positional test can fail**

Temporarily restore `const verb = argv.find((a) => !a.startsWith("-")) ?? null;`
alongside the new loop. Confirm "a --for value is never mistaken for the verb"
fails. Revert.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && bun test tests/cli.test.ts
git add src/server/cli.ts tests/cli.test.ts
git commit -m "feat: the tunnel verb, --for, and a parser that consumes flag values"
```

---

### Task 6: Preflight and the discoverability hint

**Files:**
- Create: `src/server/tunnel/preflight.ts`
- Test: `tests/tunnel-preflight.test.ts`, `tests/tunnel-hints.test.ts`

**Interfaces:**
- Consumes: `findCloudflared`, `installHint` from `@server/tunnel/cloudflared`;
  `checkState`, `type StateCheck` from `@server/lifecycle/state`; `isConfigured`
  from `@server/settings/store`; `isQuickTunnelUrl` from `@shared/quick-tunnel`.
- Produces:
  `type Preflight = { ok: true; bin: string } | { ok: false; message: string }`;
  `preflight(opts: { dir: string; platform?: string; which?: (b: string) => string | null; check?: (dir: string) => Promise<StateCheck>; log?: (line: string) => void }): Promise<Preflight>`;
  `tunnelHint(publicUrl: string | null, detached: boolean): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { StateCheck } from "@server/lifecycle/state";
import { preflight } from "@server/tunnel/preflight";

const RUNNING: StateCheck = {
  kind: "running",
  state: { pid: 4242, args: "paddock", port: 8787, version: "0.6.1", startedAt: 0 },
};

type Opts = Parameters<typeof preflight>[0];
const opts = (over: Partial<Opts> = {}): Opts => ({
  dir: "/tmp/paddock-preflight-fixture",
  platform: "linux",
  which: () => "/somewhere/cloudflared",
  check: async () => ({ kind: "none" }),
  ...over,
});

test("all three clear reports the binary's path", async () => {
  expect(await preflight(opts())).toEqual({ ok: true, bin: "/somewhere/cloudflared" });
});

test("a running detached instance is refused, and the reason is named", async () => {
  const r = await preflight(opts({ check: async () => RUNNING }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  // The hazard is two notifiers, not a port conflict. Say which.
  expect(r.message).toMatch(/notif/i);
  expect(r.message).toContain("paddock stop");
  expect(r.message).toContain("4242");
});

test("a missing cloudflared is refused with the platform's install line", async () => {
  const r = await preflight(opts({ which: () => null, platform: "darwin" }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.message).toContain("brew install cloudflared");
  expect(r.message).toContain("developers.cloudflare.com");
});

test("the detached check runs before the binary check", async () => {
  // Cheapest first, and the more actionable message wins: being told to
  // install cloudflared, then told to stop paddock, is two round trips.
  const r = await preflight(opts({ check: async () => RUNNING, which: () => null }));
  if (r.ok) throw new Error("unreachable");
  expect(r.message).toContain("paddock stop");
  expect(r.message).not.toContain("brew");
});

test("a stale or mismatched state file does not block a tunnel", async () => {
  expect((await preflight(opts({
    check: async () => ({ kind: "stale", state: RUNNING.state }),
  }))).ok).toBe(true);
  expect((await preflight(opts({
    check: async () => ({ kind: "mismatch", state: RUNNING.state, actual: null }),
  }))).ok).toBe(true);
});

test("an unreadable state file does not block a tunnel, but is reported", async () => {
  const lines: string[] = [];
  const r = await preflight(opts({
    check: async () => ({ kind: "unreadable", error: "EACCES" }),
    log: (l) => lines.push(l),
  }));
  expect(r.ok).toBe(true);
  // Never swallowed: the operator learns the file could not be read.
  expect(lines.join("\n")).toContain("EACCES");
});
```

Create `tests/tunnel-hints.test.ts`:

```ts
import { expect, test } from "bun:test";
import { tunnelHint } from "@server/tunnel/preflight";

test("a paddock with no public URL is told about the tunnel", () => {
  expect(tunnelHint(null, false)).toContain("paddock tunnel");
});

test("a configured publicUrl silences the hint entirely", () => {
  // An operator on the named-tunnel path has solved this, and must not be
  // nudged toward the weaker option.
  expect(tunnelHint("https://paddock.example.com", false)).toBe(null);
  expect(tunnelHint("https://paddock.example.com", true)).toBe(null);
});

test("an empty string counts as unconfigured, like everywhere else", () => {
  // `isConfigured` treats "" as absent; a second opinion here would be a bug.
  expect(tunnelHint("", false)).toContain("paddock tunnel");
});

test("a SAVED quick-tunnel URL does not count as configured", () => {
  // A *.trycloudflare.com value in settings is not a deployment — it is a dead
  // link pasted in from an earlier run, because the hostname changes on every
  // start. Treating it as configured would silence the hint for exactly the
  // operator who needs it.
  expect(tunnelHint("https://quiet-harbor-8f31.trycloudflare.com", false))
    .toContain("paddock tunnel");
  expect(tunnelHint("https://quiet-harbor-8f31.trycloudflare.com", true))
    .toContain("paddock tunnel");
});

test("a lookalike host is still a real deployment", () => {
  // One regex, anchored — see @shared/quick-tunnel. This must not be silenced
  // by accident and must not be flagged as stale either.
  expect(tunnelHint("https://a.trycloudflare.com.example.net", false)).toBe(null);
});

test("the detached hint admits the stop, because the two are exclusive", () => {
  expect(tunnelHint(null, true)).toContain("stop");
  expect(tunnelHint(null, false)).not.toContain("stop");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-preflight.test.ts tests/tunnel-hints.test.ts`
Expected: FAIL — `Cannot find module '@server/tunnel/preflight'`

- [ ] **Step 3: Write the implementation**

Create `src/server/tunnel/preflight.ts`:

```ts
import { checkState, type StateCheck } from "@server/lifecycle/state";
import { isConfigured } from "@server/settings/store";
import { findCloudflared, installHint } from "@server/tunnel/cloudflared";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";

export type Preflight = { ok: true; bin: string } | { ok: false; message: string };

/**
 * The three refusals, cheapest first, and NOTHING bound or opened until all
 * three pass — the rule `index.ts` already follows for `help` / `update` /
 * `status`. A command that is going to fail must not start a server on its way
 * to failing.
 *
 * Order matters beyond cost: a running instance is reported before a missing
 * binary, because being told to install cloudflared and only then told to stop
 * paddock is two trips for one answer.
 */
export async function preflight(opts: {
  dir: string;
  platform?: string;
  which?: (bin: string) => string | null;
  check?: (dir: string) => Promise<StateCheck>;
  log?: (line: string) => void;
}): Promise<Preflight> {
  const platform = opts.platform ?? process.platform;
  const check = opts.check ?? ((d: string) => checkState(d));
  const log = opts.log ?? ((l: string) => console.error(l));

  const state = await check(opts.dir);
  if (state.kind === "running") {
    return {
      ok: false,
      message: [
        `paddock: a detached paddock is already running (pid ${state.state.pid})`,
        "",
        "  paddock tunnel serves the dashboard itself, so running it alongside",
        "  that instance would open a SECOND connection to herdr — and a second",
        "  notifier. Every blocked agent would notify you twice.",
        "",
        "    paddock stop && paddock tunnel",
      ].join("\n"),
    };
  }
  // Never swallowed: a state file we could not read is reported, then stepped
  // past. It is not evidence that anything is running.
  if (state.kind === "unreadable") {
    log(`paddock: could not read the state file (${state.error}); continuing`);
  }

  const bin = findCloudflared(opts.which);
  if (bin === null) {
    return {
      ok: false,
      message: [
        "paddock: cloudflared is not installed",
        "",
        "  paddock tunnel needs Cloudflare's tunnel client to publish a URL.",
        "",
        installHint(platform),
        "",
        "  then run paddock tunnel again.",
      ].join("\n"),
    };
  }

  return { ok: true, bin };
}

/**
 * The one-line nudge printed by `paddock` and `paddock start`, or null.
 *
 * Silent when `publicUrl` names a real deployment: that operator is on the
 * named-tunnel path with Access in front of it, which is the RECOMMENDED
 * deployment, and nudging them toward a quick tunnel would advertise the weaker
 * option to the one person who does not need it.
 *
 * But a SAVED `*.trycloudflare.com` value is not a deployment — the hostname
 * changes on every start, so it is a dead link from an earlier run, and its
 * owner is precisely who this hint is for. "Configured" therefore means set AND
 * not a quick tunnel.
 *
 * `isConfigured` rather than a local truthiness test — four call sites once
 * disagreed about an empty-string token, and this is not becoming the fifth.
 */
export function tunnelHint(publicUrl: string | null, detached: boolean): string | null {
  if (isConfigured(publicUrl) && !isQuickTunnelUrl(publicUrl)) return null;
  return detached
    ? "  for phone access, stop it and run paddock tunnel"
    : "  to reach this from your phone: paddock tunnel";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tunnel-preflight.test.ts tests/tunnel-hints.test.ts`
Expected: PASS

- [ ] **Step 5: Prove the ordering test can fail**

Temporarily move the `findCloudflared` block above the `check` block. Confirm
"the detached check runs before the binary check" fails. Revert.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && bun test tests/tunnel-preflight.test.ts tests/tunnel-hints.test.ts
git add src/server/tunnel/preflight.ts tests/tunnel-preflight.test.ts tests/tunnel-hints.test.ts
git commit -m "feat: tunnel preflight refuses rather than half-starting"
```

---

### Task 7: The terminal display

**Files:**
- Create: `src/server/tunnel/display.ts`
- Test: `tests/tunnel-display.test.ts`

**Interfaces:**
- Consumes: `formatCode` from `@server/tunnel/pairing`.
- Produces:
  `interface DisplayState { url: string; code: string; codeExpiresAt: number; paired: number; startedAt: number; deadline: number | null; now: number }`;
  `useColour(env: Record<string, string | undefined>, isTty: boolean): boolean`;
  `human(ms: number): string`; `render(s: DisplayState, colour: boolean): string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-display.test.ts`:

```ts
import { expect, test } from "bun:test";
import { human, render, useColour, type DisplayState } from "@server/tunnel/display";

const T0 = 1_700_000_000_000;
const state = (over: Partial<DisplayState> = {}): DisplayState => ({
  url: "https://quiet-harbor-8f31.trycloudflare.com",
  code: "4F7KQP2M",
  codeExpiresAt: T0 + 372_000,
  paired: 1,
  startedAt: T0 - 1_380_000,
  deadline: null,
  now: T0,
  ...over,
});

test("durations read as a human would say them", () => {
  expect(human(0)).toBe("0s");
  expect(human(42_000)).toBe("42s");
  expect(human(372_000)).toBe("6m 12s");
  expect(human(4_320_000)).toBe("1h 12m");
  // Never negative: a clock that has passed the deadline says 0s.
  expect(human(-5_000)).toBe("0s");
});

test("the block carries the URL, the dashed code and both clocks", () => {
  const out = render(state(), false);
  expect(out).toContain("https://quiet-harbor-8f31.trycloudflare.com");
  expect(out).toContain("4F7K-QP2M");
  expect(out).toContain("23m 0s elapsed");
  expect(out).toContain("expires in 6m 12s");
});

test("the paired count is shown, and reads naturally for one", () => {
  expect(render(state({ paired: 0 }), false)).toContain("paired: no devices yet");
  expect(render(state({ paired: 1 }), false)).toContain("paired: 1 device");
  expect(render(state({ paired: 3 }), false)).toContain("paired: 3 devices");
});

test("the warning names what the code is protecting", () => {
  const out = render(state(), false);
  expect(out).toMatch(/public/i);
  expect(out).toContain("docs/deploy-cloudflare.md");
});

test("a deadline adds a closing clock, and its absence removes it", () => {
  expect(render(state({ deadline: T0 + 4_320_000 }), false)).toContain("closes in 1h 12m");
  expect(render(state(), false)).not.toContain("closes in");
});

test("colour decorates and never informs", () => {
  const plain = render(state(), false);
  const colour = render(state(), true);
  const ESC = /\x1b\[[0-9;]*m/g;
  expect(plain).not.toMatch(ESC);
  expect(colour).toMatch(ESC);
  // Stripping every escape from the coloured render gives the plain one back,
  // so a piped log and a terminal say exactly the same things.
  expect(colour.replace(ESC, "")).toBe(plain);
});

test("colour is off unless stdout is a tty, and NO_COLOR always wins", () => {
  expect(useColour({}, true)).toBe(true);
  expect(useColour({}, false)).toBe(false);
  expect(useColour({ NO_COLOR: "1" }, true)).toBe(false);
  // The convention is that the variable's PRESENCE is the signal.
  expect(useColour({ NO_COLOR: "" }, true)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-display.test.ts`
Expected: FAIL — `Cannot find module '@server/tunnel/display'`

- [ ] **Step 3: Write the implementation**

Create `src/server/tunnel/display.ts`:

```ts
import { formatCode } from "@server/tunnel/pairing";

export interface DisplayState {
  url: string;
  code: string;
  codeExpiresAt: number;
  paired: number;
  startedAt: number;
  /** Epoch ms, or null when `--for` was not given. */
  deadline: number | null;
  now: number;
}

/**
 * `NO_COLOR` wins whether or not it has a value — by convention the variable's
 * PRESENCE is the signal. Off entirely when stdout is not a tty, so a piped log
 * never receives escape bytes.
 */
export function useColour(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if ("NO_COLOR" in env) return false;
  return isTty;
}

export function human(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const devices = (n: number) =>
  n === 0 ? "no devices yet" : n === 1 ? "1 device" : `${n} devices`;

/**
 * Pure: state in, block out. The loop in `run.ts` only decides WHEN to draw.
 *
 * Colour decorates and never informs — `tunnel-display.test.ts` asserts that
 * stripping every escape from the coloured render returns the plain one, so a
 * piped log and a terminal read identically. Do not make a distinction that
 * exists only in colour.
 */
export function render(s: DisplayState, colour: boolean): string {
  const c = (code: string, text: string) =>
    colour ? `\x1b[${code}m${text}\x1b[0m` : text;

  const lines = [
    `  ${c("32", "✓")} tunnel up · ${human(s.now - s.startedAt)} elapsed`,
    `    ${c("36", s.url)}`,
    "",
    `    code ${formatCode(s.code)} · expires in ${human(s.codeExpiresAt - s.now)}`,
    `    paired: ${devices(s.paired)}`,
  ];
  if (s.deadline !== null) lines.push(`    closes in ${human(s.deadline - s.now)}`);
  lines.push(
    "",
    `  ${c("33", "⚠")} a quick tunnel is public. The code above is the only thing`,
    "    between this URL and keystroke access to every agent here.",
    "    For anything lasting, use a named tunnel behind Cloudflare",
    "    Access — docs/deploy-cloudflare.md",
    "",
    `  ${c("2", "^C to close")}`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/tunnel-display.test.ts`
Expected: PASS

- [ ] **Step 5: Prove the colour test can fail**

Temporarily wrap the paired count in `c("31", ...)` when it is zero. Confirm the
strip-equality assertion still passes (it would — the text is unchanged), then
instead change the zero case to render `c("31", "NONE")` only when `colour` is
true. Confirm the assertion now fails, which is the property being guarded.
Revert.

- [ ] **Step 6: Commit**

```bash
make check && make check-clean && bun test tests/tunnel-display.test.ts
git add src/server/tunnel/display.ts tests/tunnel-display.test.ts
git commit -m "feat: the tunnel's terminal block, colour optional"
```

---

### Task 8: Wiring — two listeners, the child, and shutdown

**Files:**
- Create: `src/server/tunnel/run.ts`
- Modify: `src/server/index.ts`, `src/server/notify/notifier.ts`
- Test: `tests/tunnel-gate-scope.test.ts`, `tests/tunnel-run.test.ts`,
  `tests/tunnel-public-url.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  `interface TunnelDeps` (see Step 3); `serveGated(deps: TunnelDeps): { port: number; stop(): void }`;
  `runTunnel(deps: TunnelDeps): Promise<number>`;
  `Notifier` gains `publicUrlOverride?: () => string | null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tunnel-gate-scope.test.ts` — the regression guard that matters most:

```ts
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { gateMiddleware } from "@server/tunnel/gate";
import { Pairing } from "@server/tunnel/pairing";

/**
 * The gate must exist on the tunnel's listener and NOWHERE ELSE. If it leaks
 * onto 8787, every desk browser and every `make dev` session starts asking for
 * a pairing code, and the cause is not obvious from the symptom.
 */
test("the plain app is ungated; only the wrapped one asks for a code", async () => {
  const routes = (app: Hono) => {
    app.get("/api/agents", (c) => c.json({ agents: [] }));
    return app;
  };

  const plain = routes(new Hono());
  expect((await plain.request("/api/agents")).status).toBe(200);

  const gated = new Hono();
  gated.use("*", gateMiddleware(new Pairing({ now: () => 0 })));
  routes(gated);
  expect((await gated.request("/api/agents")).status).toBe(401);
});
```

Create `tests/tunnel-run.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentStore } from "@server/state/store";
import { COOKIE_NAME, Pairing } from "@server/tunnel/pairing";
import { serveGated } from "@server/tunnel/run";
import { Hub } from "@server/ws/hub";

function harness() {
  const app = new Hono();
  app.get("/api/agents", (c) => c.json({ agents: [] }));
  app.get("/", (c) => c.html("<h1>dashboard</h1>"));
  const pairing = new Pairing({ now: () => 0 });
  const server = serveGated({
    app,
    hub: new Hub({ now: () => 0 }),
    hostId: "dev-box",
    store: new AgentStore("dev-box"),
    pairing,
    port: 0, // ephemeral: the OS picks one, so the suite cannot collide
  });
  return { server, pairing, base: `http://127.0.0.1:${server.port}` };
}

test("the gated listener refuses an unpaired API request", async () => {
  const { server, base } = harness();
  try {
    expect((await fetch(`${base}/api/agents`)).status).toBe(401);
  } finally { server.stop(); }
});

test("the gated listener refuses an unpaired WebSocket upgrade", async () => {
  // The upgrade never reaches app.fetch, so a Hono middleware alone cannot
  // gate it. This asserts the listener's own fetch consults `decide` FIRST.
  const { server, base } = harness();
  try {
    const res = await fetch(`${base}/ws`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(res.status).toBe(401);
  } finally { server.stop(); }
});

test("a paired session reaches the dashboard", async () => {
  const { server, pairing, base } = harness();
  try {
    const r = pairing.attempt(pairing.current().code);
    if (r.kind !== "paired") throw new Error("unreachable");
    const res = await fetch(`${base}/`, {
      headers: { accept: "text/html", cookie: `${COOKIE_NAME}=${r.token}` },
    });
    expect(await res.text()).toContain("dashboard");
  } finally { server.stop(); }
});

test("a navigation with no session gets the pairing form", async () => {
  const { server, base } = harness();
  try {
    const res = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<form");
  } finally { server.stop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tunnel-gate-scope.test.ts tests/tunnel-run.test.ts`
Expected: the scope test PASSES already (it exercises Task 2's middleware);
`tunnel-run` FAILS — `Cannot find module '@server/tunnel/run'`

- [ ] **Step 3: Write the gated listener and the run loop**

Create `src/server/tunnel/run.ts`:

```ts
import type { AgentStore } from "@server/state/store";
import type { Hub, HubClient } from "@server/ws/hub";
import { startTunnel as realStartTunnel, type Tunnel } from "@server/tunnel/cloudflared";
import { clearCookie, decide, pairingPage } from "@server/tunnel/gate";
import type { Pairing } from "@server/tunnel/pairing";
import { human, render, useColour } from "@server/tunnel/display";

export interface TunnelDeps {
  app: { fetch(req: Request): Response | Promise<Response> };
  hub: Hub;
  hostId: string;
  store: AgentStore;
  pairing: Pairing;
  /** 0 lets the OS pick, which is what the tests use. */
  port: number;
  bin?: string;
  deadlineMs?: number | null;
  startTunnel?: typeof realStartTunnel;
  setPublicUrl?: (url: string | null) => void;
  now?: () => number;
}

interface WsData {
  client?: HubClient;
}

/**
 * The second listener: the same app, plus the gate.
 *
 * The gate is applied HERE and not only as Hono middleware because this
 * function upgrades `/ws` itself, before `app.fetch` is ever called — exactly
 * as `index.ts` does for the plain listener. A middleware-only gate would leave
 * the WebSocket, and therefore every agent's live output, ungated.
 */
export function serveGated(deps: TunnelDeps): { port: number; stop(): void } {
  const server = Bun.serve<WsData>({
    port: deps.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const d = decide(req, (t) => deps.pairing.has(t));

      if (d.kind !== "pass") {
        const headers = new Headers({ "cache-control": "no-store" });
        if (d.stale) headers.append("set-cookie", clearCookie());
        if (d.kind === "page") {
          headers.set("content-type", "text/html; charset=utf-8");
          const insecure = new URL(req.url).protocol !== "https:";
          return new Response(pairingPage({ insecure }), { status: 200, headers });
        }
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify({ ok: false, detail: "not paired" }), {
          status: 401,
          headers,
        });
      }

      if (new URL(req.url).pathname === "/ws") {
        const upgraded = srv.upgrade(req, { data: {} });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      }
      return deps.app.fetch(req);
    },
    websocket: {
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
        // Read-only, as on the plain listener.
      },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

/**
 * Own the child, draw the block, and shut both down together.
 *
 * Returns the process exit code: 0 for a shutdown the operator asked for
 * (`Ctrl-C`, or `--for` elapsing), non-zero for a preflight refusal or a
 * `cloudflared` failure. A child that dies on its own is never left as a
 * dashboard serving a URL that no longer resolves.
 */
export async function runTunnel(deps: TunnelDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const start = deps.startTunnel ?? realStartTunnel;
  const gated = serveGated(deps);

  let tunnel: Tunnel;
  try {
    tunnel = await start({ port: gated.port, bin: deps.bin });
  } catch (e) {
    gated.stop();
    // Loud and specific: this is the one failure the operator cannot diagnose
    // from a dashboard, because there is no dashboard to look at.
    console.error(`paddock: could not publish a tunnel — ${(e as Error).message}`);
    return 1;
  }

  deps.setPublicUrl?.(tunnel.url);
  const startedAt = now();
  const deadline = deps.deadlineMs != null ? startedAt + deps.deadlineMs : null;
  const tty = Boolean(process.stdout.isTTY);
  const colour = useColour(process.env, tty);

  let lastCode = deps.pairing.current().code;
  let lastPaired = deps.pairing.pairedCount;

  const block = () =>
    render(
      {
        url: tunnel.url,
        code: deps.pairing.current().code,
        codeExpiresAt: deps.pairing.current().expiresAt,
        paired: deps.pairing.pairedCount,
        startedAt,
        deadline,
        now: now(),
      },
      colour,
    );

  const draw = () => {
    if (tty) {
      // Home, then clear to end of screen: a redraw, not a scroll.
      process.stdout.write(`\x1b[H\x1b[J${block()}\n`);
      return;
    }
    // Not a tty: print only when something an operator cares about CHANGED.
    // Cursor moves in a log file are their own small disaster, and a
    // per-second countdown in one is noise that hides the events.
    const code = deps.pairing.current().code;
    const paired = deps.pairing.pairedCount;
    if (code !== lastCode || paired !== lastPaired) {
      lastCode = code;
      lastPaired = paired;
      console.info(block());
    }
  };

  draw();
  const timer = setInterval(draw, 1000);

  let stopping = false;
  const shutdown = async (code: number): Promise<number> => {
    if (stopping) return code;
    stopping = true;
    clearInterval(timer);
    await tunnel.stop();
    gated.stop();
    deps.setPublicUrl?.(null);
    console.info("\npaddock: tunnel closed");
    return code;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(0).then((c) => process.exit(c));
    });
  }

  const deadlineHit =
    deadline === null
      ? new Promise<"deadline">(() => {})
      : new Promise<"deadline">((r) => {
          setTimeout(() => r("deadline"), deadline - startedAt).unref?.();
        });

  const outcome = await Promise.race([
    tunnel.exited.then((c) => ({ kind: "child" as const, code: c })),
    deadlineHit.then(() => ({ kind: "deadline" as const, code: 0 })),
  ]);

  if (outcome.kind === "child") {
    console.error(`paddock: cloudflared exited ${outcome.code} — the URL is gone`);
    // A child that exits 0 unasked is still a tunnel that vanished.
    return shutdown(outcome.code === 0 ? 1 : outcome.code);
  }
  console.info(`paddock: --for ${human(deps.deadlineMs ?? 0)} elapsed`);
  return shutdown(0);
}
```

- [ ] **Step 4: Thread the in-memory URL through `index.ts`**

Three edits in `src/server/index.ts`.

First, declare the URL above the `createApp` call:

```ts
/**
 * The live quick-tunnel URL, or null. IN MEMORY ONLY, deliberately: it must
 * reach the notifier so a Telegram deeplink points somewhere the phone can
 * open, and it must NEVER be written to settings.json, where `publicUrl` may
 * already hold the real hostname of a named-tunnel deployment.
 */
let tunnelUrl: string | null = null;
```

Second, hoist the `createApp({...})` argument into a named object so the gated
listener can reuse it:

```ts
const appDeps = { store, hub, actions, settings, health: () => ({ /* unchanged */ }), staticDir: process.env.PADDOCK_STATIC_DIR ?? "dist" };
const app = createApp(appDeps);
```

Third, give the notifier the override. In `src/server/notify/notifier.ts`, accept
`publicUrlOverride?: () => string | null` in the options, store it, and at the
one `composeMessage` call site use:

```ts
    const m = composeMessage(a, state, this.#publicUrlOverride?.() ?? s.publicUrl);
```

with a comment saying why:

```ts
  /**
   * A live `paddock tunnel` URL, which wins over the saved `publicUrl` for the
   * life of that run. Not a settings field: `publicUrl` on disk may be the
   * operator's real named-tunnel hostname, and a quick tunnel must not
   * overwrite it to make one notification's link work.
   */
```

Then in `index.ts`'s `new Notifier({...})`, add
`publicUrlOverride: () => tunnelUrl,`.

- [ ] **Step 5: Dispatch the verb**

`runTunnel` needs the app, hub and store, so it is dispatched AFTER they are
built — not with the early verbs. Add to `src/server/index.ts` after
`hub.startHeartbeat()` and the existing `console.info` of the listening URL:

```ts
if (command === "tunnel") {
  // The plain listener above is already bound and behaves exactly as it does
  // for a bare `paddock`. Everything the tunnel adds is a SECOND listener.
  const raw = args.values.get("--for");
  const deadlineMs = raw === undefined ? null : parseDuration(raw);
  if (raw !== undefined && deadlineMs === null) {
    console.error(`paddock: --for ${raw} is not a duration (try 45s, 90m, 2h)`);
    process.exit(1);
  }

  const pre = await preflight({ dir: defaultConfigDir() });
  if (!pre.ok) {
    console.error(pre.message);
    process.exit(1);
  }

  const pairing = new Pairing();
  // Rebuilt WITH `pairing`, because the pairing routes must exist on the app
  // the gated listener serves — and must not exist on the plain one.
  const gatedApp = createApp({ ...appDeps, pairing, tunnelUrl: () => tunnelUrl });
  process.exit(
    await runTunnel({
      app: gatedApp, hub, hostId, store, pairing,
      port: Number(process.env.PADDOCK_TUNNEL_PORT ?? 8788),
      bin: pre.bin,
      deadlineMs,
      setPublicUrl: (u) => { tunnelUrl = u; },
    }),
  );
}
```

`args` is whatever `parseArgs(Bun.argv.slice(2))` was assigned to at the top of
the file; use that existing binding rather than re-parsing. Add the imports:

```ts
import { parseArgs, parseDuration, USAGE } from "@server/cli";
import { preflight } from "@server/tunnel/preflight";
import { runTunnel } from "@server/tunnel/run";
import { Pairing } from "@server/tunnel/pairing";
import { tunnelHint } from "@server/tunnel/preflight";
```

And print the hint beside the existing listening line:

```ts
const hint = command === "tunnel" ? null : tunnelHint(settings.current().publicUrl, false);
if (hint !== null) console.info(hint);
```

- [ ] **Step 6: The publicUrl test**

Create `tests/tunnel-public-url.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifier } from "@server/notify/notifier";
import { SettingsStore } from "@server/settings/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const TUNNEL = "https://quiet-harbor-8f31.trycloudflare.com";
const SAVED = "https://paddock.example.com";

const agent = (): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "blocked", workspaceId: "w1",
  workspaceLabel: "api work", cwd: "/srv/project",
  stateSince: NOW, updatedAt: NOW, acknowledgedAt: null,
});

test("the tunnel URL is used for deeplinks and never saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-tunnel-"));
  const settings = new SettingsStore(dir);
  await settings.load();
  await settings.patch({
    telegram: { token: "1:aa", chatId: "9" },
    notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 } },
    publicUrl: SAVED,
  });

  const sent: unknown[] = [];
  const notifier = new Notifier({
    settings,
    publicUrlOverride: () => TUNNEL,
    send: async (text, replyMarkup) => {
      sent.push({ text, replyMarkup });
      return { ok: true, detail: null };
    },
  });

  // Drive the settle timer exactly as tests/notifier-settle.test.ts does —
  // copy that file's mechanism rather than inventing a second one.
  notifier.observe(agent(), NOW);
  await Bun.sleep(20);

  expect(JSON.stringify(sent)).toContain(TUNNEL);
  expect(JSON.stringify(sent)).not.toContain("paddock.example.com");

  // The operator's real hostname is still exactly what it was on disk.
  const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { publicUrl: string };
  expect(onDisk.publicUrl).toBe(SAVED);
});
```

If `Notifier`'s public method is not `observe`, or the settle timer needs
explicit advancing, mirror `tests/notifier-settle.test.ts` exactly — that file is
the reference for driving this class in a test.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/tunnel-run.test.ts tests/tunnel-gate-scope.test.ts tests/tunnel-public-url.test.ts && make check`
Expected: PASS

- [ ] **Step 8: Prove the WebSocket test can fail**

Temporarily move the `/ws` upgrade block ABOVE the `decide` call in
`serveGated`. Confirm "refuses an unpaired WebSocket upgrade" fails — this is
the exact bug the two-call-site design exists to prevent. Revert.

- [ ] **Step 9: Verify against a real tunnel**

`cloudflared` is installed, so do this once by hand:

```bash
bun src/server/index.ts tunnel --demo
```

Confirm: the block draws and the clocks tick; the URL resolves; an incognito
browser on it shows the pairing form; the printed code pairs; the dashboard loads
with demo agents; the live output updates (proving the WebSocket passed the
gate); a second incognito window still sees the form; `Ctrl-C` closes both
processes. Then confirm the desk listener is untouched:

```bash
curl -sI http://127.0.0.1:8787/ | head -1   # expect a plain 200
```

- [ ] **Step 10: Commit**

```bash
make check && make check-clean && make test
git add src/server tests/
git commit -m "feat: paddock tunnel serves a gated second listener and owns cloudflared"
```

---

### Task 9: "Add a device" in Settings

**Files:**
- Create: `src/web/components/settings/TunnelSection.tsx`
- Modify: `src/web/components/Settings.tsx`, `src/web/styles.css`
- Test: `tests/tunnel-section.test.tsx`

**Interfaces:**
- Consumes: `SettingsView["tunnel"]` from `@shared/types`.
- Produces: `TunnelSection({ tunnel, onInvite })` where
  `tunnel: NonNullable<SettingsView["tunnel"]>` and
  `onInvite: () => Promise<{ code: string; expiresAt: number }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/tunnel-section.test.tsx`, following the harness style of
`tests/prefs-applied.test.tsx`:

```tsx
import { expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TunnelSection } from "@web/components/settings/TunnelSection";

const tunnel = { url: "https://quiet-harbor-8f31.trycloudflare.com", pairedDevices: 2 };
const ok = async () => ({ code: "9T2H-BXQ4", expiresAt: 0 });

test("the paired count is shown", () => {
  render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  expect(screen.getByText("2")).toBeDefined();
});

test("the code is never rendered before it is asked for", () => {
  render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  expect(screen.queryByText("9T2H-BXQ4")).toBe(null);
});

test("add a device reveals a code from the server", async () => {
  render(<TunnelSection tunnel={tunnel} onInvite={ok} />);
  await userEvent.click(screen.getByRole("button", { name: /add a device/i }));
  await waitFor(() => expect(screen.getByText("9T2H-BXQ4")).toBeDefined());
});

test("a failed invite says so rather than showing a stale code", async () => {
  render(<TunnelSection tunnel={tunnel} onInvite={async () => { throw new Error("nope"); }} />);
  await userEvent.click(screen.getByRole("button", { name: /add a device/i }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not/i));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/tunnel-section.test.tsx`
Expected: FAIL — `Cannot find module '@web/components/settings/TunnelSection'`

- [ ] **Step 3: Write the component**

Create `src/web/components/settings/TunnelSection.tsx`, matching
`DeviceSection.tsx`'s markup conventions:

```tsx
import { useState } from "react";
import type { SettingsView } from "@shared/types";
import { Section } from "@web/components/Section";

interface Props {
  tunnel: NonNullable<SettingsView["tunnel"]>;
  onInvite: () => Promise<{ code: string; expiresAt: number }>;
}

/**
 * Present only while a tunnel is running, because `view.tunnel` is null
 * otherwise. A paddock served the ordinary way has nothing to pair.
 *
 * The code is fetched on demand and never rendered before it is asked for: it
 * is a live credential, and a settings screen left open on a desk should not
 * be displaying one.
 */
export function TunnelSection({ tunnel, onInvite }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invite = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode((await onInvite()).code);
    } catch {
      // The old code is cleared: showing a stale one that no longer pairs is
      // worse than showing none.
      setCode(null);
      setError("Could not get a code. Is the tunnel still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Tunnel">
      <div className="row">
        <span>Paired devices</span>
        <strong>{tunnel.pairedDevices}</strong>
      </div>
      <button type="button" onClick={invite} disabled={busy}>
        {busy ? "Getting a code…" : "Add a device"}
      </button>
      {code !== null && (
        <div className="pair-code">
          <code>{code}</code>
          <p>Open this dashboard's URL on the new device and enter that code.</p>
        </div>
      )}
      {error !== null && <p role="alert" className="error">{error}</p>}
    </Section>
  );
}
```

Add `.pair-code code` styling to `src/web/styles.css` beside the other settings
rules — monospace, letter-spaced, sized like the pairing page's input. Any new
colour goes on bare `:root` first, then under `prefers-color-scheme` and
`[data-theme]`, per the project's UI rules.

- [ ] **Step 4: Wire it into `Settings.tsx`**

Import `TunnelSection` and render it above `TelegramSection`, only when the view
has a tunnel:

```tsx
{view?.tunnel != null && (
  <TunnelSection
    tunnel={view.tunnel}
    onInvite={async () => {
      const res = await fetch("/api/pair/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { code: string; expiresAt: number };
    }}
  />
)}
```

- [ ] **Step 5: Flag a stale quick-tunnel `publicUrl`**

The same predicate that keeps the hint alive (Task 6) belongs beside the
`publicUrl` field, and it must show whether or not a tunnel is currently
running: a saved `*.trycloudflare.com` value means every Telegram deeplink
points at a hostname that stopped resolving when that run ended.

Append to `tests/tunnel-section.test.tsx`:

```tsx
import { NotifySection } from "@web/components/settings/NotifySection";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";

test("the predicate is what the UI asks, not a second regex", () => {
  // Guards against the warning growing its own copy of the hostname rule.
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com")).toBe(true);
  expect(isQuickTunnelUrl("https://paddock.example.com")).toBe(false);
});

test("a saved quick-tunnel publicUrl is flagged as stale", () => {
  // Reuse this repo's existing NotifySection harness for the required props —
  // see tests/prefs-applied.test.tsx for the pattern — passing
  // publicUrl="https://quiet-harbor-8f31.trycloudflare.com".
  // ...
  expect(screen.getByText(/changes every time/i)).toBeDefined();
});

test("a real hostname is not flagged", () => {
  // Same harness with publicUrl="https://paddock.example.com".
  // ...
  expect(screen.queryByText(/changes every time/i)).toBe(null);
});
```

In `src/web/components/settings/NotifySection.tsx`, below the `publicUrl` input:

```tsx
{isQuickTunnelUrl(publicUrl) && (
  <p className="hint">
    That is a quick-tunnel URL, and it changes every time
    <code>paddock tunnel</code> runs — so saving it here will point
    notification links at a hostname that has stopped resolving. Leave this
    empty while using <code>paddock tunnel</code>: it fills the link in
    automatically for the life of each run.
  </p>
)}
```

That last sentence is the actionable half: Task 8 already overrides `publicUrl`
in memory, so an operator on the tunnel path should leave the field blank rather
than curating it by hand.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/tunnel-section.test.tsx && make check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/web tests/tunnel-section.test.tsx
git commit -m "feat: add a device from a paired one, and flag a stale tunnel URL"
```

---

### Task 10: The `paddock start` hint and the doctor line

**Files:**
- Modify: `src/server/lifecycle/commands.ts`, `src/server/doctor.ts`
- Test: `tests/lifecycle-start.test.ts` (extend), `tests/doctor.test.ts` (extend)

**Interfaces:**
- Consumes: `tunnelHint` from `@server/tunnel/preflight` (Task 6);
  `findCloudflared` from `@server/tunnel/cloudflared`.
- Produces: `doctorReport` gains a third parameter
  `extra: { cloudflared: string | null }`, defaulting to `{ cloudflared: null }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/doctor.test.ts`:

```ts
test("doctor reports whether cloudflared is present", () => {
  const yes = doctorReport(3, { kind: "answered", protocol: 3 }, { cloudflared: "/somewhere/cloudflared" });
  expect(yes.text).toContain("cloudflared");
  expect(yes.text).toContain("/somewhere/cloudflared");

  const no = doctorReport(3, { kind: "answered", protocol: 3 }, { cloudflared: null });
  expect(no.text).toContain("cloudflared");
  expect(no.text).toMatch(/not installed/i);
  // Absent cloudflared is NOT a herdr problem: install.sh reads this code,
  // so it must not become non-zero over an optional binary.
  expect(no.code).toBe(0);
});

test("the cloudflared line is omitted when herdr is the problem", () => {
  // A protocol mismatch answers with herdr's own message and nothing else;
  // adding an unrelated line to it would bury the finding.
  const bad = doctorReport(3, { kind: "answered", protocol: 2 }, { cloudflared: null });
  expect(bad.code).toBe(1);
  expect(bad.text).not.toContain("cloudflared");
});
```

Append to `tests/lifecycle-start.test.ts`, following that file's existing
`runStart` harness and its injected `log`:

```ts
test("start points at the tunnel when no publicUrl is configured", async () => {
  const lines: string[] = [];
  // Reuse this file's existing successful-start harness, adding:
  //   log: (l) => lines.push(l)
  // and a config dir whose settings.json has no publicUrl.
  // ...
  expect(lines.join("\n")).toContain("paddock tunnel");
});

test("start says nothing about tunnels when publicUrl is set", async () => {
  const lines: string[] = [];
  // Same harness, with publicUrl: "https://paddock.example.com" written first.
  // ...
  expect(lines.join("\n")).not.toContain("paddock tunnel");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/doctor.test.ts tests/lifecycle-start.test.ts`
Expected: FAIL — `doctorReport` takes two arguments

- [ ] **Step 3: Add the doctor line**

In `src/server/doctor.ts`, widen the signature:

```ts
export function doctorReport(
  expected: number,
  probe: DoctorProbe,
  extra: { cloudflared: string | null } = { cloudflared: null },
): DoctorReport {
```

and, in the compatible branch only, before its `return`:

```ts
  // Reported, never scored. cloudflared is optional — `paddock tunnel` needs
  // it and nothing else does, so its absence must not turn a healthy herdr
  // into a non-zero exit that install.sh would read as a broken install. It is
  // also NOT added to the mismatch branch above: that branch is herdr's own
  // message, and an unrelated line would bury the finding.
  lines.push(
    extra.cloudflared === null
      ? "  cloudflared      not installed (only paddock tunnel needs it)"
      : `  cloudflared      ${extra.cloudflared}`,
  );
```

In `runDoctor`, pass `{ cloudflared: findCloudflared() }`, importing it from
`@server/tunnel/cloudflared`.

- [ ] **Step 4: Print the start hint**

In `src/server/lifecycle/commands.ts`, in `runStart`'s success path, after the
line reporting the pid and URL:

```ts
  const hint = tunnelHint(publicUrl, true);
  if (hint !== null) log(hint);
```

`runStart` does not read settings today. Load `publicUrl` with the store it
already has a directory for — `const s = new SettingsStore(dir); await s.load();
const publicUrl = s.current().publicUrl;` — and keep using the injected `log` so
the test can capture the output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/doctor.test.ts tests/lifecycle-start.test.ts && make check`
Expected: PASS

- [ ] **Step 6: Prove the exit-code test can fail**

Temporarily change the missing-`cloudflared` branch to `return { code: 2, ... }`.
Confirm "Absent cloudflared is NOT a herdr problem" fails. Revert.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean && make test
git add src/server tests/
git commit -m "feat: doctor reports cloudflared, and start points at the tunnel"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/deploy-cloudflare.md`, `docs/gotchas.md`, `docs/settings.md`,
  `README.md`

**Interfaces:** none.

- [ ] **Step 1: The quick-tunnel section**

Add to `docs/deploy-cloudflare.md`, as a new section before "Everyday use":

```markdown
## Quick tunnels: `paddock tunnel`

`paddock tunnel` publishes the dashboard on a Cloudflare **quick tunnel** — an
ephemeral `*.trycloudflare.com` hostname, no domain required. It exists so that
trying paddock from a phone does not require the setup above.

**A quick tunnel cannot have an Access policy in front of it.** Access
applications are keyed by a domain in your own Cloudflare account, and
`trycloudflare.com` is Cloudflare's. Nothing in the Zero Trust dashboard can
attach a policy to a hostname you were lent. That is why `paddock tunnel`
carries its own pairing gate: a short code, shown on the terminal, exchanged
once per device for a session cookie. Without it, publishing a quick tunnel in
front of paddock is precisely the plain-`200` failure §3 above describes.

Take the named-tunnel path above for anything lasting. It has identity, policy
and audit logging; the pairing code has none of those — it is a floor that keeps
"trying paddock" from meaning "publishing an open dashboard".

The URL changes every time the command runs, so a home-screen icon saved from
one run will not work after the next, and a Telegram message sent before a
restart carries a link that no longer resolves.
```

- [ ] **Step 2: Three gotchas**

Add to the appropriate tables in `docs/gotchas.md`:

- **`Secure` cookies never arrive over `http://127.0.0.1:8788`.** The pairing
  cookie is `Secure`, so browsing the gated port directly can never pair — the
  port looks broken while behaving correctly. The pairing page detects a
  plaintext origin and says so. Use the tunnel URL.
- **A `Host`-header exemption is not a gate.** `cloudflared` connects over
  loopback like any local client, so a tunnel request is indistinguishable from
  a desk request at the socket, and the only differing header is one the remote
  client sets. `Host: localhost` through the tunnel would take the exempt path.
  This is why the gate lives on a second listener.
- **Two paddocks against one herdr notify twice.** Each has its own `Notifier`,
  so every blocked agent buzzes the phone once per process. `paddock tunnel`
  refuses to start while a detached instance is running for this reason, not
  because of the port.

- [ ] **Step 3: README and settings docs**

In `README.md`, beside the existing "paddock stays on `127.0.0.1`" paragraph,
add one sentence — keeping the authenticating-tunnel advice primary:

```markdown
To try it from a phone without setting any of that up, `paddock tunnel`
publishes a temporary Cloudflare quick tunnel gated by a one-time pairing code.
It is a try-it path, not a deployment: a quick tunnel cannot have Cloudflare
Access in front of it, so the code is the only gate there is.
```

In `docs/settings.md`, document that `publicUrl` is overridden in memory for the
life of a `paddock tunnel` run and never written, and that the Tunnel section of
Settings appears only during such a run.

- [ ] **Step 4: Verify and commit**

```bash
make check-clean && make test
git add docs README.md
git commit -m "docs: what a quick tunnel is, and three traps around its gate"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/design/2026-08-20-quick-tunnel-design.md` maps to a task: the gate
rationale and decision-3 scoping → Task 2; the rejected `Host` exemption →
Tasks 2 and 11; command surface and preflight, including the install guide →
Tasks 5, 6; URL extraction and child lifetime → Task 4; `publicUrl` in memory →
Task 8; `--for` and the exit codes → Tasks 5, 8; alphabet, TTL, burn cap →
Task 1; cookie attributes, `Max-Age`, no `Domain` → Tasks 1, 2; restart and
stale cookies → Task 2; adding a device → Tasks 3, 9; terminal output, colour
and TTY → Task 7; discoverability and the doctor line → Tasks 6, 8, 10; the
fixture rule → Global Constraints and every test; documentation → Task 11.

The spec's **accepted burn-loop limitation** is behaviour-as-specified rather
than a task: `Pairing.attempt` reissues on the fifth wrong guess (Task 1), the
display reflects the new code within a second (Task 7), and the limitation is
recorded in the spec. Nothing further implements it.

**Naming consistency.** `Pairing.has` / `attempt` / `current` / `reissue` /
`pairedCount`, `decide`, `setCookie` / `clearCookie`, `pairingPage`,
`gateMiddleware`, `extractUrl`, `installHint`, `findCloudflared`, `startTunnel`,
`preflight`, `tunnelHint`, `render` / `human` / `useColour`, `serveGated` /
`runTunnel` are each defined once and referenced under the same name after.

**One predicate, three consumers.** `isQuickTunnelUrl` in `@shared/quick-tunnel`
is the only definition of the hostname shape: `extractUrl` (Task 4) matches
`cloudflared`'s output with it, `tunnelHint` (Task 6) uses it to refuse to treat
a saved quick-tunnel URL as a deployment, and `NotifySection` (Task 9) uses it to
flag one as stale. A second copy anywhere is a defect, not a convenience —
`tests/quick-tunnel.test.ts` pins the lookalike-suffix case that a duplicate
would get wrong.

**Three known ripples**, recorded rather than hidden:

- Task 3 makes `SettingsView["tunnel"]` a required field, so hand-built
  fixtures in existing settings tests will fail to typecheck until each gains
  `tunnel: null`. Expect a handful of one-line edits.
- Task 5 makes `values` a required field on `ParsedArgs`; anything constructing
  one by hand needs `values: new Map()`.
- Task 8 adds `publicUrlOverride` to `Notifier` and reads `settings.current()`
  in `index.ts` for the hint. Both are additive, but run `make test` rather
  than only the new files — `tests/notifier*.test.ts` are the ones to watch.
