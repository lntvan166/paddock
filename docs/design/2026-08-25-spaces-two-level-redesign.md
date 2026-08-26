# Spaces: two levels — design

**Status:** approved 2026-08-25.
**Supersedes:** `docs/design/2026-08-25-spaces-and-tabs-management-design.md`
§6 "The Spaces screen", and the "Rejected alternatives" list under it. That
document's §6.1 (what paddock does differently from Collie) survives intact
except for the one bullet named in §3 below.

Throughout this document, a bare "§n" is a section of *this* document; sections
of the superseded one are named as such.

---

## 1. Why this exists

The Spaces screen shipped as a single adaptive outline. The superseded §6
argued for it from a
real measurement — six of seven spaces held one tab and one pane, so a
drill-down would have spent two levels rendering one child each — and recorded
drill-down as rejected.

The measurement was sound. The conclusion was wrong, and this document records
why rather than quietly replacing it.

That section counted **children per space**. It never counted **controls per
row**. At
390px the shipped screen measures:

| | |
|---|---|
| spaces | 11 |
| rows rendered | 11 |
| list height | 706px of an 844px viewport |
| rows needing a scroll | 0 |
| controls per row | 3 — the row link, `⋯`, `+` |
| **tap targets on one screen** | **33** |

The screen is not too long. It carries eleven `+` buttons for an action taken
rarely, and eleven `⋯` beside them. That is the cost the second level removes:
management affordances live on the screen where you have already chosen what
you are managing, and the list goes back to being a list.

This is a restructure **and** a restyle. §5 covers the information
architecture; §6 covers how a row reads; §7 corrects three icons found in the
same pass.

---

## 2. Scope

**In:**

- `#/spaces` becomes a spaces-only list. One control, in the header.
- A new screen, `#/space/<spaceId>`, listing that space's tabs, where rename,
  close and create live.
- Switching spaces from that screen's header title, via a picker sheet.
- The back chain: pane → the space it was opened from → the list → dashboard.
- Row restyle (§6) and three icon corrections (§7).

**Out:**

- The agent terminal's layout, transcript, keypad and reply box. Unchanged.
  One exception, in §7.3: an illegible glyph in its header is removed.
- Server routes. Every route this needs already exists — the nine management
  routes and `GET /api/spaces` shipped on `feat/spaces-manage`. **This is a
  UI-only change.** §3's invariant (management routes may read `AgentStore`,
  never write to it or enqueue to the hub) is untouched because no route is
  touched.
- `SpaceTree`'s shape. `src/shared/types.ts` is not edited.

---

## 3. What this changes in the record

Two claims in the superseded text are now false, and one bullet in §6.1 goes:

- **"Not a drill-down"** — it is a drill-down now, at two levels, not three.
  Tabs are the second level; panes are not a third (see §5.3).
- **"Collapsing stays available and defaults to open"** and the per-space
  collapsed state in `localStorage` under `paddock.spaces.collapsed` — both
  gone. There is nothing to collapse on either screen. The key is dropped, not
  migrated: it holds a set of space ids that no longer addresses anything, and
  a stale key that silently does nothing is worse than an absent one.
- **§6.1's "No horizontal scroll rails"** stays as a rule but loses its
  reasoning-by-contrast, because paddock now has two levels like Collie does.
  What paddock still refuses is the *rail* — see §5.2.

The three surviving §6.1 differences (visible `⋯` rather than an unhinted
long-press; state said once; spaces with no agent visible) all still hold and
all still bind.

---

## 4. Routes

| Hash | Screen |
|---|---|
| `#/spaces` | the list of spaces |
| `#/space/<spaceId>` | one space's tabs |
| `#/pane/<paneId>` | a pane, unchanged |

`#/space/` singular, matching `#/pane/` — the plural is the collection, the
singular is one member. An unknown or vanished `<spaceId>` renders the same
"that space is gone" state a vanished pane already gets, and offers the list;
it must never render an empty tab list, which is indistinguishable from a real
space that has none.

### 4.1 The back chain

`App.tsx` already records where a pane was opened from, on the real
`hashchange`'s `oldURL` rather than guessing. That mechanism stays; its stored
value changes.

Today it stores a boolean: `fromSpaces: hashOf(e.oldURL) === "#/spaces"`. A
boolean cannot express *which* space, so it must become the origin hash itself
— `origin: hashOf(e.oldURL)` — and the back target is that string when it is
a spaces-family hash, the dashboard otherwise. Keeping the boolean and
appending a second field for the space id would let the two disagree; one
field cannot.

Back from `#/space/<id>` goes to `#/spaces` unconditionally. There is only one
route into it.

---

## 5. The two screens

### 5.1 The list — `#/spaces`

One row per space. No `⋯`, no `+` on any row. The header carries a single `+`
(create a space) beside the back control.

A row shows three things and nothing else: the space's label, its rollup
state, and its pane count. The count is the honest cheap answer to "is there
structure in here" — a space showing `1` opens onto a single tab, and a space
showing `4` is worth the tap.

Rows sort **blocked first**, then working, then everything else, then spaces
with no agent. The dashboard already sorts by urgency and an operator moving
between the two must not relearn an order.

### 5.2 One space — `#/space/<spaceId>`

The header title is the space's label, marked as a control, and tapping it
opens the **space picker**: a bottom sheet listing every space, sorted as §5.1
sorts, with the current one marked. Tapping one replaces the current screen.

This is deliberately not Collie's chip rail. At 390px a chip carrying a dot
and a label runs about 110px, so three of eleven spaces would be visible and
eight would sit behind a sideways scroll with nothing saying they exist — and
the rail costs about 48px of height permanently. A sheet shows all eleven, and
would show forty. It is also the component `CLAUDE.md` already sanctions
shadcn for, and the one `RowActions` already uses.

Below the header, one row per **tab**. `⋯` on a row acts on that tab; `⋯` in
the header acts on the space. The two must never be the same glyph in the same
place — the header's sits at the trailing edge of the header, the row's at the
trailing edge of its row.

The last row of the list is **`+ New tab`** — a row, in the list it adds to,
not a floating button. It is the one create affordance on this screen, and it
reads as the end of the list because that is where a new tab appears.

### 5.3 A tab row, and why panes are not a third level

A tab holding exactly one pane **is** that pane: the row opens it directly.
A tab holding several renders its panes as indented sub-rows, and the tab row
itself opens the tab's root pane.

This is the merged-row principle the superseded §6 applied at space level,
moved down one
level, and it is what keeps the drill-down honest for a flat herd: on the
machine this was measured against every tab holds one pane, so every tab row
is one tap to an agent. Structure appears only where it exists. A third level
is never rendered because a pane has no children.

---

## 6. How a row reads

**Style A, the quiet dot.** A `StatusDot` carries state; nothing else does.
Hairline dividers, no per-row card, no border. The accent colour appears only
on the one control the screen offers.

The alternative considered was a 3px semantic stripe on each row's leading
edge, so the herd's health reads as a column of colour before any word is
read. It is genuinely better at "which space needs me" — and that question
already has a screen one tap away. Answering it twice on the screen whose job
is structure is how this list came to carry everything in the first place.
Rejected for that reason, not because it looks worse.

State is still said in text beside the dot, because `StatusDot` is
`aria-hidden` and this palette spends red and green on the two states that
matter most.

---

## 7. Three icon corrections

Found while measuring the screens above. Each is a defect with a measurable
cause, not a preference.

### 7.1 The Settings glyph is a sun, not a gear

`SettingsIcon` in `src/web/components/ui/icons.tsx` draws a circle at `r=3.2`
and six detached radial ticks in the annulus between roughly `r=6.5` and
`r=9.5`. There is no outer rim. Detached ticks around a small circle is the
standard **brightness/sun** glyph; a gear's teeth are teeth *of* a rim, and
without one they are not teeth.

The existing comment shows how it happened: it worried that "more teeth close
the gaps between them into a ring" and removed the rim to keep the teeth
distinct. That fixed the density and broke the metaphor.

**Replacement: a sliders glyph** — two horizontal tracks, one knob on each.
Chosen over adding the rim back because the header renders at 18px, where the
gear's annulus is about 3.9px wide and each tooth about 1.1px; the sliders
have no annulus and no detail inside a ring, and their smallest feature is a
3.2px knob. Nothing goes sub-pixel.

It stays hand-written in `ui/icons.tsx`. `CLAUDE.md` is explicit that
paddock's own glyphs are not switched to lucide, and the file's header comment
records why. Update that comment's count if the glyph total changes.

### 7.2 `.dot-none` renders as a broken circle

`src/web/styles.css:1846` gives the no-state dot `border-style: dashed` on a
7px box with a 1.5px border. Its border centreline is about 17px round;
browsers draw dashed borders with dash and gap each roughly twice the border
width, so about 2.9 periods must close a circle — and a rounded box's four
sides are stroked separately, each with its own dash phase. The result is two
or three arcs of unequal length with visible gaps: an *incomplete circle*,
which is how it was reported. This is inherent to dashed borders at this
radius, not a quirk of one browser.

The intent is right and stays: a shell has no triage state, so it must not
borrow `idle`'s hollow ring. The channel is wrong. `StateIcon`'s own comment
already names the right one — *a shape survives what a hue does not* — so
no-state becomes a **hollow 7px square**, `border-radius: 1.5px`, same
footprint, same border width, complete outline, unmistakably not a circle at
7px.

Same geometry as `.dot` for the same reason the dashed version cited: making a
state hollow must not also move it.

### 7.3 The blocked pill's icon is illegible

`AgentTerminal.tsx` renders `<StateIcon state="blocked" size={11} />` inside
`.term-state`. lucide scales stroke width with size, so at 11px the stroke is
0.92px, the circle is 9.2px across, and inside it sit a 1.8px bar and a
sub-pixel dot. It is a smudge, not a shape.

**The icon is removed; the pill stays.** `StateIcon` exists to add a third
channel because red and green are confusable — but this pill only ever renders
for `blocked`, so there is no green pill here to confuse it with, and the
pill's own tinted, bordered, uppercase treatment *is* the shape channel
against the bare dot every other state gets. An illegible glyph adds noise,
not a channel, and removing it returns about 13px to a header that three
separate comments in that file call width-starved.

`StateIcon` itself is untouched — `AgentCard` renders it at its 13px default,
where it is legible, and `tests/state-icon.test.tsx` keeps covering it.

---

## 8. What is deliberately not changing

- **No device detection.** Width media queries for layout, `(pointer: coarse)`
  for interaction. The picker sheet is not conditioned on anything about the
  device.
- **No new colour outside a token.** Tokens on bare `:root`, redefined under
  `prefers-color-scheme` and `[data-theme]`, so a manual toggle still wins both
  directions.
- **No webfont.** Decision 6 stands and `tests/tokens.test.ts` guards it. The
  restyle achieves its distinctiveness through layout, weight, colour and
  structure, which is the constraint every paddock screen already works under.
- **`spacesAvailable` still gates the entry point.** In `--demo` there is no
  herdr session, so `HostHeader` renders no Spaces control at all rather than
  one that errors. This also means neither new screen can appear in a README
  screenshot — the existing limitation, unchanged.
- **Server, store, hub, adapter.** Untouched. Dependency direction unchanged.

---

## 9. Testing

The suite is at 1455 and every existing test must still pass, **except** those
asserting the superseded structure. Those are a deliberate behaviour change,
not a refactor, so they are rewritten rather than preserved:

- collapse/expand behaviour and the `paddock.spaces.collapsed` key
- assertions that a space row carries `⋯` or `+`
- assertions that `#/spaces` renders pane sub-rows

New coverage, each of which must be seen to fail before it passes:

1. **The list carries no row controls.** Render `#/spaces` with a mixed tree
   and assert zero `⋯` and zero `+` inside the list — the guard against the
   33-target regression. Must fail if one is put back.
2. **Sort order** — blocked first, no-agent last, on a tree that is not
   already in that order.
3. **A one-pane tab opens its pane directly**, and a multi-pane tab renders
   sub-rows. Both from a tree containing one of each, so neither passes by
   the fixture's shape.
4. **The picker switches space** and marks the current one.
5. **The back chain**, all three legs, driven through real `hashchange`
   events with an `oldURL` — including a pane opened from `#/space/<id>`
   returning to *that* space, which a boolean origin cannot express.
6. **An unknown `spaceId`** renders the gone state, not an empty list.
7. **`.dot-none` is not dashed** — assert the computed `border-style` is
   `solid` and `border-radius` is not the pill radius. It must fail against
   today's stylesheet.
8. **The blocked pill has no `svg`**, and still has its word.
9. **`SettingsIcon` has no lone inner circle with detached ticks** — assert
   its rendered shape, and keep `tests/ui-icons.test.tsx`'s existing export
   roll-call passing.

`make check-clean` before every commit, unpiped — piping it hides its exit
status, which has let a failing scan through once already. Fixtures use
invented names only: `api-refactor`, `flaky-test-fix`, `docs-cleanup`,
`schema-migration`. The scanner bans the literal `/home/`; fixture paths use
`/base/operator` or `/srv/project`.

---

## 10. Files

| File | Change |
|---|---|
| `src/web/components/Spaces.tsx` | becomes the list; loses collapse state |
| `src/web/components/SpaceRow.tsx` | becomes a list row: label, dot, count |
| `src/web/components/Space.tsx` | **new** — one space's tabs |
| `src/web/components/TabRow.tsx` | **new** — a tab row and its pane sub-rows |
| `src/web/components/SpacePicker.tsx` | **new** — the header sheet |
| `src/web/components/App.tsx` | the new route; origin becomes a hash |
| `src/web/components/AgentTerminal.tsx` | drop the pill's `StateIcon` |
| `src/web/components/ui/icons.tsx` | `SettingsIcon` → sliders |
| `src/web/styles.css` | `.dot-none` → square; row and header restyle |

`RowActions.tsx` and `CreateSheet.tsx` are reused as they are — the sheets do
not change, only where they are reached from. `pane-label.ts` is unchanged and
remains the one home for §16.6's labelling rule.

`SpaceRow.tsx` is 297 lines today and does the merged-row reasoning for
spaces, tabs and panes at once. Splitting the tab-level work into `TabRow.tsx`
rather than growing it further follows the same responsibility split the
architecture rules ask for.
