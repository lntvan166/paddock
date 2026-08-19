# paddock — instructions for Claude sessions

A mobile-first web dashboard for watching and answering
[herdr](https://github.com/herdrdev/herdr) coding agents from a phone.

**Read `docs/design/2026-08-17-paddock-design.md` first.** It is the approved design
and the source of truth for architecture, data model, and UI decisions. Everything
below is either a hard rule or a pointer into that document.

---

## THIS REPOSITORY IS PUBLIC

Never commit anything specific to the developer or their employer. This is the
single most important rule in this file.

- **No real hostnames, domains, tunnel IDs, or cloud org / team names.**
  Use `paddock.example.com`, `example-team`.
- **No absolute home paths.** Use `$HOME`, `~`, or `/path/to/…`.
- **No usernames, machine names, or email addresses** — including in code comments,
  commit messages, branch names, and docs. Use `dev-box`, `operator`.
- **No employer service names, ticket codes, or internal terminology.**
- **Fixtures, demo data, tests and screenshots use INVENTED agent names**
  (`api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`).
  Never copy real ones, not even as "realistic examples". This is the rule most
  likely to be broken by accident: a reviewer notices a hardcoded hostname, but
  nobody notices that a demo fixture is named after someone's internal tickets.
- **Config ships as `.env.example` only.** Never commit `.env`.
- **Screenshots and README images come from `paddock serve --demo`**, never a live
  session.
  - **One narrow exception: a device frame showing no session content.** The
    Home Screen shot in `README.md` cannot come from the demo, because the thing
    it demonstrates is iOS turning the PWA into an installed app, which only
    exists on a real device. Such an image is allowed only when it contains **no
    dashboard content at all** — no agent names, no terminal output, no
    hostname, no URL bar — and is cropped to the subject. The original of that
    one included a dock with unread badges and a wallpaper; both were cropped
    away before it was committed. If you find yourself arguing that some session
    content is "fine", the exception does not apply.

### Enforcement

```bash
make check-clean     # scripts/check-private.sh — pre-commit hook + CI
```

Its patterns are split deliberately:

- **Committed patterns are generic only** — `/home/`, `/Users/`, email addresses,
  RFC1918 addresses, `BEGIN .*PRIVATE KEY`, JWT-shaped strings.
- **`.private-denylist` holds specific strings and is gitignored.** A committed
  denylist would leak exactly what it protects.

**If `check-clean` fails, fix the content. Do not add the string to the ignore
list.** The failure mode of a scanner is someone silencing it.

---

## Architecture rules

Full detail in `docs/architecture.md`. The rules that must not be broken:

1. **Dependency direction is strict:**
   `herdr/socket → herdr/adapter → state/store → ws/hub → web/`.
   Nothing upstream imports anything downstream. `store.ts` must not know about
   transport; `hub.ts` must not know about herdr.
2. **`src/server/herdr/` is the only code that knows herdr exists.** All field
   mapping lives in `adapter.ts`. A protocol change should touch three files.
3. **`src/shared/types.ts` is the one payload contract**, imported by both server
   and UI. Never redeclare a payload shape on one side.
4. **`src/shared/herdr-api.d.ts` is generated** by `make types` from
   `herdr api schema --json`, and committed. Never hand-edit it.

## Hard rules learned from failures

`docs/gotchas.md` has the full table with causes. The short version:

- **Use `agent.list`, never `pane.list`.** Only `agent.list` returns `name`.
- **Never label an agent from `basename(cwd)`.** Agents commonly share a working
  directory, so every row renders identically.
- **Never swallow errors.** No `2>/dev/null`, no unconditional `exit 0` in scripts,
  no empty catch blocks. Event receipt logs at INFO and `/api/health` exposes
  `lastEventAt`, so a silent break is visible within seconds.
- **Never put payloads in a GET query string.** Query strings land in edge access
  logs. POST bodies only.
- **Never add an application auth token.** It would gate `/sw.js` and silently
  disable the service worker and push. Cloudflare Access is the only gate — see
  `docs/decisions.md` before reconsidering this.
- **Never special-case a hostname in the client.** Derive the WebSocket URL from
  `location` unconditionally. A `localhost` exclusion is how a working dashboard
  silently becomes a demo screen.
- **Never guess a keystroke for a blocked agent.** Render the prompt's real options
  with their real labels; if parsing fails, fall back to raw output plus a free-text
  reply. A mislabelled Approve button is worse than no button.

## UI rules

- **No device detection. No `isMobile`. No user-agent parsing.** Width media queries
  for layout, `(pointer: coarse)` / `(hover: hover)` for interaction, capability +
  install state for install and notification prompts.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, then
  redefined under `prefers-color-scheme` and `[data-theme]` so a manual toggle wins
  both directions.
- **No hover-only affordances** — invisible on touch.
- **Respect `prefers-reduced-motion`** and `env(safe-area-inset-bottom)`.

## Commands

```bash
make dev           # vite HMR + server reload, no Docker — the iteration loop
make types         # regenerate src/shared/herdr-api.d.ts
make check         # tsc --noEmit — there is no linter; see docs/roadmap.md
make check-clean   # public-repo scanner — before EVERY commit
make test          # builds the UI first, then runs the suite (not bare `bun test`)
make build         # check, check-clean, test, then compile the binary
make up            # docker compose up -d --build
```

`make dev` runs outside Docker deliberately — HMR through a bind mount is a
reliable source of "why isn't my change showing".

## Attribution

The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote).
paddock reuses the concept and none of the implementation. Keep the credit in
`README.md` accurate and prominent.
