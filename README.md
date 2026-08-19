<p align="center">
  <img src="docs/images/logo.png" alt="paddock" width="100" />
</p>

<h1 align="center">paddock</h1>

<p align="center">
  <a href="https://lntvan166.github.io/paddock/">demo</a> ·
  <a href="#install">install</a> ·
  <a href="docs/running-locally.md">running locally</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license" /></a>
  <a href="https://github.com/lntvan166/paddock/releases/latest"><img src="https://img.shields.io/github/v/release/lntvan166/paddock?label=release&labelColor=333333&color=666666" alt="latest release" /></a>
  <a href="https://github.com/lntvan166/paddock/releases"><img src="https://img.shields.io/github/downloads/lntvan166/paddock/total?labelColor=333333&color=666666" alt="total downloads" /></a>
</p>

---

<p align="center">
  <img src="docs/images/01-agents.png" alt="The agent list, grouped by what needs attention" width="46%">
  <img src="docs/images/02-blocked.png" alt="A blocked agent showing its real options and what Enter will commit" width="46%">
</p>

**watch and answer your coding agents from your phone.**

You have several agents running in [herdr](https://github.com/herdrdev/herdr)
panes. You step away from the desk. One finishes, another hits a permission
prompt, and both sit there waiting — because the only way to find out is to
walk back and look.

- **triage** — grouped into *needs you*, *working*, *idle*, not alphabetically
- **read** — full ANSI colour; prose reflows to the screen, tables keep their columns
- **answer** — the agent's own option labels, and what Enter will commit before you tap it
- **notify** — a Telegram message when an agent needs you, with quiet hours and a per-agent cooldown. [settings →](docs/settings.md)
- **install as an app** — Add to Home Screen gives it an icon and no browser chrome
- **cheap to watch** — adaptive polling, and only changed lines on the wire

[**try the live demo →**](https://lntvan166.github.io/paddock/) — synthetic
agents, no install, best in mobile mode.

---

## install

```bash
curl -fsSL https://lntvan166.github.io/paddock/install.sh | sh
```

Installs to `~/.local/bin/paddock`, no `sudo`, checksum verified before
anything is written · [read it first](https://lntvan166.github.io/paddock/install.sh)
· [binaries](https://github.com/lntvan166/paddock/releases)

then start it where herdr is running:

```bash
paddock
```

`ctrl+c` stops it. `paddock update` upgrades it; paddock never updates itself
unasked. `paddock --demo` runs it with synthetic agents and no herdr.

It checks for a newer release at most once a day, caching the answer in
`~/.config/paddock/update-check.json` — set `PADDOCK_NO_UPDATE_CHECK=1` and it
makes no request and writes nothing.

> [!WARNING]
> paddock has **no login of its own**. Anyone who reaches its port can send
> keystrokes to your agents, answer their prompts, and read their screens.
> Never port-forward it or bind `0.0.0.0`.

## from your phone

paddock stays on `127.0.0.1`. Put an authenticating tunnel in front — a
[Cloudflare Tunnel with Zero Trust Access](docs/deploy-cloudflare.md) dials
out, so no inbound port is opened and the identity check happens before any
request reaches paddock.

Then **Share → Add to Home Screen**, and it is an app: its own icon, no browser
chrome, and it opens where you left off.

<p align="center">
  <img src="docs/images/05-home-screen.jpg" alt="paddock on an iPhone Home Screen, in a folder named herdr" width="28%">
</p>

[running locally →](docs/running-locally.md)

## docs

[running locally](docs/running-locally.md) ·
[settings](docs/settings.md) ·
[cloudflare tunnel](docs/deploy-cloudflare.md) ·
[architecture](docs/architecture.md) ·
[gotchas](docs/gotchas.md) ·
[decisions](docs/decisions.md) ·
[roadmap](docs/roadmap.md)

[`gotchas.md`](docs/gotchas.md) is the one worth reading first if you are
building anything against herdr — it records what its API actually does,
measured rather than assumed.

## development

```bash
bun install
make dev     # vite HMR + server reload
make test    # builds the UI first, then runs the suite
```

`make check` is `tsc --noEmit`; `make check-clean` scans for anything that
should not be in a public repo. [contributing →](CONTRIBUTING.md)

## contributing

Issues and pull requests welcome — especially **multi-host** (several machines
in one list, the biggest gap left), a **linter**, and **more component tests**.
[roadmap →](docs/roadmap.md) · [house rules →](CONTRIBUTING.md)

## thanks

The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote)
by dcolinmorgan: pushing herdr agent status to a phone for monitoring and
one-tap approval.

paddock reuses that **concept** and none of its implementation. herdr-remote is
AGPL-3.0-or-later; paddock is MIT. No code, markup or styling has been copied
between them, and the two solve the problem differently — herdr-remote relays
through a Python service, paddock speaks herdr's socket protocol directly.

## license

MIT — see [LICENSE](LICENSE).
