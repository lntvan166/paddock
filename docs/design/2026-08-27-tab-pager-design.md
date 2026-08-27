# Swipe between tabs — a pager for the three destinations

**Status:** approved in design, not yet implemented
**Date:** 2026-08-27
**Supersedes:** nothing. Extends the tab bar introduced on the UI-release branch.

---

## What this changes

The three tab destinations — Agents, Spaces, Settings — become a horizontal
pager. The content follows your finger, rubber-bands at the two ends, and
commits on distance or a flick. The tab bar stops moving with them.

Everything below the tabs — an agent's terminal, a single space — is unchanged
and stays a pushed screen.

## Why, and what was measured

The request was "learn from the Facebook app". Three things were established
before this document, two of them by measurement rather than argument.

**The tab bar blinks today, and the animation is not why.** `App.tsx`,
`Spaces.tsx` and `Settings.tsx` each render their own `<TabBar>`. A route
change therefore destroys the bar and builds a new one. Probed in a browser by
tagging the bar's DOM node and navigating: with the bar inside the screen the
tagged node does not survive; hoisted out, it is the same node before and
after. This is a defect on its own and would be worth fixing with no animation
at all.

**iOS does not take the edge gesture.** A finger-tracking prototype was served
and tested on a real device, in a Safari tab and again from the Home Screen
icon. The gesture was never cancelled and the page was never navigated away, in
either context.

**That result had a confound, and this design removes it.** The prototype never
created a history entry, so Safari's back gesture may simply have had nowhere
to go. Real paddock does create them: `TabBar.tsx` renders plain
`<a href="#/spaces">`, so every tab tap pushes. §3 answers this directly, and
it is the load-bearing decision in this document.

## 1. Two navigation layers

| | peers | descendants |
|---|---|---|
| what | Agents, Spaces, Settings | an agent's terminal, a single space |
| model | pager, side by side | stack, one above the other |
| gesture | horizontal drag | the browser's own back |
| history | `replaceState` | `pushState` |

A tab bar means "these are peers". A stack means "you went into something".
Conflating them is what produces two horizontal gestures with different
meanings, which is the failure this table exists to prevent.

## 2. All three tabs stay mounted

Finger-tracking requires the neighbouring screen to already be on screen at the
moment the drag begins — there is no time to mount one. So the track holds all
three.

Three consequences, all of them wanted:

- **The Spaces reload disappears.** `useSpaceTree` keeps its tree in
  `useState(null)`; today leaving Spaces unmounts it, so returning starts from
  `null` and shows the empty state until the fetch lands. A screen that never
  unmounts never resets. **No cache is added** — the reported bug is deleted
  rather than papered over.
- **Each tab keeps its scroll position.**
- **Two invisible tabs would poll herdr forever.** `use-space-tree.ts` pauses
  its 3s poll on `document.hidden`, which is now insufficient: the document is
  visible while Spaces sits off-screen. §5 covers this; it is the one place
  this design costs something rather than saving it.

## 3. Tab switches stop pushing history

`replaceState`, not `pushState`. Two reasons, and the first is the important
one.

**It makes the device test true in production.** The prototype was validated
with no history to go back to. Keeping `pushState` would hand the edge gesture
a destination and invalidate the only empirical evidence this design rests on.

**It is what a tab bar already means.** Peers are not a stack.

**The cost, stated plainly and accepted by the operator:** today an edge-back
walks backwards through the tabs you visited. It will stop doing that. From a
tab, back means "leave paddock" in a Safari tab, and does nothing in the
installed PWA, which has no earlier entry. Back retains exactly one meaning:
up out of an agent or a space.

## 4. Components

```
App.tsx
  ├── Pager.tsx            ← the track; renders all three tabs
  │     ├── <dashboard>
  │     ├── <Spaces>
  │     └── <Settings>
  └── TabBar.tsx           ← ONE instance, outside the track
```

**`pager-gesture.ts` — pure, no DOM.** Axis lock, rubber-band damping, and the
commit decision are ordinary functions over numbers:

```ts
export function axisOf(dx: number, dy: number, lock: number): "x" | "y" | null;
export function damp(dx: number, atStart: boolean, atEnd: boolean): number;
export function commit(dx: number, velocity: number, width: number): -1 | 0 | 1;
```

This is not tidiness. The test environment is happy-dom, which has no layout,
no `PointerEvent`, and no `visualViewport`; gesture arithmetic embedded in a
component cannot be tested there at all. Extracted, it is the most testable
code in the feature — and the part most likely to be wrong.

`Pager.tsx` binds those functions to touch events and a transform. It owns no
arithmetic of its own.

**Dependency direction is unaffected.** This is entirely within `web/`; nothing
in `herdr/`, `state/` or `ws/` changes.

## 5. The poll must follow the front tab

`useSpaceTree` currently gates on `document.hidden`. With all three tabs
mounted that is no longer the right question — the document is visible while
Spaces is off-screen.

The hook takes an `active: boolean` and polls only when both `active` and
`!document.hidden`. The `tree-stale` event subscription is unaffected: it is
cheap, it is the primary signal, and a tab that is one swipe away should have
current data the moment it arrives.

## 6. Motion

One shared idiom, already in the stylesheet: `cubic-bezier(0.2, 0.8, 0.2, 1)`.

| surface | treatment |
|---|---|
| pager track | 280ms on commit; 1:1 with the finger while dragging |
| rows, tiles, buttons | `:active` background and a ~0.985 scale, ~120ms |
| sheets and menus | match `quick-add-in`, which already exists |
| list changes | **nothing** |

List animation is deliberately excluded. The dashboard repaints itself every
few seconds from live agent state; animating rows in a list that moves on its
own reads as noise rather than feedback. Revisit only with a specific complaint.

`prefers-reduced-motion` is already clamped globally at `styles.css:411`, and
the track's `transition` is included in that clamp.

## 7. Scrollbars — unchanged

Considered and rejected. On iOS the list indicator is transient and takes no
layout space, and native iOS lists show it while scrolling; hiding it would
make paddock less like an app, not more. It is also the only cue for how much
list remains. `CLAUDE.md` forbids device detection, so a hide could not be
scoped to phones anyway — it would land on desktop, where it is most useful.

The terminal pane's existing thin, translucent scrollbars stay as they are;
that block records its own reason (the pane is dark in both themes).

The horizontal direction has no scrollbar to consider: the track uses
`overflow: hidden` and a transform.

## 8. Risks

**A vertical scroll indicator may flash during a horizontal drag**, because the
inner scroller sees the touch before the axis lock resolves. If it shows up on
device, suppress the indicator only while a horizontal drag is live — never
permanently.

**A drag that begins on a row must not fire the row's tap.** The axis lock
resolves after ~8px; a tap that never reaches the threshold stays a tap. Both
cases need a test.

**Nested horizontal scrollers.** `.term-structure` and the terminal pane scroll
horizontally. They are inside pushed screens rather than the pager, so they do
not collide today — but a future horizontal scroller placed inside a tab would.
Note it here so it is a known boundary rather than a surprise.

## 9. What is NOT in scope

- Animating the push and pop of agent/space screens. Separate, and independent.
- Any change to the terminal, the keypad, or push notifications.
- Reordering or adding tabs.

## 10. Testing

- **`pager-gesture.ts`** — unit tests over numbers: axis lock at the threshold
  and either side of it, damping only at the two ends, commit by distance, by
  flick, and the refusal to commit past an end.
- **`Pager.tsx`** — structure in happy-dom: three children mounted, the bar
  outside the track, `aria-current` following the index.
- **`TabBar`** — one instance; a test that fails if a second is ever rendered,
  since three is exactly how this bug arose.
- **`use-space-tree`** — no poll while inactive; poll on becoming active.
- **Geometry belongs in a browser.** happy-dom has no layout. The transform,
  the rubber-band feel, and the indicator flash are verified by measurement at
  390×844, the way the FAB clearance was.

## 11. Open question for implementation

Whether the pager should be disabled while a sheet or menu is open. A drag
beginning on an open create sheet should almost certainly not page. Decide when
`Pager.tsx` meets `RowActions`; the safe default is to ignore touches
originating inside a Radix portal.
