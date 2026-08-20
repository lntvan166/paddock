# Quick tunnel and device pairing — design

`paddock tunnel` publishes the dashboard on a Cloudflare **quick tunnel** and
gates it behind a short pairing code, so that trying paddock from a phone does
not require owning a domain.

It is the **try-it** path, deliberately second-best. A named tunnel behind
Cloudflare Access (`docs/deploy-cloudflare.md`) remains the answer for anything
lasting, and this command says so on screen every time it runs.

---

## Why a gate is not optional here

**A quick tunnel cannot have Cloudflare Access in front of it.** Access
applications are keyed by a domain in your own account; `trycloudflare.com` is
Cloudflare's. So `cloudflared tunnel --url` in front of paddock — which binds
loopback and has no authentication of its own (`docs/decisions.md`, decision 3)
— publishes an unauthenticated dashboard with keystroke access to every agent on
the machine. That is precisely the plain-`200` outcome that
`docs/deploy-cloudflare.md` §3 instructs the operator to read as the failure
mode rather than as success.

The gate and the tunnel therefore ship together or neither ships. There is no
version of this command that is useful without one.

## Relationship to decision 3

Decision 3 forbids paddock-side authentication, and its stated mechanism is a
shared secret that also `401`s `/sw.js`, silently disabling the service worker
and therefore push.

This design does not reintroduce that mechanism, for three separate reasons:

1. **The credential is a same-origin cookie, not a token in a URL or header.**
   A browser attaches it to every same-origin request the page makes *and* to
   the WebSocket upgrade, which is the exact property decision 3 observes a
   shared secret lacks.
2. **The gate lives on its own socket.** `127.0.0.1:8787` stays exactly as it is
   today — unauthenticated, loopback-only. The gate is mounted on a second
   listener that exists only while `paddock tunnel` runs.
3. **paddock has no service worker.** Web Push was superseded by Telegram in v2
   (`docs/roadmap.md`), so `/sw.js` does not exist to be broken. Should push
   ever return, note that `docs/gotchas.md` already records the same hazard for
   Access itself — an expired session turns a service-worker fetch into an HTML
   login page — so this gate introduces no constraint that the recommended
   deployment does not already impose.

Decision 3 continues to govern the default listener without amendment. A new
decision records the scope of this exception, and decision 3 gains a forward
pointer so a later reader does not take it as absolute and conclude this
command violates it.

## Rejected: exempting loopback by `Host`

The obvious single-port design is "gate requests that arrived through the
tunnel". It does not work. `cloudflared` connects to paddock over loopback like
any local client, so a tunnel request and a desk request are indistinguishable
at the socket; the only thing that differs is the `Host` header, which the
**remote** client controls. A request through the tunnel carrying
`Host: localhost` would take the exempt path.

Two listeners make the gate a property of the socket a request arrived on.
There is no header to trust, and the desk workflow, `make dev`, and every
existing test are untouched.

---

## Command surface

```
paddock tunnel [--for <duration>] [--demo]
```

One process, two listeners, one child:

```
  127.0.0.1:8787   the dashboard, exactly as `paddock` serves it today
  127.0.0.1:8788   the same Hono app + pairing middleware   <- cloudflared
  cloudflared      child process, --url http://127.0.0.1:8788
```

`PADDOCK_TUNNEL_PORT` overrides `8788`; a port already in use reports through
the existing `portInUseMessage`.

`tunnel` is a **mode of serving**, not a sidecar attached to a running instance.
One process cannot add a listener to another's app, and a second paddock against
one herdr would run a second `Notifier` — every blocked agent would buzz the
phone twice. So:

- **`paddock tunnel` refuses to start when a detached instance is running.**
  `lifecycle/state.ts` already answers that question. The message names the
  double-notification hazard; discovering it by phone at 2am is worse.
- **`--demo` composes**, so the dashboard can be shown over a tunnel with
  invented fixture agents and no live herdr at all.

### Preflight

Cheapest first, and nothing bound or opened until all three pass — the ordering
`index.ts` already comments on for `help` / `update` / `status`: a command that
is going to fail must not start a server on the way to failing.

1. A detached instance is running → refuse, explaining why.
2. `cloudflared` is not on `PATH` → refuse with the platform's install line.
3. herdr is unreachable (unless `--demo`) → the existing startup-error path.

`cloudflared` is never auto-downloaded. `paddock update` fetches paddock; a tool
that quietly installs a network daemon is a different kind of tool.

```
paddock: cloudflared is not installed

  paddock tunnel needs Cloudflare's tunnel client to publish a URL.

    brew install cloudflared

  other platforms: https://developers.cloudflare.com/cloudflare-one/
                   connections/connect-networks/downloads/

  then run paddock tunnel again.
```

The install line is chosen from `process.platform`. `paddock doctor` gains one
line reporting whether `cloudflared` is present — the command that answers "is
this machine ready" should answer it for the tunnel too.

### The public URL

Read from `cloudflared`'s own output, never constructed. If that parse fails the
command fails loudly rather than printing a guess. `cloudflared`'s stdout and
stderr are forwarded to paddock's log; if it exits on its own, paddock reports
its exit status and exits non-zero rather than serving a URL that no longer
resolves. "Never swallow errors" applies to a child process.

`publicUrl` is set **in memory** for the tunnel's lifetime, so Telegram
deeplinks point somewhere the phone can reach, and is never written to settings —
that field may already hold the real hostname of a named-tunnel deployment.

### Lifetime

A quick tunnel has no lifetime of its own: it lives as long as `cloudflared`
holds its connection. Cloudflare documents no TTL, only that there is no uptime
guarantee. So paddock imposes none either — the tunnel is the operator's to end,
with `Ctrl-C`. `--for <duration>` is an opt-in deadline for those who want one.

`--for` accepts `<n>s`, `<n>m` or `<n>h`; anything else is a parse error rather
than a default, since a mistyped deadline that silently becomes "none" is the
one outcome the flag exists to prevent. When set, the display gains a
`closes in 1h 12m` line and paddock shuts down as if `Ctrl-C` had been pressed.

`Ctrl-C` sends `SIGTERM` to `cloudflared`, `SIGKILL` after a short grace, closes
both listeners and prints `tunnel closed`.

Exit codes: `0` for any shutdown the operator asked for (`Ctrl-C`, or `--for`
elapsing), `1` for a preflight refusal or a `cloudflared` failure.

---

## The pairing gate

The gated listener wraps **the same Hono app**, so no route exists twice. One
middleware, mounted only on that listener:

```
  no session cookie?
    |- navigation (Accept: text/html)  -> 200, self-contained pairing page
    |- /api/*                          -> 401 JSON
    |- WebSocket upgrade               -> 401, no upgrade
    \- everything else (JS, icons)     -> 401
```

The pairing page is inline HTML with **zero asset dependencies** — no bundle, no
stylesheet, no icon. That is what lets every real asset stay behind the gate
rather than carving out an unauthenticated static path that then has to be
audited.

**The gate cannot be only a Hono middleware.** `index.ts` intercepts
`/ws` in `Bun.serve`'s `fetch` and calls `server.upgrade` *before* `app.fetch`
is reached, so a middleware mounted on the app never sees the upgrade at all.
The decision is therefore a pure function — `decide(req, has)` — called from two
places: the Hono middleware for ordinary requests, and the gated listener's own
`fetch` before it upgrades anything. One rule, two call sites, no possibility of
them disagreeing about what a valid session is.

`hub.ts` still learns nothing about pairing: the refusal happens before the hub
is reached, so the WebSocket is gated without a line changing in the transport
layer, and the dependency direction in `docs/architecture.md` holds.

### The code

Eight characters of Crockford base32 — `I`, `L`, `O` and `U` excluded so it
cannot be mistyped — displayed as `4F7K-QP2M`. Roughly 40 bits.

Entropy is not the control; the attempt cap is. **Five wrong guesses burn the
code** and a fresh one is minted and printed. Comparison is timing-safe, and
case-insensitive after the dash is stripped.

The counter is **per code, not per client**. Per-IP counting buys nothing here:
an attacker rotates addresses trivially, and there is no account to lock.

**Accepted limitation:** an attacker who can reach the URL can therefore burn
codes in a loop, and the operator may find the code changing faster than they can
type it. This is a denial of *pairing*, not a bypass — no wrong guess ever mints
a session. The mitigation is that it is loud: burns print a warning, and a burst
of them means someone has the URL and the operator should close the tunnel. A
quick tunnel is the try-it path; an operator under attack should be on the named
tunnel.

**A live code always exists**, re-minted every 10 minutes whether or not
anything is paired. Codes stay short-lived, and adding a device later is just
reading the current one. Expiry never tears the tunnel down.

### The exchange

`POST /pair` with `{"code": "..."}`, subject to the existing `strictJsonBody`.
Decision 12's reasoning applies unchanged and more sharply, since this route is
reachable from the public internet by design.

Success mints 32 random bytes and sets:

```
Set-Cookie: paddock_pair=<token>; HttpOnly; Secure; SameSite=Lax; Path=/;
            Max-Age=2592000
```

`Max-Age` is load-bearing, not tidiness. Without it this is a session cookie
that dies when the browser restarts — and a tunnel that has been up for days
would silently log the phone out at the moment its owner is furthest from the
terminal holding the code.

**The `Domain` attribute is never set**, which makes the cookie host-only. This
is security, not a default worth leaving to chance: `trycloudflare.com` is a
suffix shared with every other quick tunnel in the world, so a cookie scoped to
`.trycloudflare.com` would be attached to strangers' tunnels.

Sessions live in a `Set` in memory. No store, no expiry sweep, no revoke
command: ending the process is the revoke, and it changes the URL too, which is
what is actually wanted after a device is lost.

### Restart, and a cookie the server has never heard of

A restart mints a new session set, and a quick tunnel restart also mints a new
random hostname. Those two together mean the ordinary case cannot strand anyone:
the phone is on a different origin, the host-only cookie does not apply there, so
it gets the pairing page and the current code. There is no stale-code state to be
in.

The case that *can* strand a device is a stable hostname over the gated port —
an operator who points their own named tunnel at `8788` rather than at `8787`.
The origin survives the restart; the session set does not. The browser then
arrives holding a token the server has never issued.

**An unrecognised cookie must therefore be indistinguishable from no cookie**:
navigations get the pairing page, `/api/*` and upgrades get `401`, and the
response clears the dead cookie with `Max-Age=0` on its way past. Treating an
unknown token as "authenticated, but wrong" would `401` the pairing page itself,
leaving a device locked out for thirty days with no route to the form that would
fix it. `tunnel-pairing.test.ts` covers this directly — a forged token and an
expired-session token both land on the pairing page, not on a `401`.

Two consequences of a restart that paddock cannot fix, and so states plainly
rather than letting the operator discover them:

- **The previous URL is dead.** A home-screen icon or saved tab pointing at it
  gets Cloudflare's error page, not paddock. The startup banner says the URL
  changes on every run.
- **Telegram messages sent before the restart carry the dead link.** `publicUrl`
  is in-memory (see above), so messages sent afterwards carry the new one, but
  history is not rewritten.

**Consequence to record in `docs/gotchas.md`:** `Secure` means the cookie is
only accepted over HTTPS, so browsing `http://127.0.0.1:8788` directly can never
pair. That is correct — the gated listener exists for the tunnel — but it makes
the port look broken when poked locally, so the pairing page says so when it
sees a plaintext origin.

### Adding a device

Two sources for a code, because after several days the assumption that the
operator is at their desk is the weaker one:

1. **The terminal**, which always shows a live code.
2. **An already-paired device.** Settings gains a Tunnel section showing the
   paired-device count and an **add a device** control, which calls a gated
   route — `POST /api/pair/invite`, which needs a session and therefore sits
   inside the gate like every other `/api/*` route — and displays a fresh code
   with its countdown. The trusted device in your hand vouches for the next one;
   no desk access needed.

```
Settings -> Tunnel

  paired devices        2

  [ add a device ]
        |
  code  9T2H-BXQ4
  expires in 9m 51s
  enter this at the same URL on the new device
```

The section is present only while a tunnel is running. On `8787` the route is
open like every other route — that listener is trusted by locality.

**Non-goal: per-device revocation.** Losing a device is answered by restarting
the tunnel, which drops every session *and* changes the URL. A partial revoke
that leaves the URL live is the weaker action, and two ways to revoke is how an
operator ends up believing they have done it.

---

## Terminal output

Redrawn in place only when stdout is a TTY; piped or redirected it prints plain
periodic lines, because ANSI cursor moves in a log file are their own small
disaster. Colour — the first in `src/server/` — is TTY-only, honours `NO_COLOR`,
and is applied to the `✓`/`⚠` markers and the URL. It never carries meaning
on its own, so a piped log reads identically.

```
  ✓ tunnel up · 23m elapsed
    https://quiet-harbor-8f31.trycloudflare.com

    code 4F7K-QP2M · expires in 6m 12s
    paired: 1 device

  ⚠ a quick tunnel is public. The code above is the only thing
    between this URL and keystroke access to every agent here.
    For anything lasting, use a named tunnel behind Cloudflare
    Access — docs/deploy-cloudflare.md

  ^C to close
```

`paired: 1 device` is a security affordance, not a status nicety: a pair line
the operator was not expecting means someone else typed the code. Silence on
pairing is how that goes unnoticed.

### Discoverability

Both hints are suppressed when `publicUrl` is configured — an operator already
running the named-tunnel path has solved this and must not be nudged toward the
worse option.

```
$ paddock
paddock 0.6.1 · http://127.0.0.1:8787
  herdr connected · 6 agents
  to reach this from your phone: paddock tunnel

$ paddock start
paddock started · pid 48213 · http://127.0.0.1:8787
  for phone access, stop it and run paddock tunnel
```

`paddock start`'s wording admits the stop, because the two are mutually
exclusive.

---

## Files

```
src/server/tunnel/cloudflared.ts   spawn, URL extraction, child lifecycle
src/server/tunnel/pairing.ts       code generation, session set, middleware
src/server/tunnel/run.ts           preflight, wiring, display loop
```

`tunnel/` is the outermost layer, alongside `index.ts`: it imports downstream
and nothing imports it. `cloudflared.ts` knows nothing about paddock.

Touched: `cli.ts` (the verb, `--for`, `USAGE`), `index.ts` (dispatch, the two
hints), `doctor.ts` (the `cloudflared` line), `routes.ts` (`POST /pair`, the
gated invite route), `Settings.tsx` plus a new `settings/TunnelSection.tsx`,
`shared/types.ts` (tunnel view fields).

## Tests

- `cli.test.ts` — the verb, `--for` parsing and its rejections, `USAGE`
- `tunnel-pairing.test.ts` — no cookie serves the page for navigations and
  `401`s `/api/*`, assets and the upgrade; a wrong code; five wrong guesses burn
  the code; success sets `HttpOnly; Secure; SameSite=Lax; Max-Age`; the cookie
  then works
- `tunnel-code.test.ts` — alphabet excludes `I L O U`, length, format
- `tunnel-preflight.test.ts` — detached-instance refusal via an injected probe,
  the per-platform install guide, herdr unreachable
- `tunnel-cloudflared.test.ts` — URL extraction from captured sample output,
  **and the no-URL case failing loudly**; child exit produces a non-zero exit
- `tunnel-gate-scope.test.ts` — a request to the plain `8787` listener needs no
  cookie. The regression guard that matters most: the gate leaking onto the desk
  port is the bug that would make every dev loop mysterious
- `tunnel-public-url.test.ts` — the notifier composes links with the tunnel URL,
  and `settings.json` on disk is byte-identical afterwards
- `tunnel-invite.test.ts` — the invite route needs a session on the gated
  listener and is open on the plain one
- `tunnel-hints.test.ts` — hint present when `publicUrl` is null, absent when set
- colour — `NO_COLOR` and a non-TTY stdout emit no escape bytes

**Fixture rule.** Quick-tunnel hostnames from the internet may be live. Every
doc, test and screenshot uses an invented one (`quiet-harbor-8f31`), per
CLAUDE.md: nobody notices that a demo fixture was named after something real.

## Documentation

- `docs/decisions.md` — a new decision scoping this exception; decision 3 gains a
  forward pointer to it.
- `docs/deploy-cloudflare.md` — a quick-tunnel section stating plainly that
  Access cannot sit in front of one, and why the named tunnel is still the
  answer.
- `docs/gotchas.md` — three entries: the `Secure`-cookie-on-plaintext-`8788`
  confusion, the `Host`-header exemption that was rejected, and the
  double-notifier hazard behind the refusal to run alongside a detached
  instance.
- `README.md` — a mention that keeps "put an authenticating tunnel in front"
  primary.
