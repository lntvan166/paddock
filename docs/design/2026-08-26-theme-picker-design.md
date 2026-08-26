# Theme picker — design

**Date:** 2026-08-26
**Status:** approved, not yet implemented

A per-device theme picker in Settings, offering paddock's own palette plus a
small set of well-known ones: Dracula, Gruvbox Dark, Gruvbox Light, Nord.

---

## 1. Why this needs a design at all

Dropping in a palette looks like a ten-minute job. It is not, and the reason is
the difference between what these palettes ARE and what paddock's palette IS.

Dracula, Gruvbox and Nord are **syntax-highlighting** palettes. Their red is a
keyword colour; it means "this token is a string literal", which is to say it
means nothing outside an editor. paddock's palette is **semantic**, and the
stylesheet is explicit about it:

> Red is the loudest colour in the app and is spent on ONE thing: an agent that
> has stopped and needs a person. `--warn` (amber) means "in motion or
> degraded", which is what a working agent is. Before this existed, blocked
> borrowed amber and `working` borrowed `--accent` — the same token every link
> and button uses for "you can tap this", so a state competed with the
> interaction colour.

So a theme cannot simply hand its colours over. Every theme has to answer: what
carries "needs you" here, and is it still legible and still unmistakable?

### The measurement that shaped this design

The first instinct — "themes change the chrome, the state colours stay fixed" —
turns out to be unsafe. paddock's dark state colours were tuned against
`--bg: #08090a`, a near-black. Every popular theme uses a **lighter** ground, so
the same hexes lose contrast against it.

Measured, WCAG 2.1 relative luminance, AA text threshold 4.5:1:

| theme | ground | `--danger` | `--warn` | `--ok` | `--fg-dim` |
|---|---|---|---|---|---|
| Dracula | `#282a36` | **4.25** | 6.66 | 5.61 | **4.38** |
| Gruvbox Dark | `#282828` | **4.40** | 6.90 | 5.80 | 4.54 |
| Nord | `#2e3440` | **3.73** | 5.84 | 4.92 | **3.84** |
| Solarized Dark | `#002b36` | **4.48** | 7.03 | 5.91 | 4.62 |
| Gruvbox Light | `#fbf1c7` | 4.72 | **4.33** | **4.48** | 5.10 |
| Catppuccin Mocha | `#1e1e2e` | 4.89 | 7.68 | 6.46 | 5.05 |
| Tokyo Night | `#1a1b26` | 5.10 | 8.00 | 6.73 | 5.26 |

Bold entries fail AA. The four themes most worth having are exactly the four
that fail, and the token that fails most often is `--danger` — the one thing
this application exists to signal.

**The resolution is a distinction we did not draw at first: the MEANING stays
fixed, the HEX may be tuned.** Red still means blocked in every theme. A theme
may supply its own red solely as a legibility adjustment for its own ground,
and a test verifies it. That is not "Dracula decides what blocked looks like";
it is "a red that works on Dracula's ground carries blocked".

---

## 2. Decisions, and what was rejected

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Theme scope | Chrome, plus state colours tuned for legibility only | Full remap to the theme's own semantics — a theme's green would have to mean "finished", and nothing guarantees its trio is separable at 8px |
| Light/dark | **Flat list.** Each entry is one palette | Two axes (theme × mode) — Dracula has no light variant, so the UI would have to disable combinations that do not exist |
| Where palettes live | Built into `styles.css` as `:root[data-theme=…]` blocks | A server setting (plumbing for something two taps already solve); user-supplied palettes (nothing can audit a palette the app has never seen) |
| Picker control | `<select>` | `Segmented` — it holds three options well and eleven badly |

**Accepted cost:** a named theme stops following the OS. Someone on Dracula
gets Dracula at noon. This is inherent to the flat list and is the right trade
for a picker whose entries are, by definition, deliberate choices.

---

## 3. The mechanism

Each theme is a block in `styles.css`, using the mechanism `[data-theme="dark"]`
already uses:

```css
:root[data-theme="dracula"] {
  --bg: #282a36;
  --surface: #343746;
  /* … */
}
```

### 3.1 One existing rule must change

Today the dark palette is applied by:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark tokens */ }
}
```

That guard means "system dark applies unless the operator pinned light". With
named themes it is wrong: `dracula` is not `light`, so the guard still matches,
the system-dark values apply underneath, and the Dracula block only wins because
it happens to appear later in the file. Correctness by source order is the kind
of thing that survives until someone reorders the file.

**The guard becomes `:root:not([data-theme])`** — system dark applies only when
no theme is pinned at all. Each theme then fully owns its palette, and the four
cases hold independently:

| Preference | `data-theme` | What applies |
|---|---|---|
| System | *absent* | bare `:root`, overridden by the media query on a dark OS |
| Light | `light` | bare `:root` |
| Dark | `dark` | `:root[data-theme="dark"]` |
| Dracula | `dracula` | `:root[data-theme="dracula"]` |

This is a simplification, not an addition: the guard stops naming one special
case and states the actual rule.

### 3.2 What a theme must NOT touch

- **`--term-bg` / `--term-fg`.** Already defined once for both themes, and the
  stylesheet explains why: herdr sends the agent's own truecolor escapes, and a
  coding agent picks them for a dark terminal — `38;2;255;255;255` is white
  text, invisible on a light pane. A Gruvbox Light theme with a cream terminal
  would render an agent's white output onto cream. The pane keeps the ground
  those colours were written for, in every theme.
- **`--tile-*` and `--tile-fg`.** Tiles carry their own background and
  foreground, so a mark on one does not change meaning when the page does. Each
  hue is documented at a specific ratio against `--tile-fg`; re-theming them
  would invalidate all seven measurements.
- **`--mono`, the type scale, `--gutter`, `--r-*`.** Not colours. A theme
  changes hue, never geometry or type.

### 3.3 Tokens a theme defines

Required: `--bg`, `--surface`, `--border`, `--fg`, `--fg-dim`, `--accent`,
`--accent-fg`, `--accent-wash`, `--danger-wash`.

Optional, and only as a legibility adjustment for that theme's ground:
`--danger`, `--warn`, `--ok`.

`--accent-fg` is required rather than optional because it is the trap this
codebase just walked into: a light accent needs a near-black label and a dark
accent needs white, and inheriting the wrong one puts white on a pale fill with
nothing to catch it.

---

## 4. The registry and the picker

Two sources of truth, bound by a test — the pattern `tests/ui-icons.test.tsx`
already uses to stop its glyph list going stale.

- **`prefs.ts` exports `THEMES`**: an ordered table of `{ id, label }`. The
  picker renders from it; `ThemePref` is its `id` union, widening from
  `"system" | "light" | "dark"`.
- **`styles.css` holds the values**, one block per id.
- **A test asserts the two agree**: every id has a block, every block has an id.
  A theme added to one and not the other fails loudly rather than rendering
  unstyled.

`themeAttr` is unchanged — `pref === "system" ? null : pref` — because the
named ids ARE the attribute values.

### 4.1 The control

`DeviceSection`'s Appearance card swaps `Segmented` for `<select>`, which
`.card-row select` already styles, and which iOS renders as a native wheel.

**No swatch previews.** `setPref` applies `themeAttr` synchronously, so changing
the selection repaints the entire app immediately. The operator sees the theme
itself, which is strictly better than a chip of it. This is also why the picker
needs no Save button — like every other "This device" setting, it is local and
instant.

---

## 5. The audit test

`tests/themes.test.ts` parses every `:root[data-theme=…]` block and, for each,
computes contrast ratios and asserts AA:

| Check | Threshold | Why |
|---|---|---|
| `--fg` on `--bg` | 4.5 | body text |
| `--fg-dim` on `--bg` | 4.5 | task lines, ages, hints — text, not decoration |
| `--fg` on `--surface` | 4.5 | cards and bands sit on surface |
| `--accent` on `--bg` | 4.5 | links and the active tab label |
| `--accent-fg` on `--accent` | 4.5 | the Send button's own word |
| `--danger` on `--bg` | 4.5 | **whether the theme overrode it or inherited it** |
| `--warn` on `--bg` | 4.5 | same |
| `--ok` on `--bg` | 4.5 | same |

The last three are the point. A theme that silently inherits paddock's red onto
a lighter ground is the defect this whole design exists to prevent, and it is
invisible to every other test in the suite because nothing else asserts a
computed colour — the same blind spot that let `shadcn init` turn `--accent`
near-white while 1159 tests passed.

Adding a theme therefore becomes mechanical: paste the palette, run the test,
tune whatever it flags.

**Not covered by this test, and deliberately:** that a theme's three state
colours are distinguishable *from each other* at 8px. Contrast against a ground
is arithmetic; "does amber read as different from red to a person" is not. Each
theme's trio is checked by eye once, at review, and the palettes below were.

---

## 6. The four themes, verified

Every value below has been measured. Ratios are against that theme's own `--bg`
unless stated.

### Dracula — all pass unchanged

```
--bg #282a36  --surface #343746  --border #44475a
--fg #f8f8f2 (13.36)  --fg-dim #a2add0 (6.39)
--accent #bd93f9 (5.90)  --accent-fg #20222c (6.56 on accent)
--danger #ff6e6e (5.23)  --warn #ffb86c (8.36)  --ok #69ff94 (11.08)
```

`--fg-dim` is lightened from Dracula's own comment colour, which fails at 4.38.
`--danger` is Dracula red lightened from `#ff5555`.

### Gruvbox Dark — one tuned value

```
--bg #282828  --surface #32302f  --border #504945
--fg #ebdbb2 (10.75)  --fg-dim #bdae93 (6.77)
--accent #fe8019 (5.84)  --accent-fg #241f1a (6.47 on accent)
--danger #fd7166 (5.43)  --warn #fabd2f (8.69)  --ok #b8bb26 (7.14)
```

**`--danger` is the tuned one.** Gruvbox's own bright red `#fb4934` measures
**4.29** on `#282828` — below AA, on the state that matters most. `#fd7166` is
the same hue lightened until it clears at 5.43, and stays visibly red against
Gruvbox's orange `#fe8019`.

### Gruvbox Light — all pass unchanged

```
--bg #fbf1c7  --surface #f2e5bc  --border #d5c4a1
--fg #3c3836 (10.22)  --fg-dim #665c54 (5.74)
--accent #af3a03 (5.40)  --accent-fg #ffffff (6.12 on accent)
--danger #9d0006 (7.60)  --warn #79600a (5.30)  --ok #4c6a04 (5.49)
```

Note `--warn` and `--ok` are Gruvbox's *dark* variants: its bright yellow and
green fail badly on a cream ground (4.33 and 4.48 for paddock's own).

### Nord — all pass unchanged

```
--bg #2e3440  --surface #3b4252  --border #4c566a
--fg #eceff4 (10.84)  --fg-dim #b8c2d4 (6.96)
--accent #88c0d0 (6.24)  --accent-fg #232830 (7.40 on accent)
--danger #ff7b72 (4.95)  --warn #ebcb8b (8.00)  --ok #a3be8c (6.13)
```

Nord's own `nord11` red `#bf616a` measures 3.73 and is replaced.

---

## 7. Scope

**In:** the four themes above, the guard change, the registry, the picker
control, the audit test, the registry-consistency test.

**Out, deliberately:**

- Catppuccin, Tokyo Night, Solarized and the rest. They pass or nearly pass, and
  adding one after this lands is a palette plus a green test run. Shipping four
  proves the mechanism; shipping eight proves nothing more.
- A server-side default theme.
- Custom user palettes.
- Theming the terminal pane, the tiles, or anything that is not a colour.

---

## 8. Risks

- **A named theme stops following the OS.** Accepted; see §2.
- **`prefers-color-scheme` interacts with the guard change.** The four cases in
  §3.1 are the whole matrix and each must be verified in a browser, not only in
  a test, because happy-dom has no layout and does not evaluate media queries
  the way a browser does.
- **`tests/tokens.test.ts` asserts every TOKENS entry is defined on bare
  `:root`.** That stays true — themes override, they do not replace the base
  definitions — but the theme blocks must not be mistaken for the base ones by
  its `:root {` string search, which locates the FIRST `:root {`. Verified when
  the first theme block lands.
