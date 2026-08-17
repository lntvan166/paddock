# paddock

A mobile-first web dashboard for watching and answering
[herdr](https://github.com/dcolinmorgan/herdr) coding agents from a phone.

You run several coding agents in herdr panes on one machine. When you are away
from the desk you want to know, at a glance: **which agent needs me?** paddock
is a single local process that reads herdr over its unix socket and serves one
screen, ordered by what needs attention rather than alphabetically.

## Attribution

The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote) by
dcolinmorgan — pushing herdr agent status to a phone for monitoring and one-tap
approval. paddock reuses that concept with a different transport, stack and UI.

## Quick start

Try it without herdr installed, using synthetic agents:

```bash
bun install
bun run build:web
bun src/server/index.ts --demo
```

Then open `http://127.0.0.1:8787`.

Against a real herdr instance, drop `--demo` — paddock reads
`$HOME/.config/herdr/herdr.sock` by default (override with
`PADDOCK_HERDR_SOCKET`):

```bash
bun src/server/index.ts
```

To run it as a container instead, see `make up` and `docker-compose.yml`.

## Screenshots

Any screenshot or README image is captured from `paddock serve --demo`, never a
live session — the demo fixtures use invented agent names, so published media
is structurally incapable of leaking real data.

## Documentation

- `docs/architecture.md` — module map and the one-way dependency rule
- `docs/decisions.md` — why the design is shaped the way it is
- `docs/gotchas.md` — failure modes designed out, and their causes
- `docs/roadmap.md` — what is deliberately not in v1
- `docs/deploy-cloudflare.md` — tunnel + Access setup, and how to verify it

## Development

```bash
make dev           # vite HMR + server reload, no Docker — the iteration loop
make types         # regenerate src/shared/herdr-api.d.ts
make check         # tsc --noEmit
make check-clean   # public-repo scanner — run before every commit
make test          # builds the UI first, then runs the suite
make build         # check, check-clean, test, then compile the binary
make up            # docker compose up -d --build
```

## License

MIT — see [`LICENSE`](LICENSE).
