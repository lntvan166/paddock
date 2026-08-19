<p align="center">
  <img src="docs/images/logo.png" alt="paddock" width="160">
</p>

<h1 align="center">paddock</h1>

<p align="center"><strong>Watch and answer your coding agents from your phone.</strong></p>

You have several coding agents running in [herdr](https://github.com/herdrdev/herdr) panes. You step away from the desk. One of them finishes, another hits a permission prompt, and both sit there waiting — because the only way to find out is to walk back and look.

paddock is one local process on the same machine as your agents. It reads herdr over its unix socket and serves a single screen on `127.0.0.1:8787`, ordered by **what needs you** rather than alphabetically. Tap an agent to read its terminal in colour, scroll back through what it did, and answer it — with the agent's own option labels, never a guessed "Approve".

To reach it from your phone, put a [Cloudflare Tunnel with Zero Trust Access](#it-runs-locally-on-purpose) in front. paddock has no login of its own, by design.

### ▶ [Try the live demo](https://lntvan166.github.io/paddock/)

Synthetic agents, no install. Best viewed in mobile mode.

<p align="center">
  <img src="docs/images/01-agents.png" alt="The agent list, grouped by what needs attention" width="46%">
  <img src="docs/images/02-blocked.png" alt="A blocked agent showing its real options and what Enter will commit" width="46%">
</p>

---

## At a glance

- **Triage** — agents grouped into *Needs you*, *Working*, *Idle*
- **Read** — full ANSI colour; prose reflows to the screen, tables keep their columns
- **Answer** — the agent's real option labels, and what Enter will commit before you tap it
- **Scroll back** — up to 4000 lines per agent
- **Cheap to watch** — adaptive polling, and only changed lines on the wire
- **Notify** — a Telegram message when an agent needs you, gated by which states you pick, quiet hours, and a per-agent cooldown

## Install

```bash
curl -fsSL https://lntvan166.github.io/paddock/install.sh | sh
```

Installs to `~/.local/bin/paddock`. No `sudo`. The script verifies the release
checksum before writing anything — read it first with
`curl -fsSL https://lntvan166.github.io/paddock/install.sh | less`.

Upgrade with `paddock update`. paddock never updates itself unasked.

Builds are published for Linux and macOS on x86_64 and aarch64 — the same four
platforms herdr supports.

paddock checks GitHub for a newer release **at most once a day**, caches the
answer in `~/.config/paddock/update-check.json`, and shows a dim line in the
header when there is one. It never installs anything on its own. Set
`PADDOCK_NO_UPDATE_CHECK=1` to switch it off entirely — no request is made and
nothing is written. It is off automatically for a `0.0.0-dev` build.

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

## Settings

Open `#/settings` from the gear icon on the agent list. It has two sections, because the settings behind them live in two different places:

- **This device** — theme, refresh rate, terminal font size, line wrap. Stored in this browser's `localStorage` and nowhere else: open paddock on a second device and it starts from defaults, not a synced copy.
- **All devices** — Telegram token and chat id, the notification switch, which states fire one (`blocked`, `done`), quiet hours, the per-agent cooldown, and the public URL used for a notification's deep link. These live on the paddock **process**, one copy for every device that connects to it, because **sending happens on the server**: turning notifications off from your phone also silences your laptop, since there is exactly one place a Telegram message is ever sent from, not one per browser that happened to open the dashboard.

The Telegram token is written to `~/.config/paddock/settings.json` at file mode `0600` and is never sent back to a browser: `GET /api/settings` reports only whether a token is configured and its last four characters, never the token itself. The public URL (e.g. `https://paddock.example.com`) is what turns a bare "docs-cleanup is blocked" into a tap-through link — set it once here.

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

### Then add it to your Home Screen

<p align="center">
  <img src="docs/images/05-home-screen.jpg" alt="paddock on an iPhone Home Screen, in a folder named herdr" width="45%">
</p>

Once it is reachable, **Share → Add to Home Screen** turns paddock into an app: its own icon, no browser chrome, and it opens where you left off. The manifest and icons that make that work already ship.

On iOS this is also the only way to get Web Push, if it ever lands — Safari delivers notifications to an installed PWA and never to a page in a tab.

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
- **Notifications are Telegram, not browser push.** A Telegram message can tell you an agent needs you (see [Settings](#settings) above); nothing reaches your phone through the browser's own push mechanism, and per `docs/roadmap.md` that is no longer the plan, not merely not-yet-built.

The [live demo](https://lntvan166.github.io/paddock/) shows the interface, not the herdr integration — it proves the UI works, not that it can talk to your agents.

## Contributing

Every gap listed above is an open invitation. Issues and pull requests are welcome — especially for the things this needs most:

- **Multi-host** — several machines in one list. The biggest functional gap remaining. The seams exist (`hostId` is on every record); the blocker is that the store is keyed by herdr's `pane_id`, which is not unique across machines.
- **A linter** — `make check` is `tsc --noEmit` and nothing else.
- **More component tests** — `App.tsx` routing and the refresh loop's timing are still unverified.

[`docs/roadmap.md`](docs/roadmap.md) has the full list with the reasoning for each.

Four house rules, all of which have already caught real mistakes here:

1. **This repo is public.** Never commit hostnames, home paths, usernames, employer terms, or real agent names. `make check-clean` enforces it and runs before every commit — if it fails, fix the content, never the denylist.
2. **Screenshots come from the demo**, never a live session. Images cannot be scanned, so the only safe source is data that was invented to begin with.
3. **Measure rather than assume.** [`docs/gotchas.md`](docs/gotchas.md) is a list of things that turned out to be false when checked against a live herdr. If you are about to write "this should be fast" or "this can't happen", measure it and put the number in the commit message.
4. **Prove a test can fail.** Break the thing it guards and watch it go red. A test that cannot fail is worse than no test, because it reads as coverage.

```bash
bun install
make check && make check-clean && make test
```

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
