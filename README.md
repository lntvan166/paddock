<p align="center">
  <img src="docs/images/logo.png" alt="paddock" width="160">
</p>

<h1 align="center">paddock</h1>

<p align="center"><strong>Watch and answer your coding agents from your phone.</strong></p>

You have several coding agents running in [herdr](https://github.com/dcolinmorgan/herdr) panes. You step away from the desk. One of them finishes, another hits a permission prompt, and both sit there waiting — because the only way to find out is to walk back and look.

paddock is one local process that reads herdr over its unix socket and serves a single screen, ordered by **what needs you** rather than alphabetically. Tap an agent to read its terminal in colour, scroll back through what it did, and answer it — with the agent's own option labels, never a guessed "Approve".

### ▶ [Try the live demo](https://lntvan166.github.io/paddock/) — no install, synthetic agents, runs entirely in your browser

<p align="center">
  <img src="docs/images/01-agents.png" alt="The agent list, grouped by what needs attention" width="46%">
  <img src="docs/images/02-blocked.png" alt="A blocked agent showing its real options and what Enter will commit" width="46%">
</p>

---

## What it does

**Triage first.** Agents are grouped into *Needs you*, *Working* and *Idle*, most-recently-changed first. A finished agent can be dismissed from *Needs you* without touching herdr's own state.

**A terminal you can actually read on a phone.** Prose reflows to the screen; tables, boxes and progress bars keep their columns and scroll in their own strip. ANSI colour is preserved, because in agent output the colour *is* the structure.

**Answer without guessing.** A blocked agent's real options are rendered as buttons carrying its exact labels. Above the keypad, paddock shows **what Enter will commit** — because the cursor wraps from the last option back to the first, and the middle option of a permission prompt is routinely *"and don't ask again"*.

**Scroll back.** Up to 4000 lines per agent, reconstructed from what the tab watched, revealed on demand.

**Cheap to watch.** Refresh adapts from 250 ms down to 10 s based on whether the screen is actually moving, and only changed lines are sent — a thinking agent redraws one line of 63, so sending whole screens was ~90% waste.

## Quick start

Try it with synthetic agents, no herdr required:

```bash
bun install
bun run build:web
bun src/server/index.ts --demo
```

Against a real herdr:

```bash
make dev        # vite HMR + server reload
```

paddock finds herdr at `$HOME/.config/herdr/herdr.sock`; override with `PADDOCK_HERDR_SOCKET`.

## It runs locally, on purpose

paddock is **one process on the same machine as herdr**, bound to `127.0.0.1:8787`. That is a design decision, not a limitation waiting to be fixed:

- It reads herdr over a **unix domain socket**, which is a filesystem object with no network form. There is nothing to connect to remotely.
- It has **no authentication of its own**, deliberately — an app token would also gate `/sw.js` and silently disable the service worker and push. See [`docs/decisions.md`](docs/decisions.md).

> [!WARNING]
> **Do not port-forward `8787` or bind it to `0.0.0.0`.** paddock can send keystrokes and arbitrary text to your agents, answer their permission prompts, and read everything on their screens. Anyone who reaches the port can do all of that. There is no login to stop them.

### Reaching it from your phone

Put an authenticating tunnel in front of it — the tunnel terminates at your machine, and the identity check happens before any request reaches paddock:

- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) + [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)** — what this was designed against. `cloudflared` dials out, so no inbound port is opened, and an Access policy gates the hostname on your identity provider.
- **[Tailscale](https://tailscale.com/)** or any WireGuard mesh — your phone joins the private network and reaches `127.0.0.1:8787` on the host directly.
- **An SSH tunnel** — fine for a laptop, awkward on a phone.

Whichever you choose, the requirement is the same: **something must authenticate the request before paddock sees it.**

### herdr on another machine

Also possible, and it needs no code change: forward the remote socket to a local path.

```bash
# the second path is the REMOTE user's socket, absolute on that machine
ssh -N -L /tmp/remote-herdr.sock:/path/to/remote/.config/herdr/herdr.sock operator@lan-box
PADDOCK_HERDR_SOCKET=/tmp/remote-herdr.sock bun src/server/index.ts
```

Verified through a relayed socket, event stream included. Note this gives you **one** remote herdr per paddock, not several machines in one dashboard — that is still [on the roadmap](docs/roadmap.md).

## What it does not do

Worth knowing before you install it:

- **Output is pulled, not streamed.** herdr exposes no output-changed event and no byte stream, so there is nothing to stream. Updates arrive on an adaptive poll.
- **History only covers what a tab watched.** An agent nobody was watching has none, and reconstruction records a *gap* rather than guessing when the screen scrolls faster than it was sampled.
- **One machine, and localhost by design.** paddock runs beside herdr and binds `127.0.0.1` — see [It runs locally, on purpose](#it-runs-locally-on-purpose). Multi-host is designed but not built: the store is keyed by herdr's `pane_id`, which is not unique across machines.
- **No push notifications yet.** You still have to open the dashboard to find out something is blocked. That's the next increment.

The [live demo](https://lntvan166.github.io/paddock/) shows the interface, not the herdr integration — it proves the UI works, not that it can talk to your agents.

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Sequence diagrams, the push/pull rule, why one port |
| [`docs/gotchas.md`](docs/gotchas.md) | Every herdr constraint found the hard way, with measurements |
| [`docs/decisions.md`](docs/decisions.md) | Choices made and the alternatives rejected |
| [`docs/roadmap.md`](docs/roadmap.md) | What is not built, and why |

`docs/gotchas.md` is the one worth reading first if you are building anything against herdr — it records what its API actually does, measured rather than assumed.

## Development

```bash
make dev           # vite HMR + server reload, no Docker
make check         # tsc --noEmit
make check-clean   # scans for anything that should not be in a public repo
make test          # builds the UI first, then runs the suite
make build         # check, check-clean, test, then compile the binary
```

Screenshots come from the demo build, never a live session — see `CLAUDE.md`.

## Attribution

The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote) by dcolinmorgan: pushing herdr agent status to a phone for monitoring and one-tap approval.

paddock reuses that **concept** and none of its implementation. herdr-remote is AGPL-3.0-or-later; paddock is MIT. No code, markup or styling has been copied between them, and the two solve the problem differently — herdr-remote relays through a Python service, paddock speaks herdr's socket protocol directly.

## License

MIT — see [LICENSE](LICENSE).
