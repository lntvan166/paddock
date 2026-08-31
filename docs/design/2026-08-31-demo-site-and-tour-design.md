# A demo site that explains itself

**Status:** APPROVED, not yet built. 2026-08-31.
**Date:** 2026-08-31.

## The problem

The hosted demo drops a first-time visitor straight into the dashboard with no
explanation of what they are looking at.

That is a worse introduction than it sounds. paddock's screens are dense and
deliberately unlabelled — the agent list is grouped by *needs you / working /
idle* rather than alphabetically, a blocked agent shows option labels read from
its own terminal, and the reply field carries slash-commands read from a
project's `.claude`. Every one of those is a considered decision, and every one
of them is invisible to somebody who has been given no reason to look. They see
a list of four invented agent names and close the tab.

The README carries the explanation instead, in prose, next to two screenshots.
So the artefact that can actually demonstrate the product explains nothing, and
the artefact that explains it cannot demonstrate anything.

## What this is not

- **Not a rewrite of the dashboard.** The demo runs the real UI unmodified, as
  it does today. `demo.yml` states the reason and it still holds: *"there are no
  demo branches in any component."* This design adds one static attribute to a
  handful of components and changes no behaviour in any of them.
- **Not a docs site.** One page. `docs/` stays in the repository and stays the
  place things are written down.
- **Not a first-run experience for the real app.** The tour ships in the site
  bundle only. An operator running `paddock` gets a link, not an overlay in
  front of their real blocked agent.
- **Not a server.** The site is static. No functions, no API, nothing that could
  grow an authentication story — see `docs/decisions.md` on why paddock has no
  login of its own.

## Decisions taken

Recorded because a later reader would otherwise assume each was an oversight.

**One long page, not a landing page separate from the demo.** The demo is the
argument; putting it behind a "try it" button on a second route buries it.

**The phone is pinned, live, and follows the copy.** A visitor who only scrolls
still sees every screen. They can grab it and tap at any point.

**The tour is a takeover, not a scroll effect.** A full scrim with one control
lit is inherently modal — you cannot be casually reading marketing copy behind
it. Trying to make it both a scroll narration and a spotlight produces two
competing drivers and neither works. So the page has two gears and you enter the
second one deliberately.

**Steps advance on the real action, not a Next button.** Each step names
something to do and waits for it to actually happen. A `show me` escape appears
after roughly three seconds of nothing, and performs the action itself.

This also enacts a rule `CLAUDE.md` already carries: *"Verify a control from a
USED screen, not a fresh one… Do the thing before it, THEN try it."* A hands-on
tour puts the visitor on a used screen at every step by construction — which is
the state the question dialog shipped eleven bugs in.

**Vercel only. GitHub Pages is retired.** Taken by the operator with the
consequence stated: `curl -fsSL https://lntvan166.github.io/paddock/install.sh
| sh` is published in the README, in `install.sh`'s own header, in two design
documents, in the issue-template config, and in the release notes of every
version already shipped. All of those begin returning 404.

Keeping Pages alive to serve `install.sh` alone was offered and declined. It is
recorded here so that a future reader finding the dead URL knows it was a choice
and not an accident. **The URL change must appear in the next release notes** —
that is the only mitigation left once the old host is gone.

Nothing functional depends on the move: `install.sh` downloads binaries from
`https://github.com/$REPO/releases/latest/download`, and the update check
queries `api.github.com`. Only the URL a human copies changes.

**The tour does not ship inside the real app.** Instead Settings gains a
`How to use` card that links out to the site. Cheaper, and it keeps the overlay
out of the bundle an operator downloads.

## Architecture

### Two builds, explicitly assembled

Not a Vite multi-page build, and the reason is a failure that hides in the
deployment nobody tests.

`public/` is copied verbatim to the output root, and `manifest.webmanifest` sets
`"start_url": "."`, which resolves against **the manifest's own location**. If
the app moves under `/app/` while the manifest lands at `/`, then Add to Home
Screen from the demo installs the *landing page* — an icon that opens marketing
copy instead of the dashboard. Nothing errors. It is only visible to somebody
who installs it and then opens it, which is nobody, until it is a user.

`tests/manifest.test.ts` already guards the related trap (root-absolute URLs
breaking under a base path) and passes unchanged here, because relative URLs are
exactly what makes two builds work.

```
bun run build:app     VITE_PADDOCK_DEMO=1 vite build --base=/app/ --outDir dist-app
bun run build:site    vite build -c vite.site.config.ts --outDir dist-site
bun run build:demo    build:site, then build:app, then assemble

  dist-site/                            landing page and its assets
  dist-site/install.sh                  copied, as demo.yml does today
  dist-site/app/                        all of dist-app/
  dist-site/app/manifest.webmanifest    start_url "." -> /app/
```

Assembly is a script step rather than two `outDir` values pointing at
overlapping paths: Vite's `emptyOutDir` would let the second build delete the
first, and a site that deploys with its `/app/` directory missing is a 404 that
CI would call green.

### Deploy stays gated

> **SUPERSEDED, 2026-08-31.** The operator chose Vercel's Git integration
> instead, weighing the gate against three secrets and a hand-minted token.
> `demo.yml` is deleted and the gates now run beside the deploy rather than
> before it. `docs/decisions.md` 30 records the trade. The reasoning below is
> kept because it is still why the gate mattered, and what was given up.

`demo.yml` runs `make check`, `make check-clean` and `make test` before it
publishes, and says why: *"a demo that ships from a red tree would be
advertising something that does not work."*

Vercel's Git integration would build on push and bypass all three. So it stays
**off**. The workflow keeps its three gates and swaps only its final step for
`vercel deploy --prebuilt --prod`. Preview deployments on pull requests are
therefore not available; that is the price of keeping the gates, and it is the
right trade for a repository whose demo is its shop window.

## The page

Two gears. Gear one is reading; gear two is the tour.

```
desktop, >= 1000px                     phone
+------------------+-------------+     +--------------+
| hero + install   |             |     | hero+install |
|                  |  +-------+  |     +--------------+
| 01 triage        |  |       |  |     |  +--------+  |
|    copy...       |  | phone |  |     |  | phone  |  |
|                  |  | LIVE  |  |     |  | LIVE   |  |
| 02 answer        |  | demo  |  |     |  +--------+  |
|    copy...       |  |       |  |     +--------------+
|                  |  +-------+  |     | 01 triage    |
| 03 reply         |   sticky    |     |  [ shot ]    |
|    copy...       |             |     | 02 answer    |
|                  |             |     |  [ shot ]    |
| [ take the tour ]|             |     | [ take tour ]|
+------------------+-------------+     +--------------+
```

The phone holds a same-origin `<iframe src="/app/">` running the real demo. As a
section enters view the page sets that frame's hash; the visitor may tap the
phone at any time, which suspends the following until they scroll to a new
section.

Below the breakpoint the two columns collapse: one full-width live demo near the
top, and the sections become cards with static screenshots. The tour still runs
there — see below.

Content follows the README's existing bullets, which are already the right
argument and already checked for public-repo safety.

## The tour

### Steering costs nothing

Routing is hash-only — `#/spaces`, `#/settings`, `#/agent/:id`, `#/file/:id`, in
`src/web/route.ts`. Driving the demo is one assignment:

```ts
frame.contentWindow.location.hash = "#/spaces";
```

No postMessage protocol, and no application change of any kind for navigation.

### Anchors are a contract, rendered unconditionally

Tour targets carry `data-tour="blocked-options"` and similar. The attribute is
**always** rendered, in every build — not behind `import.meta.env`.

That is deliberate. `demo.yml` states the property that keeps the demo honest:
*"there are no demo branches in any component."* A conditional attribute would
be exactly such a branch. An unconditional one is a static string of a few dozen
bytes with no behaviour, no code path, and nothing to drift. The *tour* is
demo-only; the *anchor* is universal — which also means that if the tour is ever
wanted inside the real app, the anchors are already in place.

A guard test reads the step list and greps `src/web/` for each step's
`data-tour` value, failing when one is missing. A renamed class then breaks the
build instead of leaving an arrow pointing at empty space.

### Measure after the repaint, never across it

This is the highest-risk defect in the feature, and it is a browser restatement
of one already recorded in `CLAUDE.md`:

> Probe a TUI one key at a time. `send-keys a b c` measures the later keys
> against the frame before the earlier ones landed.

Set the hash and measure the anchor in the same tick and the spotlight is
positioned against the **previous** screen's layout. It will look correct on a
development machine and wrong on a phone, which is the only device that matters
here. Two entries in a design document's measured-behaviour table were already
wrong this way once, and both reached shipped code.

So every step is ordered, with the wait as a real step and not an optimisation:

```
set hash -> app repaints -> anchor exists and settles -> read rect -> paint spotlight
                                      ^
                        wait here. never measure across this line.
```

The rect comes from `frame.contentDocument.querySelector(...)` offset by the
frame's own bounding rect. Same-origin, so this is legal without any bridge.
Recomputed on resize and on frame resize, never cached across a step.

### Advancing, and not trapping anyone

A step completes on the real event — a capture-phase `click` within the anchor,
or a `hashchange` — never on a synthetic Next. After roughly three seconds with
no progress a `show me` control appears and performs the action itself. `skip`
is present throughout.

The asymmetry is intentional and worth stating: a hard gate is right inside an
app somebody has installed and wrong on a public page somebody is still
evaluating. This is the public page, so nothing may ever block.

### Scroll locks while the tour runs

The spotlight is registered to the frame's on-screen position, so scrolling
behind the scrim desynchronises it. A takeover should not scroll anyway.

### Theming and motion

New `--tour-scrim`, `--tour-panel`, `--tour-text` defined on bare `:root`, then
redefined under `prefers-color-scheme` and `[data-theme]` — never only inside a
media query, per the house rule.

The overlay lays down its **own** dark ground, so callout text must be checked
against *that*, not against the theme's background. `tests/themes.test.ts` gains
those assertions for all five themes. Inheriting a theme's text colour onto a
scrim is precisely how Gruvbox Light would drop below AA with nothing to notice
it — the same failure that test already exists to catch for inherited state
colours.

`prefers-reduced-motion` cuts the spotlight between steps rather than sliding
it.

### The steps

| # | section | hash | anchor |
|---|---------|------|--------|
| 01 | triage | `#/` | the *needs you* group |
| 02 | answer | `#/agent/:id` | option buttons and the Enter-commits line |
| 03 | reply | `#/agent/:id` | composer with slash autocomplete |
| 04 | open what it made | `#/file/:id` | the rendered HTML page |
| 05 | spaces | `#/spaces` | the space tree |
| 06 | themes | `#/settings` | the theme picker |

On a phone the same steps run against the full-width demo: the scrim and
spotlight are unchanged, and the callout takes the dark space above or below the
lit control with a short connector, rather than sitting outside a bezel that is
no longer there. One engine, one visual language, reflowed.

## Application changes

### The demo backend gains the file routes it never had

`src/web/demo/backend.ts` mocks `/api/settings`, `/api/health`, `/api/spaces`,
`/api/harnesses` and the agent routes. It has **nothing** for `/api/files`, so
`#/file/:id` on the hosted demo falls through and the viewer renders an error
today, unprompted by this work.

That is the second instance of one bug. The file's own comment records the
first:

> It had no route at all, so `/api/spaces` fell through to the agent regex below
> and answered 404 — the Spaces screen rendered an error on the hosted demo.

`GET /api/files/:id/meta` and `GET /api/files/:id` are added, serving one
synthetic HTML report with invented content. This closes the live defect and is
what makes step 04 and its screenshot possible at all.

### Settings gains a `How to use` card

In the Info band, linking to the site's tour, from one constant in
`src/shared/links.ts`.

The anchor carries `target="_blank" rel="noopener noreferrer"`, and that is not
decoration. The manifest sets `"display": "standalone"`, so Add to Home Screen
runs chromeless; a same-window navigation to a cross-origin URL from a
standalone PWA historically renders **inside** the app shell with no browser
chrome and no back button. The operator is stranded on the site and has to force
quit paddock to return. iOS 16.4 and later hand such links to the browser, but
the older behaviour is still in the field.

There are currently **no external links anywhere in `src/web/`**, so there is no
house pattern to inherit and nothing to be consistent with. A guard test scans
for any external `href` lacking both attributes, which covers this one and every
future one — the attribute is load-bearing, invisible, and exactly the sort of
thing a later tidy-up removes.

`public/sw.js` needs no thought: it has no `fetch` handler at all, by
design, so it cannot interfere with navigation.

One related rule, addressed rather than ignored: `CLAUDE.md` forbids
special-casing a hostname in the client. That rule protects *derived connection
URLs* — the `localhost` exclusion that silently turns a dashboard into a demo
screen. A documentation link is not that, but it is still a hardcoded URL, so it
lives as a single shared constant rather than being repeated.

## The README

Four screenshots are added, all produced by `paddock serve --demo` with invented
agent names, the blocked one reproducible because `DEMO_BLOCKED_AGENT_ID` never
rotates:

- the agent terminal with its **full action bar** — options, the Enter-commits
  line, the ctrl-key row and the composer visible together. Today's
  `02-blocked.png` shows the prompt and crops the toolbox, so a reader cannot
  see how much is there.
- **Spaces**, which has no representation in the README at all.
- the **composer mid-slash-autocomplete**, illustrating a bullet that is
  currently asserted and unshown.
- the **file viewer** rendering an HTML page.

The demo and install URLs are updated in the five files that carry them:
`README.md`, `install.sh`, the two distribution design and plan documents, and
`.github/ISSUE_TEMPLATE/config.yml`.

## Testing

- **Anchor contract** — every step's `data-tour` exists in `src/web/`. Static,
  no browser.
- **External links** — every external `href` in `src/web/` carries
  `target="_blank"` and `rel` containing `noopener`.
- **Tour contrast** — callout tokens against the scrim ground, AA, five themes,
  added to `tests/themes.test.ts`.
- **Build assembly** — `dist-site/app/index.html` and
  `dist-site/app/manifest.webmanifest` both exist after `build:demo`, and
  `dist-site/install.sh` exists. Each is a silent 404 otherwise.
- **No stale host** — `check-clean` or a sibling test fails on any remaining
  `github.io` reference once the migration lands, so the retirement cannot be
  half-done.
- **Step ordering** — a unit test that a step measures only after its anchor
  resolves, exercising the repaint rule rather than trusting it.

## Documentation owed

- `README.md` — new screenshots, new URLs.
- `docs/decisions.md` — the Pages retirement and its accepted cost; the
  unconditional `data-tour` attribute.
- `docs/gotchas.md` — measure-after-repaint, as the browser sibling of the
  existing TUI entry; the standalone-PWA external link trap.
- `CLAUDE.md` — screenshots rule gains the site; the demo now has two builds.
- Release notes — the install URL has changed.

## Open questions

- **The Vercel URL.** `paddock.vercel.app` is a placeholder throughout. The real
  project name or custom domain must be confirmed before anything is committed,
  since it goes into public files.
