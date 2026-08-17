# Deploying behind Cloudflare Tunnel + Access

paddock binds `127.0.0.1:8787` only and has no authentication of its own (see
`docs/decisions.md`, decision 3). Remote access — and all authentication — is
delegated entirely to Cloudflare Tunnel plus Access. Do not expose paddock's
port directly on any interface other than loopback.

The examples below use placeholder names. Substitute your own tunnel, hostname
and team.

## 1. Public hostname on the tunnel

In your existing `cloudflared` tunnel (or a new one), add a public hostname:

- **Type:** `HTTP`
- **URL:** `localhost:8787`
- **Public hostname:** `paddock.example.com`

This is the same tunnel config used for anything else you already expose — add
one more `ingress` entry rather than standing up a second tunnel.

## 2. Access application

In Cloudflare Zero Trust, add a **Self-hosted** Access application:

- **Application domain:** `paddock.example.com`
- **Policy:** allow the identities that should reach it — for a personal
  dashboard this is typically "your email is X" or "member of team
  `example-team`", not a public-allow policy.

Access is the only identity, policy and audit layer paddock has. There is no
paddock-side login page, so a misconfigured application here means the
dashboard is either open to anyone who can resolve the hostname, or (with the
tunnel healthy but no Access application attached) reachable with no login at
all.

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

## 4. Everyday use

Once the redirect is confirmed, normal browser use is: visit
`https://paddock.example.com`, authenticate once through Access (subject to
your policy's session duration), and the dashboard behaves like any other
same-origin app — including the WebSocket upgrade, which travels over the same
tunnel and hostname.
