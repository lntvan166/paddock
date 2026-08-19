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
