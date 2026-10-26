# Tailscale: reach paddock from the operator's own devices over their tailnet

Status: approved design, 2026-10-26.

## Why

On a machine with no named Cloudflare tunnel (a laptop, typically) the only way
to reach paddock from a phone today is `paddock tunnel`: a quick tunnel on a
`*.trycloudflare.com` hostname. That link dies. When the laptop sleeps, the
quick tunnel is dropped on Cloudflare's side and its hostname stops resolving
(observed: NXDOMAIN from public resolvers while the local `paddock tunnel`
process still reported itself healthy). Every death means a new URL, a new
Home Screen icon, a new pairing.

The operator already runs Tailscale on every machine they own and on their
phone, always on. A tailnet gives what the quick tunnel cannot: a hostname that
never changes, identity on every request, and no third party on the path.

Success is: one command on each machine prints a QR; the phone scans it once,
adds it to the Home Screen, and from then on the icon opens that machine's
paddock whenever the machine is awake — across sleep, reboots, network changes
and paddock restarts — with no login and no pairing code.

## Goals

- `paddock tailscale` publishes the running paddock on the machine's tailnet
  HTTPS name (`https://<machine>.<tailnet>.ts.net`) via `tailscale serve`, and
  prints the URL and a QR.
- Only the operator's own Tailscale **user** gets in. Other users on the same
  tailnet (the operator's tailnet has another person's devices on it) and
  tagged devices get `403`. Identity comes from Tailscale; paddock adds no
  token or login of its own.
- Everything paddock serves works over it: dashboard, writes, WebSocket, web
  push, and `/mcp` when `bridge.enabled` is on.
- It survives restarts: paddock's service brings the tailnet listener back on
  boot, and `tailscale serve --bg` keeps Tailscale's side.
- `paddock status` shows it. `paddock tailscale off` removes it.
- Works on Linux and macOS.

## Non-goals

- **Funnel.** Never. Funnel publishes to the public internet; nothing in this
  feature may call `tailscale funnel` or enable it.
- **Editing the tailnet's ACLs.** Access control is the identity check below,
  done by paddock, so no admin-console change beyond enabling HTTPS
  certificates is required.
- **Replacing Cloudflare.** The Cloudflare named tunnel + Access path and the
  quick tunnel stay as they are; this is a third way in, side by side.
- **Telegram links.** They keep using `publicUrl`. Pointing them at the ts.net
  URL is a separate choice the operator can make by setting `publicUrl`.
- **Fixing the quick tunnel's silent death after sleep.** A real bug, tracked
  separately; this feature is the alternative, not the fix.

## Anti-goals: failure even if it technically works

- A device belonging to another Tailscale user on the tailnet can open the
  dashboard or call any route, including by forging the identity header.
- The tailnet URL serves a **read-only** dashboard: GETs work, every button and
  the WebSocket fail with `host-not-allowed`. (This is exactly what happens
  today if the ts.net host is not in the same-origin allowlist — see below.)
- The default `127.0.0.1:8787` listener starts requiring anything, or starts
  trusting identity headers. Local callers, Cloudflare's tunnel and the MCP
  bridge's Access path must behave exactly as before.
- Anything real — tailnet name, machine names, login names — lands in this
  public repo, including tests, fixtures and this document.

## The trust decision, and how it differs from the MCP bridge

The operator decided: **every device signed in as their own Tailscale user is
trusted exactly like the phone in their hand**, including answering permission
prompts. That means a Claude Code session on another of their machines, using
the MCP bridge over the tailnet, *can* reach `/api/agents/:id/key` and approve
a prompt (by plain HTTP, not through any MCP tool). The bridge's guarantee
"a remote session never answers a permission prompt" (decision 34) therefore
holds **only on the Cloudflare path**, where Access scopes the service token to
`/mcp`. The decision record must say this plainly.

Identity is per **user**, not per device. The allowed user defaults to the user
who owns the machine paddock runs on (read from `tailscale status --json`), and
can be overridden.

## How it works

### A second, identity-gated listener

paddock gains a **tailnet listener** on loopback (default `127.0.0.1:8789`,
overridable by env like `PADDOCK_TUNNEL_PORT` is today). `tailscale serve`
forwards the machine's tailnet HTTPS 443 to it. This mirrors decision 13, where
the quick tunnel's pairing gate lives on its own socket so the default listener
stays untouched.

On the tailnet listener, every request — including `/sw.js`, the app shell and
the `/ws` upgrade — must carry `Tailscale-User-Login` equal to the allowed
login. Otherwise `403` with a one-line reason; a missing header (tagged device,
or something that is not `tailscale serve`) is also `403`. The check runs
before routing. Nothing on the default listener reads these headers.

Why a separate listener rather than checking the header on 8787: on 8787 the
header would be trusted from any local caller and from cloudflared's
connection, i.e. from anyone on the Cloudflare path who sends it. On the
tailnet listener the only intended client is `tailscale serve`.

The app served on the tailnet listener is the full app (the same one 8787
serves, including `/mcp` gated by `bridge.enabled`), not the pairing-gated app.

**Must be verified empirically before it is relied on, not taken from docs:**
that `tailscale serve` removes or overwrites a `Tailscale-User-Login` header
sent by the client. Test: from a device of a *different* user (or a tagged
device), send the header with the operator's login and confirm paddock sees
the caller's real identity or none. If serve passes client-supplied values
through, this design is unsafe as written and must come back for a decision.
Also record what serve sends for a request from the serving node itself.

### Same-origin allowlist

**The tailnet listener gets its own allowlist: the shared list plus the ts.net
host.** The shared list that 8787 and the other listeners use is NOT changed.
(Designer's call.) Adding the ts.net host to the shared list would be wrong: an
empty list means "check off" (decision 17), so an operator on a Cloudflare named
tunnel with no `publicUrl` would see the check switch on the moment they enable
Tailscale, and their Cloudflare hostname would turn read-only. This departs from
decision 17's "one list for every consumer", and the new decision must say why:
the tailnet listener is a separate, identity-gated door, and its extra host is
meaningful only there. The same thunk still feeds both, the tailnet listener
just appends one host.

So writes and `/ws` from `https://<machine>.<tailnet>.ts.net` pass `hostAllowed`
on the tailnet listener. `tailscale serve` must preserve the original `Host` header
for `sameOrigin` to pass — verify this in the same experiment; if it does not,
the fix is on the tailnet listener (restore Host from `X-Forwarded-Host`
there only), never a relaxation of the origin check.

### Persistence: a setting, owned by the service

The tailnet listener belongs to the long-running paddock (the `paddock local`
user service), not to the one-shot CLI. A new settings group records it, e.g.:

```json
"tailscale": { "enabled": true, "login": "operator@github", "host": "dev-box.example-tailnet.ts.net" }
```

**As built:** the group became its own file, `<configDir>/tailscale.json`,
not a group in `settings.json`. The service keeps `settings.json` in memory and
rewrites it whole on every UI save, so a CLI write inside it would be silently
lost. A separate file also makes "the API cannot change it" structural, since
no route knows it. The service reads it at startup and the CLI restarts the
service after writing it, which is the "via restart" choice below.

**Only the `paddock local` service binds the tailnet listener** (designer's
call). A foreground `paddock`, `paddock tunnel`, or a second build reading the
same `settings.json` does not, even with the setting on. Otherwise every extra
process would race for 8789, and only the service survives a reboot anyway.
`paddock tailscale` preflight refuses when paddock is not running as the
service, and says to run `paddock local`. How a process knows it is the
service (an env var set in the unit/plist, say) is left to the builder.

On startup, the service binds the tailnet listener if `tailscale.enabled`. A
failed bind (port taken) is logged loudly and reported by `status`. It does not
stop the service, because 8787 is the product. Whether enabling takes effect
live or via a service restart is left to the builder. The operator-visible
result must be that `paddock tailscale` finishes with the URL working.

**`paddock stop` and `paddock local`** (designer's call, following decision
33's "stop means nothing comes back"): `stop` also removes paddock's
`tailscale serve` config but leaves the setting, so `local` re-applies the
serve config when `tailscale.enabled` and the operator gets the same URL back.
`paddock tailscale off` is the only thing that clears the setting.

**The `tailscale` group is not writable through `PUT /api/settings`** (designer's
call). `tailscale.login` decides who gets in, so only the CLI changes it, by a
route the CLI alone uses on loopback, or by writing the file while it holds the
service. The builder picks which. The API refuses the key, so the group is
reported in `GET` but not patchable. There is no Settings-screen section in
this feature. Validation follows the existing settings rules (strict keys, typed
values), and `login` must be non-empty when enabled.

**Docker (`make up`) is out of scope** (designer's call). `tailscale serve` on
the host cannot reach a loopback listener inside the container, and binding a
header-trusting listener off loopback is exactly what must never happen.
Preflight refuses inside a container with one line saying so, and the docs say
it too.

### `paddock tailscale` (and `off`)

A new CLI verb, read-only-verb style: it does not open a herdr socket or bind
paddock's port itself. Steps:

1. **Preflight**, each failure printing what is wrong and the fix:
   - `tailscale` binary found. On macOS also look for the app bundle's CLI
     (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`), since the
     App Store / standalone app does not put `tailscale` on `PATH`.
   - Logged in and running (`tailscale status --json`, `BackendState`).
   - HTTPS certificates enabled for the tailnet (`CertDomains` non-empty);
     otherwise point at admin console → DNS → HTTPS Certificates.
   - paddock is running as the `paddock local` service; otherwise say to run
     `paddock local` first.
   - Something else already on the node's serve port 443 → refuse and show
     `tailscale serve status` rather than overwrite it.
2. Read the machine's DNS name and owner login from `tailscale status --json`.
   A `--login <name>` flag overrides the owner (for a machine whose owner is a
   different Tailscale user than the operator).
3. Write the `tailscale` setting to the running paddock (settings API).
4. `tailscale serve --bg --https=443 http://127.0.0.1:<tailnet port>`.
5. Verify: an HTTPS GET of `https://<host>/api/health` returns paddock's health
   JSON. If the request from the node itself carries no identity (see the
   experiment above), verify via a route or probe that does not need identity,
   but the verification must prove the ts.net name reaches the tailnet
   listener — not merely that 8787 is up.
6. Print `✓ tailscale — https://<host>` and the QR (reuse `qrMatrix` +
   `qrLines`, gated by `wantsQr` as `paddock pair` does), plus one line on what
   to do on the phone: open it, Add to Home Screen, enable push in Settings.

Running it again when already enabled is not an error: re-verify and reprint.

`paddock tailscale off`: `tailscale serve --https=443 off` (only if the serve
config is the one paddock set), clear the setting, stop the listener.

### `paddock status`

One block in the existing style, silent when disabled:

```
✓ tailscale — https://dev-box.example-tailnet.ts.net
    allows operator@github · listener 127.0.0.1:8789
```

A ✗ line when enabled in settings but the listener is not up or
`tailscale serve` no longer points at it (someone ran `tailscale serve reset`).

### Push and the Home Screen

Each origin is its own PWA on iOS. The ts.net URL needs its own Home Screen
icon and its own push subscription; the server just stores another endpoint
(subscriptions are keyed by endpoint, not origin). Notification taps open a
relative URL, so they land on whichever origin registered. No server change
expected; the builder should confirm a push subscribed over ts.net delivers.

### MCP bridge over the tailnet

With `bridge.enabled` on, another of the operator's machines registers it with
no headers:

```bash
claude mcp add --transport http paddock-dev-box https://dev-box.example-tailnet.ts.net/mcp
```

`docs/deploy-cloudflare.md`'s MCP section stays; a short tailnet variant goes
next to it with the trust caveat above.

## Docs and records

- New decision in `docs/decisions.md`: Tailscale identity as an authenticating
  front on its own listener; per-user allow; the bridge guarantee scoped to the
  Cloudflare path; Funnel never.
- `docs/running-locally.md`: replace the one-line Tailscale mention with the
  command and the phone steps.
- `docs/settings.md`: the `tailscale` group.
- `README.md`: mention the option where remote access is introduced.

## Testing

- Unit: the identity gate (allowed login → through; other login, missing
  header, empty login → 403, including on `/ws` upgrade and `/sw.js`); the
  allowlist includes the ts.net host only when enabled; settings validation;
  preflight messages per failure; `status` output in each state; the 8787
  listener unchanged with identity headers present (they must grant nothing).
- `tailscale` is spawned through an injectable runner (the `spawnRun` pattern),
  so tests never need a real tailnet.
- Live, once, by the builder: the header-forging experiment, Host
  preservation, and the phone end to end (open, a write, the WebSocket, push).
  Fixtures and docs use `dev-box`, `example-tailnet`, and the login
  `operator@github` (a real Tailscale login shape that the public-repo scanner
  does not read as an email address; an `@example.com` login fails `check-clean`).

## Left to the builder

- Live enable vs. restart (above).
- Exact default port and env var name.
- Command output wording, within the existing CLI style.
- Whether `--login` also accepts a list (one login is enough for the
  operator's case; do not build a list unless it is free).

## Live verification (2026-10-26)

On a Linux node and the operator's phone, both on one tailnet:

- **A forged identity header does not get through, for a caller with a user
  identity.** A request through `tailscale serve` carrying
  `Tailscale-User-Login: intruder@github` got `200`. If paddock had seen the
  forged login, the gate would have answered `403` naming it, so serve
  overwrote the header with the caller's real login. This was tested from the
  operator's own devices only; no device of another user was online. A request
  from the serving node itself carried the owner's identity (`200`).
- **Not measured: a caller with no user identity** (a tagged or ephemeral
  device). There, serve must delete a client-sent `Tailscale-User-*` header
  rather than overwrite it. That relies on upstream tailscaled's behaviour:
  serve's identity-header handling removes incoming `Tailscale-User-*` headers
  before setting its own. No such device was on the tailnet to test it.
- **Direct requests** to `127.0.0.1:8789` with no header, or with another
  login, get `403`. Both listeners bind `127.0.0.1` only.
- **Phone:** the dashboard loads with no login, the WebSocket connects, and
  writes succeed. That confirms `Host` is preserved: no `cross-origin` refusals.
- **Lifecycle:** `paddock stop` removed paddock's serve config and kept
  `tailscale.json`. `paddock local` re-applied it, and the same URL answered.
  `status` showed the ✓ block.
- **Push over the ts.net origin: not verified.** The operator skipped it.
- **Found in the live run:**
  - On Linux, `tailscale serve` needs root or the tailscaled operator user. Its
    `Access denied: serve config denied` needs a hint naming
    `tailscale set --operator=$USER`. Fixed: `cli.ts` adds that hint on Linux.
  - The first HTTPS request on a node with a new certificate took about 27s
    while the certificate was issued, so a 5s verify timeout fails the first
    run. Fixed: the verify retries transport failures for up to 90s and says
    it is waiting on the certificate.
