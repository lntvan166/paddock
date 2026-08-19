# Running locally, and reaching it from your phone

paddock is **one process on the same machine as herdr**, bound to
`127.0.0.1:8787`. That is a design decision, not a limitation waiting to be
fixed:

- It reads herdr over a **unix domain socket**, which is a filesystem object
  with no network form. There is nothing to connect to remotely.
- It has **no authentication of its own**, deliberately — an app token would
  also gate `/sw.js` and silently disable the service worker and push. See
  [`decisions.md`](decisions.md).

> [!WARNING]
> **Do not port-forward `8787` or bind it to `0.0.0.0`.** paddock can send
> keystrokes and arbitrary text to your agents, answer their permission
> prompts, and read everything on their screens. Anyone who reaches the port
> can do all of that. There is no login to stop them.

## Reaching it from your phone

Put an authenticating tunnel in front of it — the tunnel terminates at your
machine, and the identity check happens before any request reaches paddock:

- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  + [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)**
  — what this was designed against. `cloudflared` dials out, so no inbound port
  is opened, and an Access policy gates the hostname on your identity provider.
  Step by step in [`deploy-cloudflare.md`](deploy-cloudflare.md).
- **[Tailscale](https://tailscale.com/)** or any WireGuard mesh — your phone
  joins the private network and reaches `127.0.0.1:8787` on the host directly.
- **An SSH tunnel** — fine for a laptop, awkward on a phone.

Whichever you choose, the requirement is the same: **something must
authenticate the request before paddock sees it.**

## Keeping it running

A paddock your phone can reach has to outlive the terminal you started it
from. Once a tunnel is in front of it, `paddock start` is the normal way to
run it: it spawns a detached child, waits for the state file to appear and
`/api/health` to answer, and reports success only once both are true.

```bash
paddock start     # detached; survives this terminal
paddock status    # pid, port, uptime — or "not running"
paddock stop      # SIGTERM, waits up to 10s; --force sends SIGKILL
```

The detached process's stdout and stderr go to
`~/.config/paddock/paddock.log` (`PADDOCK_CONFIG_DIR` moves it, same as
`settings.json`). That file is **truncated on every `paddock start`**, not
appended — it holds one run's output, not a growing history.

`paddock start`/`stop`/`status` do not give you restart-on-boot or
restart-on-crash; nothing here loops or supervises. They are the interactive
path, for a developer at a terminal, not a supervision mechanism — do not
point a service unit at them. A service manager should instead run plain
`paddock` (no verb) in the foreground and own restart itself: systemd's
default `Type=simple` tracks the process it launched directly, which is
exactly what a foreground paddock is. `paddock start`'s detached child would
leave `ExecStart` exiting 0 immediately, and there is no pid file to hand a
`Type=forking` unit either — paddock deliberately does not write one; see
`docs/design/2026-08-19-lifecycle-commands-design.md`.

## Then add it to your Home Screen

<p align="center">
  <img src="images/05-home-screen.jpg" alt="paddock on an iPhone Home Screen, in a folder named herdr" width="38%">
</p>

Once it is reachable, **Share → Add to Home Screen** turns paddock into an app
— its own icon, no browser chrome, and it opens where you left off. The
manifest and icons that make that work already ship.

On iOS this is also the only way to get Web Push, if it ever lands — Safari
delivers notifications to an installed PWA and never to a page in a tab.

## herdr on another machine

Possible, and it needs no code change: forward the remote socket to a local
path.

```bash
# the second path is the REMOTE user's socket, absolute on that machine
ssh -N -L /tmp/remote-herdr.sock:/path/to/remote/.config/herdr/herdr.sock operator@lan-box
PADDOCK_HERDR_SOCKET=/tmp/remote-herdr.sock paddock
```

Verified through a relayed socket, event stream included. Note this gives you
**one** remote herdr per paddock, not several machines in one dashboard — that
is still [on the roadmap](roadmap.md).
