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
  - **`--demo` can show every screen, since 2026-08-27.** It used to leave
    `HerdrActions` unset, so the herdr-backed routes were never registered and
    404'd honestly — which meant the terminal pane and both Spaces screens
    rendered as errors and had NO permitted source of a screenshot at all.
    `src/server/demo-actions.ts` is the shim this file used to ask for: it
    serves synthetic reads and REFUSES every write with a plain "this is the
    demo" message.

    The refusal is the load-bearing part, and `tests/demo-actions.test.ts`
    asserts it for every write on the interface — plus a guard that fails when
    a method is added to `HerdrActions` and left off that list. A write that
    resolved quietly would be exactly the mislabelled control this file bans:
    every key in the demo looking live and doing nothing, silently, with no
    other test able to notice because a resolved promise is what success looks
    like.

    One agent stays blocked and never rotates (`DEMO_BLOCKED_AGENT_ID`), so
    the permission prompt — the thing paddock exists for — is always on screen
    rather than appearing every thirtieth tick. That is also what makes the
    README's blocked screenshot reproducible instead of a race.

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
- **A theme changes hue, never meaning.** Named themes live in
  `:root[data-theme="…"]` blocks and set chrome; a state colour may be tuned
  only so it stays legible on that theme's ground. `tests/themes.test.ts`
  asserts AA per theme — including for state colours a theme INHERITS, which is
  how one drops below AA unnoticed. Never re-theme `--term-bg`/`--term-fg` or
  the tile hues. Adding a theme is a palette plus a green test run; see
  `docs/decisions.md` decision 25.
- **No hover-only affordances** — invisible on touch.
- **Respect `prefers-reduced-motion`** and `env(safe-area-inset-bottom)`.

### shadcn/ui is installed, at a boundary

The UI was entirely hand-rolled until `shadcn init` landed on the UI-release
branch. What that means in practice:

- **New surfaces may use shadcn.** It earns its weight on the primitives that
  are genuinely hard to get right — Dialog/Sheet, Popover, Tooltip, Command,
  DropdownMenu: focus traps, scroll locking, escape handling, typeahead.
- **The six primitives in `src/web/components/ui/` are still ours** — `Card`,
  `Toggle`, `Segmented`, `IconTile`, `StatusDot`, `icons`. Do not swap them out
  for shadcn equivalents without a reason a user would notice.
- **shadcn's tokens are ALIASES of paddock's**, in the bridge block in
  `styles.css`. Never give them their own values. `init` wrote its own
  `--border` and `--accent` over paddock's, which turned the interaction colour
  near-white and made the Send button invisible — and all 1159 tests still
  passed, because nothing asserts a computed colour.
- **`--accent` belongs to paddock.** shadcn's "accent" means a subtle hover
  ground and is mapped to `--surface` in `@theme`, not aliased.
- **Never accept a shadcn preset's font.** `--preset nova` pulls
  `@fontsource-variable/geist`: 76 KB of woff2, larger than the whole gzipped
  JS bundle, into a project whose stylesheet says system fonts only because a
  webfont is the biggest payload on a slow link. `tests/tokens.test.ts` now
  guards both the `@import` and any font file reaching `dist/`.
- **`lucide-react` is a dependency now**, because shadcn components import
  icons internally and it tree-shakes per icon. paddock's own eight glyphs stay
  hand-written in `ui/icons.tsx` — do not switch them to lucide.
- **Components land in `src/web/components/shadcn/`.** `init` guessed an alias
  and wrote them into `src/shared/` — the generated-contract directory — so
  `components.json` is pinned deliberately.

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
