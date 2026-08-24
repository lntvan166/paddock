# UI primitives — design

paddock's dashboard tells you an agent's state with a 7px coloured disc and
nothing else. Every row is otherwise identical: same border, same surface, same
weight. An agent that has stopped and needs a person is distinguished from one
that has nothing to say by hue alone.

CLAUDE.md already forbids this — *"No hover-only affordances"*, *"Never define a
colour only inside a media query"*, and `AgentRow`'s own header says *"Colour is
never the only channel"*. That last claim is half true today: the state is
carried as text on the **card** view and in the aria label, but on the dashboard
**row** the only difference between blocked and idle is `--danger` versus
`--fg-dim`.

This design gives urgency a second, non-colour channel, and builds the small
shared component vocabulary needed to do it once rather than five times.

The scope is deliberately narrow: **a primitive layer, the screens that consume
it, and one section split.** `AgentTerminal.tsx` (898 lines) is not touched. No
new runtime dependency is added.

---

## Why the current styling cannot simply be extended

paddock is split down the middle on how a component is styled, and the split is
not a gradient — it is two vocabularies with no shared members.

- `Settings.tsx` and `src/web/components/settings/*` style through semantic
  classes in `styles.css`: `.settings-section`, `.settings-field`,
  `.settings-hint`, `.settings-field-row`.
- `AgentRow`, `Section`, `HostHeader` do the opposite: inline Tailwind
  utilities plus `style={{ background: "var(--surface)" }}`.

Neither is wrong, and both work. But a *shared* primitive cannot be written
twice, and picking by coin-flip would leave the third vocabulary sitting beside
the first two.

**Semantic CSS classes win, for a reason specific to what these primitives
are.** A toggle needs a transition, a focus ring and a disabled state. A
segmented control needs a checked state. Those are exactly the things paddock is
required to get right — `prefers-reduced-motion`, `:focus-visible`, tokens
defined outside media queries — and exactly the things that get verbose and
easy to forget when expressed as inline variants across a dozen files. Putting
them in `styles.css` makes the rule auditable by reading one file, which is how
the existing colour rule is already enforced.

`.settings-*` is deleted as the settings rebuild lands, rather than left
standing beside the new vocabulary.

## What the reference implementation actually does

The patterns below were captured from the live
[collie](https://github.com/AltanS/collie) demo at a 390×844 viewport, driven
with Playwright, on build `v0.32.1 · 2031ed7`. This matters because collie's
committed `assets/*.png` are eight minor versions stale and disagree with the
running app on two points that would have been designed in wrongly: the live
dashboard rows carry **no** cwd second line, and the section taxonomy has five
members rather than three.

Full capture notes and screenshots are not committed — they live outside the
repo, since they are third-party UI.

Three findings are load-bearing here:

1. **The row container is the attention channel.** Needs-you is a bordered,
   tinted card; finished-but-unseen is a plain bordered card; working and idle
   are bare rows with hairline separators. Urgency survives greyscale, which is
   the property paddock's own comment claims and does not yet have.
2. **Resting states are hollow rings, active states are solid discs.** Their
   status-badge comment gives the reason: the palette is tuned for *text*
   contrast, so as solid discs eighteen idle dots out-shout the one thing that
   needs you. The ring's interior must be painted the surface colour, not left
   transparent — over a tile corner, transparent reads as a notch cut out of
   the icon.
3. **A disabled control always states why, inside its own card.** Their push
   toggle is greyed with a divided footer reading *"The bridge has no VAPID keys
   configured, so push is disabled server-side."* A control that is inert and
   silent is the failure mode.

What is deliberately **not** taken: their icon library (lucide) and card
primitives (shadcn/ui). paddock is hand-rolled Tailwind v4 plus CSS variables
and stays that way — bringing the look must not smuggle in the stack. Real
third-party brand logos are also declined; see *Harness identity* below.

---

## The primitive layer

New directory `src/web/components/ui/`. Every file is a thin wrapper holding
props, ARIA and composition; all visual state lives in `styles.css`.

### `Card.tsx`

Border, surface, radius, and an optional header of `icon` + `title` +
`subtitle`. Three slots, and the two layouts observed in the reference fall out
of which ones are used:

- `control` — rendered right-aligned **inside the header row**, vertically
  centred against a two-line title+subtitle. This is the inline-toggle layout.
- `children` — rendered below a divider. This is the header-then-body layout.
- `footer` — rendered below a second divider, dimmed and small. This is where a
  disabled control's reason goes.

### `Toggle.tsx`

`<button role="switch" aria-checked>`, with a track and knob. Takes `disabled`.

It deliberately does **not** take a `reason`. The explanation belongs to the
setting, not to the switch — paddock's own case is `NotifySection`'s
browser-permission block, which is a fact about the device rather than about the
control — so the reason is passed to `Card.footer` by the caller. Keeping
`Toggle` to one job is also what lets it be tested without a card around it.

### `Segmented.tsx`

`role="radiogroup"` over `options: { value, label, icon }[]`. Selection is
rendered as a filled high-contrast pill, never as a hue change, so the selected
member survives greyscale like everything else here.

Replaces two `<select>` elements. A native select on iOS opens a full-screen
wheel to choose between three values, which is more ceremony than the choice
deserves and hides the other options while you pick.

### `IconTile.tsx`

A **round** tile carrying an agent's harness identity: initials, on a
deterministic per-harness background, with its own foreground. Round rather than
the reference's rounded square, by preference.

Two properties are non-negotiable:

- **It carries its own background.** A tile that inherited the page surface
  would need a different mark per theme; carrying its own means one definition
  reads on both.
- **`badge` slot overlays the bottom-left corner.** The status dot goes here
  rather than beside the name. At 390px the horizontal budget is the scarce one,
  and an overlaid dot costs nothing where a sibling dot costs a column.

Hue is derived from the harness string by a small stable hash into a fixed
palette, so `claude` is always the same colour without a hardcoded table that
silently omits every harness nobody thought of.

### `StatusDot.tsx`

Replaces `AgentRow.StateDot`. Hollow ring for resting (`idle`), solid fill for
active (`blocked`, `done`, `working`).

`AgentRow`'s existing header comment documents the traffic-light palette and why
`working` stopped borrowing `--accent` and `blocked` stopped borrowing amber.
That reasoning is still correct and must move with the code, extended with the
ring/fill rule — not dropped. A palette comment that goes missing is how the
next change re-borrows `--accent`.

### `icons.tsx`

Eight 24×24 stroke paths on `currentColor`, `aria-hidden`, sized by the caller —
one per card in the settings inventory below:

| glyph | card |
|---|---|
| monitor | Appearance |
| activity | Live updates |
| terminal | Terminal |
| bell | Notifications |
| send | Telegram |
| link | Remote access |
| refresh | Updates |
| plug | Connection |

Hand-written inline SVG following `Mark.tsx`'s existing precedent.

An icon library is not added for eight glyphs. lucide-react is ~30kB of
tree-shaken JS for what is here a few hundred bytes of path data, on a project
whose bundle is deliberately one chunk because at high RTT a round trip costs
more than the bytes.

---

## Contract changes

### `Agent.harness: string`

`HerdrAgentRaw.agent` is the harness name — `"claude"`, `"codex"` — and it is
**already on the wire**. `src/server/herdr/adapter.ts:toAgent` uses it as a
truthiness gate (`if (!rawAgent.agent) return null;`) and then throws the value
away.

So the tile costs one field in `adapter.ts`, one in `src/shared/types.ts`, and
no protocol work at all.

Named `harness` rather than `agent`, because `Agent` is already the name of the
type it lives on.

**Required, not optional**, on the reasoning `hasJournal` already records: an
optional field lets a future edit drop it silently, and every tile would fall
back to a placeholder with nothing to notice. It is safe to require, because
`toAgent` already returns `null` for any raw agent whose `agent` is falsy — a
surviving `Agent` always had one.

### Four sections, not three

Today `sectionFor` routes **both** `blocked` and unacknowledged `done` into
`needs-you`:

```ts
if (agent.state === "blocked") return "needs-you";
if (agent.state === "done") return agent.acknowledgedAt === null ? "needs-you" : "idle";
```

The comment above the second line says an acknowledged finish *"stops competing
for attention with agents that still need some"* — which is true, and leaves the
**un**acknowledged finish competing directly with a genuinely stuck agent. Those
are different urgencies: one wants a decision before work continues, the other
is just news you have not read.

```
SECTION_ORDER = ["needs-you", "ready-unseen", "working", "idle"]

sectionFor:  blocked                 → needs-you
             done && !acknowledgedAt → ready-unseen
             done && acknowledgedAt  → idle
             working                 → working
             _                       → idle
```

`compareAgents` needs no change — it indexes `SECTION_ORDER`, so section order
follows automatically on both the server's snapshot sort and the client's
post-delta re-sort.

The key is `ready-unseen` and the displayed title is **`Ready`**. The key keeps
the precision that the section means *finished and not yet looked at*; the label
stays in paddock's plainer register beside `Needs you` / `Working` / `Idle`.
`Done` is rejected as a label because `done` is also a state, and an
acknowledged `done` renders under `Idle` — a label that contradicted the state
name in one of its two cases would be worse than a new word.

The comment at `types.ts:316` is rewritten: it currently explains a two-way
split that no longer exists.

### One new token

`--danger-wash`, the tint behind an alert row. Defined in **all three** theme
blocks — bare `:root`, the `prefers-color-scheme: dark` block, and
`:root[data-theme="dark"]` — because a token defined only in a media query
leaves the manual toggle with nothing to fall back to.

Hand-picked hex per theme rather than
`color-mix(in oklab, var(--danger) 8%, var(--bg))`. Every other colour in
`styles.css` is spelled out in all three blocks; a computed token would be the
one value an operator cannot read off the file.

---

## Dashboard refit

**Superseded by what shipped — see below.** This section originally specified an
`AgentRow` emphasis ladder (`"alert" | "card" | "bare"`, one step per section) so
that a row's own container escalated with its section. It was designed, built in
Task 10 of the implementation plan, and then **deleted as dead code** in commit
`b505a06`: this section's own premise — that `needs-you` and `ready-unseen` render
`AgentRow` — turned out to be wrong. `App.tsx` renders `AgentCard`, a full card
with its own border and fill, for BOTH attention sections; `AgentRow` is used only
for `working`, where every row is bare by construction. With no section left that
renders an `AgentRow` at anything other than the bare rung, the ladder had nothing
left to climb, so `type RowEmphasis`, `emphasisFor(section)`, the `emphasis` prop,
`data-emphasis`, and `.row[data-emphasis="…"]` were removed rather than kept as
unreachable code.

`--danger-wash` did not disappear with the ladder — it moved to `AgentCard`'s own
`surface` for a blocked agent (border AND fill, the same reasoning this section
originally gave for `alert`).

What survived, unchanged in spirit: `AgentRow` still carries the round `IconTile`
with the `StatusDot` overlaid at the bottom-left, plus a `.sr-only` element
holding the state word as text — the second channel this section always argued
for, just attached to `AgentCard` for the two sections that need it and to the
bare `AgentRow` for the rest.

The shipped shape is the better one — the point of this note is only that the
implementer who searches this document for `AgentRow`'s `emphasis` prop should
find this paragraph instead of a described feature that grep will never turn up
in the code. See `docs/plans/2026-08-24-ui-primitives.md`, Task 10, for the
delete's own note.

**Idle keeps its `AgentChip` cloud.** A wrapped cloud of name-only pills is the
densest form available on a phone whose idle section is routinely five of six
agents, and the contrast between "cloud" and "rows" is itself an urgency
signal — a fourth rung on the ladder, for free. Giving idle agents full rows
would cost roughly three times the vertical space to say nothing.

`SectionHeader` gains a leading `StatusDot` and a `trailing` slot. The trailing
slot renders as a **sibling** of the fold button, never nested inside it —
nested, pressing the control would also fold the section.

---

## Settings rebuild

Each labelled group becomes a `Card`. The structure that must survive is stated
in `Settings.tsx`'s own header, and it is not cosmetic:

> "This device" writes straight to localStorage via `@web/prefs` and takes
> effect immediately, no network round trip. "All devices" is a form over one
> `SettingsView` fetched from the server; nothing in it applies until Save
> succeeds.

Cards must not blur that distinction, so the two groups survive as **labelled
bands** with cards inside them, and `SaveBar` still governs only the second
band. A single flat wall of visually identical cards would imply one commit
model where there are two, and the failure it invites — believing a switch is
set when Save never happened — is the exact one the current split exists to
prevent.

**This device** (immediate)

| Card | Contents |
|---|---|
| Appearance | `Segmented` theme: System / Light / Dark, replacing the `<select>` |
| Live updates | `Segmented` rate: Live / Balanced / Frugal, replacing the `<select>` |
| Terminal | font size (number, blank = automatic), wrap `Toggle`, keypad-auto `Toggle` |

**All devices** (form, governed by `SaveBar`)

| Card | Contents |
|---|---|
| Notifications | `NotifySection` — enable, triggers, settle, cooldown, mute |
| Telegram | `TelegramSection` — token, chat id, test |
| Remote access | `TunnelSection` — rendered only when `SettingsView.tunnel` is non-null |

**Info** (read-only)

| Card | Contents |
|---|---|
| Updates | version in the subtitle; existing `managedBy`-aware upgrade copy in the body |
| Connection | diagnostics `<dl>` |

The font-size field keeps its comment about why an empty string must write
`null` rather than `Number("")`. That is a live bug fix, not documentation of
the obvious.

### What the `footer` slot is actually for here

The reference implementation's example is a browser push permission being
denied. **paddock has no such case:** it has no web-push and never calls
`Notification.requestPermission` — notifications are Telegram, sent server-side.
CLAUDE.md's rule against an application auth token is the related reason the
service worker stays ungated; browser push was never part of this.

The slot is still justified, by two cases paddock does have, both currently
rendered as inline `.settings-banner` paragraphs:

- **`NotifySection`'s quick-tunnel warning.** `isQuickTunnelUrl(publicUrl)`
  explains that a quick-tunnel hostname changes every run, so saving it points
  notification links at a name that has stopped resolving. That is an
  explanation of why a field should be left alone — exactly a footer.
- **`saveError`**, which belongs to the card whose Save failed rather than
  floating at the bottom of the band.

---

## Version, diagnostics, and the build stamp

### No server work is required

`/api/health` already returns everything the Connection card needs: `version`,
`latestKnown`, `managedBy`, `herdrConnected`, `lastEventAt`, `lastNotifyError`,
`herdrProtocol`, `schemaWarning`.

### Updates card

Version lives in the **subtitle** — `Running v0.8.5 · checked just now` — with
the body reusing the existing `managedBy`-aware upgrade copy, so a Homebrew
install still gets the command that does not decline. This is the v0.8.5
`ReleaseBanner` fix and must not regress.

### Connection card

A read-only `<dl>`: dimmed label left, **monospace** value right, hairline
dividers. Values that are verdicts (`Connected`, `Not enforced`) carry a colour
*in addition to* their text.

**Every row is always rendered**, showing an em dash while loading, rather than
appearing when its data arrives. A row that appears late grows the card and
shoves everything below it down the page — under a thumb already reaching for
something.

### Build stamp

Monospace, 11px, centred, at the bottom of the dashboard scroll region:

```
v0.8.5 · 4e1c9d2 · 2026-08-24 08:41 UTC
```

**The three fields are not the existing build id.** `buildIdFrom()` returns
concatenated hashed asset filenames — `index-Cj_7W-bH.js+index-9xKq2p.css` —
which is the right identity for *comparison* and far too long to read off a
footer. The stamp is a separate, human-facing triple, injected into the bundle by
a new `define` in `vite.config.ts`:

| field | source | dev fallback |
|---|---|---|
| version | `PADDOCK_VERSION` | `0.0.0-dev` |
| commit | `PADDOCK_COMMIT`, from `git rev-parse --short HEAD` in the Makefile | `dev` |
| time | `PADDOCK_BUILD_TIME`, stamped by the Makefile | build-time `now` |

Each falls back rather than failing, because a source build with no git checkout
must still produce a working binary — and `VERSION` already establishes exactly
this pattern (`process.env.PADDOCK_VERSION ?? "0.0.0-dev"`), for the stated
reason that a bug reported against a self-compiled binary needs to say so.

The fallback is a literal `dev`, never an invented hash. This is
`build-id.ts`'s own rule — *"Null rather than a placeholder … inventing an id
there would make every client believe a new build had just landed"* — and the
same trap applies to a stamp that fabricates a commit.

Half of the surrounding machinery already exists and must be reused rather than
reinvented.
`src/server/build-id.ts` derives an id from the hashed asset filenames in the
served `index.html`; `store.ts:trackBuild` latches a change into
`updateAvailable`; `UpdateBar` prompts for a reload. The three false-alarm rules
in `trackBuild` — adopt the first id silently, ignore `null`, latch once
raised — stay exactly as they are.

What is missing is only that the **bundle** cannot name itself. `vite.config.ts`
has no `define` block; one is added so the stamp reports the version of the
JavaScript actually running, which is the entire point of showing it. The server
id it is compared against is already in `state.build`.

---

## Testing

TDD throughout; `make check`, `make test` and `make check-clean` gate every
commit.

| Area | Test |
|---|---|
| `sectionFor` | all five branches, including both `done` cases |
| `groupAgents` | four buckets, and ordering preserved through the shared comparator |
| `adapter.ts` | `harness` mapped from `HerdrAgentRaw.agent`; falsy still yields `null` |
| `IconTile` | initials derivation; hue stable across calls for the same harness |
| `StatusDot` | ring for `idle`, fill for the other three |
| `Toggle` | `role="switch"`, `aria-checked` tracks state, `disabled` blocks activation |
| `Segmented` | `role="radiogroup"`, keyboard selection, one checked member |
| `AgentCard` | rendered for both `needs-you` and `ready-unseen`; accent by state, not section |

`grouping.test.ts` and any fixture carrying an `Agent` need the new `harness`
field — required fields break fixtures at compile time, which is the point.

## Order of work

Five independent commits, each shippable alone:

1. **Primitives + CSS + icons.** Pure addition, no consumer, no behaviour
   change. Tests only.
2. **Contract.** `Agent.harness`, four-way `sectionFor`, `--danger-wash`.
3. **Dashboard refit.** Rows, tiles, section headers.
4. **Settings rebuild.** Cards and bands; delete `.settings-*`.
5. **Stamp and diagnostics.** Vite `define`, Updates and Connection cards.

## Public-repo note

The Connection card renders the real endpoint hostname and the real herdr
protocol version. Any screenshot of this screen must come from
`paddock serve --demo`, per CLAUDE.md — there is no narrow-exception case here,
because the card is nothing but session content.
