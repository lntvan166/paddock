# Deploying behind Cloudflare Tunnel + Access

paddock binds `127.0.0.1:8787` only and has no authentication of its own (see
`docs/decisions.md`, decision 3). Remote access — and all authentication — is
delegated entirely to Cloudflare Tunnel plus Access. Do not expose paddock's
port directly on any interface other than loopback.

The examples below use placeholder names. Substitute your own tunnel, hostname
and team.

**Create the Access application before you publish the hostname.** The order in
this document is deliberate. Access applications are keyed by domain and can be
created before anything routes to that name, whereas a published hostname with
no policy attached is a dashboard open to anyone who can resolve it — with
keystroke access to every agent on the machine. Doing it in the other order
leaves a window whose length is however long it takes you to click through the
second screen.

## 1. Access application

In Cloudflare Zero Trust, add a **Self-hosted** Access application:

- **Application domain:** `paddock.example.com`
- **Policy:** allow the identities that should reach it — for a personal
  dashboard this is typically "your email is X" or "member of team
  `example-team`", not a public-allow policy.
- **Session duration:** the default is 24 hours. On a phone this is the
  difference between opening the dashboard and re-authenticating first, so it
  is worth setting deliberately rather than leaving at the default.

Using a social or corporate identity provider (Google, GitHub, an OIDC or SAML
provider) rather than one-time PIN removes an email round trip from every
re-authentication. The provider must already be configured under **Settings →
Authentication** before a policy can reference it.

Access is the only identity, policy and audit layer paddock has. There is no
paddock-side login page, so a misconfigured application here means the
dashboard is either open to anyone who can resolve the hostname, or (with the
tunnel healthy but no Access application attached) reachable with no login at
all.

## 2. Public hostname on the tunnel

In your existing `cloudflared` tunnel (or a new one), add a public hostname:

- **Type:** `HTTP`
- **URL:** `localhost:8787`
- **Public hostname:** `paddock.example.com`

This is the same tunnel config used for anything else you already expose — add
one more `ingress` entry rather than standing up a second tunnel.

Where that entry lives depends on how the tunnel was created. A tunnel run from
a `TUNNEL_TOKEN` is **remotely managed**: its ingress rules live in the Zero
Trust dashboard, and there is no local config file to edit. A tunnel run from a
credentials file reads `config.yml` on disk and must be restarted to pick up a
change.

### If cloudflared runs in a container

`localhost` inside a container is the container, not the host — so an ingress
entry pointing at `localhost:8787` reaches paddock only if the container shares
the host's network namespace (`network_mode: host`, or `--network host`). That
is the arrangement to prefer, because it needs no change to paddock.

Without host networking the container cannot reach a loopback-bound port at
all, and the fix is **not** to rebind paddock to `0.0.0.0` or to the bridge
gateway: that puts an unauthenticated dashboard on every interface the host
has, which is exactly what the warning at the top of this document is about.
Use host networking, or run `cloudflared` on the host instead.

## 3. Verify the gate is actually in front

After both are configured, confirm from a browser or with `curl` that hitting
the public hostname redirects to Access login rather than serving the
dashboard:

```bash
curl -sI https://paddock.example.com/ | head -1
```

**Expected:** a redirect (`302`/`303`) to a `cloudflareaccess.com` login URL.

**If you get a plain `200` instead, Access is not in front of paddock.** A
`200` on the public hostname means the request reached paddock's Hono app
directly with zero authentication — paddock has none of its own, by design
(decision 3). Do not treat a working dashboard at that URL as a sign
everything is fine; it is the failure mode.

Check this from a context that carries no Access session — a private window, or
`curl` as above. A browser you have already authenticated in will render the
dashboard whether or not the policy is correct, so it cannot distinguish the
two outcomes.

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
and audit logging; the pairing code has none of those — it is a floor that
keeps "trying paddock" from meaning "publishing an open dashboard".

The URL changes every time the command runs, so a home-screen icon saved from
one run will not work after the next, and a Telegram message sent before a
restart carries a link that no longer resolves.

`paddock tunnel [--for 45s|90m|2h]` runs until `--for` elapses, `cloudflared`
exits on its own, or you press `ctrl+c` — every path stops `cloudflared` and
closes the gate's listener before the process exits, so no orphaned tunnel is
left resolving with nothing paddock behind it. It refuses to start if a
detached paddock is already running (see `docs/gotchas.md`) or if `cloudflared`
is not installed, and it binds a *second* loopback port for the gated listener
— `8788` by default, overridable with `PADDOCK_TUNNEL_PORT` if that port is
already taken.

## 4. Everyday use

Once the redirect is confirmed, normal browser use is: visit
`https://paddock.example.com`, authenticate once through Access (subject to
your policy's session duration), and the dashboard behaves like any other
same-origin app — including the WebSocket upgrade, which travels over the same
tunnel and hostname.
