# Theme Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-device theme picker to Settings offering paddock's own palette plus Dracula, Gruvbox Dark, Gruvbox Light and Nord, with a test that proves every theme stays legible.

**Architecture:** Each theme is a `:root[data-theme="…"]` block in `styles.css`, the mechanism `[data-theme="dark"]` already uses. A `THEMES` table in `prefs.ts` drives the picker and widens `ThemePref`; a consistency test binds the table to the CSS blocks so neither can drift. A new audit test parses every block and asserts WCAG AA contrast — including for the state colours a theme *inherits* rather than overrides, which is the defect the whole design exists to prevent.

**Tech Stack:** TypeScript, React 18, Bun test, plain CSS custom properties. No new dependencies.

**Spec:** `docs/design/2026-08-26-theme-picker-design.md`

## Global Constraints

- **This repository is public.** No real hostnames, usernames, home paths, or employer terms in code, comments, tests or commit messages. `make check-clean` must pass before every commit.
- **Tokens live on bare `:root` and are redefined per theme.** Never define a colour only inside a media query or a `[data-theme]` block.
- **No device detection.** No `isMobile`, no user-agent parsing. Width media queries for layout, `(pointer: coarse)` for interaction.
- **Never swallow errors.** No `2>/dev/null`, no empty catch blocks, no unconditional `exit 0`.
- **`make test`, not bare `bun test`** — the suite reads real build output, so the UI is built first.
- **Run before every commit:** `make check` (tsc), `make check-clean` (public scanner), `make test`.
- **A theme must not touch** `--term-bg`, `--term-fg`, `--tile-*`, `--tile-fg`, `--mono`, `--t-*`, `--gutter`, or `--r-*`. Themes change hue, never geometry, type, or the terminal ground.
- **AA threshold is 4.5:1** for every contrast assertion in this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/web/prefs.ts` | `THEMES` table (id + label), `ThemePref` derived from it, `readPrefs` validation against it |
| `src/web/styles.css` | The media-query guard fix; one `:root[data-theme="…"]` block per named theme |
| `src/web/components/settings/DeviceSection.tsx` | Appearance card renders a `<select>` instead of `Segmented` |
| `tests/themes.test.ts` | **New.** Contrast audit for every theme block; registry/CSS consistency |
| `tests/prefs.test.ts` | Extended: an unknown stored theme falls back to the default |

Task order is dependency order: the guard fix is independent and lands first so no theme is ever added on top of a broken cascade.

---

## Task 1: Fix the dark media-query guard

**Files:**
- Modify: `src/web/styles.css` (the `@media (prefers-color-scheme: dark)` block)
- Test: `tests/themes.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the guarantee that `:root[data-theme="<anything>"]` fully owns its palette. Every later task depends on this.

**Why first:** today the guard reads `:root:not([data-theme="light"])`, which means "system dark applies unless light is pinned". With named themes that guard still matches — `dracula` is not `light` — so system-dark values apply underneath and a theme block only wins because it appears later in the file. Correctness by source order survives until someone reorders the file.

- [ ] **Step 1: Write the failing test**

Create `tests/themes.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Themes are `:root[data-theme="…"]` blocks, and each one must fully own its
 * palette. See docs/design/2026-08-26-theme-picker-design.md.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("system dark applies only when no theme is pinned", () => {
  // The old guard was `:root:not([data-theme="light"])`, which names one
  // special case instead of the actual rule. With named themes it still
  // matches — `dracula` is not `light` — so the system-dark palette would
  // apply underneath every theme, and each theme block would win only by
  // being later in the file. Correctness by source order is not correctness.
  expect(css).toContain(':root:not([data-theme])');
  expect(css).not.toContain(':root:not([data-theme="light"])');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/themes.test.ts`
Expected: FAIL — `Expected to contain: ":root:not([data-theme])"`

- [ ] **Step 3: Make the change**

In `src/web/styles.css`, find:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
```

Replace the selector line and update the comment above the block to read:

```css
/* System dark, unless the operator pinned ANY theme.
   `:not([data-theme])`, not `:not([data-theme="light"])`. The old guard named
   one special case; this states the rule. With named themes the old form still
   matched — `dracula` is not `light` — so these values applied underneath every
   theme and each theme block won only by appearing later in the file. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/themes.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the four cases in a real browser**

happy-dom does not evaluate `prefers-color-scheme` the way a browser does, so this must be checked by hand. Build and serve:

```bash
bun run build:web
bunx vite --port 5173 --host 127.0.0.1 &
```

In the browser at `http://127.0.0.1:5173`, run in the console for each case and confirm `--bg`:

```js
const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
delete document.documentElement.dataset.theme;            // System → follows OS
document.documentElement.dataset.theme = 'light';         // → #ffffff
document.documentElement.dataset.theme = 'dark';          // → #08090a
```

Expected: System follows the OS setting; `light` gives `#ffffff` on a dark OS too; `dark` gives `#08090a` on a light OS too.

- [ ] **Step 6: Run the full suite**

Run: `make check && make check-clean && make test`
Expected: tsc clean, scanner clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/styles.css tests/themes.test.ts
git commit -m "fix: the dark guard names the rule, not one special case

\`:root:not([data-theme=\"light\"])\` means \"system dark unless light is
pinned\". That was fine while light and dark were the only two themes.
With a named theme it still matches — dracula is not light — so the
system-dark palette applies underneath and the theme block wins only by
being later in the file.

\`:root:not([data-theme])\` states the actual rule: system dark applies
when nothing is pinned. Each theme then fully owns its palette.

Verified in a browser across all four cases, because happy-dom does not
evaluate prefers-color-scheme the way a browser does."
```

---

## Task 2: The THEMES registry

**Files:**
- Modify: `src/web/prefs.ts:8` (`ThemePref`), `src/web/prefs.ts:149` (`readPrefs`)
- Test: `tests/prefs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const THEMES: readonly { id: string; label: string }[]`
  - `export type ThemePref = (typeof THEMES)[number]["id"]`
  - `themeAttr(pref: ThemePref): string | null` — unchanged signature in spirit, now returns any theme id or `null` for `"system"`.

**Note on ordering:** `THEMES` is declared before `ThemePref` because the type is derived from it. `DEFAULTS.theme` stays `"system"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/prefs.test.ts`:

```ts
test("an unknown stored theme falls back to the default", () => {
  // A build that offered a theme since removed leaves its id in storage. That
  // value must not reach `data-theme`, where it would match no block and render
  // the app in whatever the bare :root palette happens to be — which looks like
  // a bug rather than a missing theme.
  localStorage.setItem("paddock.theme", "solarized-nope");
  expect(readPrefs().theme).toBe("system");
  localStorage.removeItem("paddock.theme");
});

test("every theme in the registry round-trips through storage", () => {
  for (const t of THEMES) {
    writePref("theme", t.id);
    expect(readPrefs().theme).toBe(t.id);
  }
  localStorage.removeItem("paddock.theme");
});
```

Add `THEMES` and `writePref` to that file's existing import from `@web/prefs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/prefs.test.ts`
Expected: FAIL — `THEMES` is not exported.

- [ ] **Step 3: Add the registry and widen the type**

In `src/web/prefs.ts`, replace line 8 (`export type ThemePref = "system" | "light" | "dark";`) with:

```ts
/**
 * Every theme the picker offers, in the order it offers them.
 *
 * The ORDER is the UI order: paddock's own three first, then the named
 * palettes. `system` is first because it is the default and the only entry
 * that follows the operating system — every named theme pins itself, which is
 * the accepted cost of a flat list (see the design doc, §2).
 *
 * This table and the `:root[data-theme=…]` blocks in styles.css are two
 * sources of truth, and `tests/themes.test.ts` asserts they agree: an id here
 * with no block would render unstyled, and a block with no id here would be
 * unreachable. That is the same "guards the guard" pattern
 * `tests/ui-icons.test.tsx` uses for its glyph list.
 *
 * `system`, `light` and `dark` deliberately have NO block of their own —
 * `light` is the bare `:root` palette, `dark` already has a block, and
 * `system` sets no attribute at all. The consistency test knows about those
 * three by name; everything else must have a block.
 */
export const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "gruvbox-dark", label: "Gruvbox Dark" },
  { id: "gruvbox-light", label: "Gruvbox Light" },
  { id: "nord", label: "Nord" },
] as const;

export type ThemePref = (typeof THEMES)[number]["id"];
```

- [ ] **Step 4: Validate on read against the registry**

In `readPrefs()`, replace:

```ts
    theme: theme === "light" || theme === "dark" ? theme : DEFAULTS.theme,
```

with:

```ts
    // Checked against the registry rather than a hardcoded pair. A value left
    // by a build that offered a theme since removed must fall back to the
    // default, not reach `data-theme` and match no block — an unstyled app
    // reads as broken, where "your theme went away" reads as a change.
    theme: THEMES.some((t) => t.id === theme) ? (theme as ThemePref) : DEFAULTS.theme,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/prefs.test.ts`
Expected: PASS

- [ ] **Step 6: Run tsc and the full suite**

Run: `make check && make test`
Expected: tsc clean. `themeAttr`'s return type widens automatically; no other call site changes.

- [ ] **Step 7: Commit**

```bash
git add src/web/prefs.ts tests/prefs.test.ts
git commit -m "feat: a theme registry, and validation that reads from it

\`ThemePref\` was a hardcoded union and \`readPrefs\` validated against a
hardcoded pair. Both now derive from one \`THEMES\` table, so adding a
theme is one entry rather than three edits that can disagree.

An unrecognised stored id falls back to \`system\`. A value left by a
build that offered a theme since removed must not reach \`data-theme\`,
where it matches no block and renders the bare palette — that looks like
a bug, where \"your theme went away\" looks like a change."
```

---

## Task 3: The audit test

**Files:**
- Modify: `tests/themes.test.ts`

**Interfaces:**
- Consumes: `THEMES` from `src/web/prefs.ts` (Task 2).
- Produces: `parseThemeBlocks(css: string): Map<string, Record<string, string>>` — internal to this test file; no other task imports it.

**Why before the themes themselves:** the test must exist and be green on zero themes, so that Task 4's first palette is verified the moment it lands rather than audited afterwards.

- [ ] **Step 1: Write the audit**

Replace the whole of `tests/themes.test.ts` with:

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { THEMES } from "@web/prefs";

/**
 * Every theme must stay legible, and the check that matters most is the one
 * for colours a theme does NOT override.
 *
 * paddock's dark state colours were tuned against `--bg: #08090a`, a
 * near-black. Every popular palette uses a lighter ground, so the same hexes
 * lose contrast on it — measured, Dracula puts `--danger` at 4.25 and Nord at
 * 3.73, both below AA, on the one state this application exists to signal.
 *
 * Nothing else in the suite would catch that: no other test asserts a computed
 * colour, which is the same blind spot that let `shadcn init` turn `--accent`
 * near-white while 1159 tests passed.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The three ids that legitimately have no block of their own: `light` IS the
 *  bare `:root` palette, `dark` has one already, and `system` sets no
 *  attribute at all. */
const NO_BLOCK = new Set(["system", "light"]);

function blockFor(selector: string): Record<string, string> | null {
  const at = css.indexOf(selector + " {");
  if (at === -1) return null;
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]!] = (m[2] ?? "").trim();
  }
  return out;
}

/** The bare `:root` palette, which every theme inherits from. */
function baseTokens(): Record<string, string> {
  const at = css.indexOf("\n:root {");
  const body = css.slice(at, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = (m[2] ?? "").trim();
  return out;
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  const hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

test("system dark applies only when no theme is pinned", () => {
  expect(css).toContain(":root:not([data-theme])");
  expect(css).not.toContain(':root:not([data-theme="light"])');
});

test("every registered theme has a block, and every block is registered", () => {
  // Two sources of truth, bound. An id with no block renders unstyled; a block
  // with no id is unreachable from the picker. Same pattern as
  // tests/ui-icons.test.tsx's glyph list.
  const registered = THEMES.map((t) => t.id).filter((id) => !NO_BLOCK.has(id));
  const inCss = [...css.matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{/g)].map((m) => m[1]!);
  expect([...new Set(inCss)].sort()).toEqual([...registered].sort());
});

/**
 * `--danger`, `--warn` and `--ok` are checked whether the theme overrode them
 * or inherited them from bare `:root`. Inheriting is exactly how a theme goes
 * below AA without anyone noticing.
 */
const REQUIRED = [
  "--bg", "--surface", "--border", "--fg", "--fg-dim",
  "--accent", "--accent-fg", "--accent-wash", "--danger-wash",
] as const;

for (const t of THEMES.filter((x) => !NO_BLOCK.has(x.id))) {
  test(`${t.id} defines every required token`, () => {
    const block = blockFor(`:root[data-theme="${t.id}"]`);
    expect(block, `no block for ${t.id}`).not.toBeNull();
    for (const token of REQUIRED) {
      expect(block![token], `${t.id} must define ${token}`).toBeDefined();
    }
  });

  test(`${t.id} clears AA on every text pairing`, () => {
    const base = baseTokens();
    const block = blockFor(`:root[data-theme="${t.id}"]`)!;
    // A theme's own value if it set one, otherwise what it inherits.
    const v = (token: string): string => block[token] ?? base[token]!;

    const checks: [string, string][] = [
      ["--fg", "--bg"],
      ["--fg-dim", "--bg"],
      ["--fg", "--surface"],
      ["--accent", "--bg"],
      ["--accent-fg", "--accent"],
      // The three that matter most: inherited or not, they must be legible on
      // THIS theme's ground.
      ["--danger", "--bg"],
      ["--warn", "--bg"],
      ["--ok", "--bg"],
    ];

    for (const [fg, bg] of checks) {
      const r = ratio(v(fg), v(bg));
      expect(r, `${t.id}: ${fg} on ${bg} is ${r.toFixed(2)}, below AA ${AA}`).toBeGreaterThanOrEqual(AA);
    }
  });

  test(`${t.id} does not re-theme the terminal, the tiles, or any non-colour`, () => {
    const block = blockFor(`:root[data-theme="${t.id}"]`)!;
    // The terminal ground is dark in every theme: herdr sends the agent's own
    // truecolor escapes, chosen for a dark terminal, so a light pane would
    // render an agent's white output onto a light ground. The tiles carry
    // their own grounds at documented ratios. The rest are not colours.
    const FORBIDDEN = [
      "--term-bg", "--term-fg", "--tile-fg", "--mono",
      "--gutter", "--edge", "--r-sm", "--r-md", "--r-full",
      "--t-xs", "--t-md", "--t-lg", "--t-xl",
    ];
    for (const token of FORBIDDEN) {
      expect(block[token], `${t.id} must not redefine ${token}`).toBeUndefined();
    }
    for (const key of Object.keys(block)) {
      expect(key.startsWith("--tile-"), `${t.id} must not redefine ${key}`).toBe(false);
    }
  });
}
```

- [ ] **Step 2: Run it to verify it passes on zero themes**

Run: `bun test tests/themes.test.ts`
Expected: PASS. `THEMES` currently lists four named themes with no blocks yet, so the consistency test **fails** — that is correct and Task 4 fixes it. If you want a green checkpoint first, temporarily trim `THEMES` to the three built-ins, confirm green, then restore.

- [ ] **Step 3: Commit**

```bash
git add tests/themes.test.ts
git commit -m "test: an audit every theme has to pass

Computes WCAG contrast for each theme block and asserts AA on eight
pairings. The three that matter are --danger, --warn and --ok, checked
whether the theme OVERRODE them or inherited them from bare :root:
paddock's dark state colours were tuned against #08090a, and every
popular palette uses a lighter ground, so inheriting is exactly how a
theme drops below AA unnoticed.

Also binds the registry to the stylesheet — an id with no block renders
unstyled, a block with no id is unreachable — and refuses a theme that
re-themes the terminal ground, the tiles, or anything that is not a
colour."
```

---

## Task 4: The four theme blocks

**Files:**
- Modify: `src/web/styles.css` (append after the `:root[data-theme="dark"]` block)

**Interfaces:**
- Consumes: the guard from Task 1, the registry ids from Task 2, the audit from Task 3.
- Produces: four `:root[data-theme="…"]` blocks. Nothing imports these.

**Every value below is measured.** Do not substitute "official" palette values from a theme's website — three of these differ from the canonical palette precisely because the canonical value fails AA on that theme's own ground.

- [ ] **Step 1: Run the audit to see it fail**

Run: `bun test tests/themes.test.ts`
Expected: FAIL — "every registered theme has a block" reports the four missing ids.

- [ ] **Step 2: Add the four blocks**

Append to `src/web/styles.css`, after the `:root[data-theme="dark"]` block:

```css
/* ── Named themes ─────────────────────────────────────────────────────────
   Chrome plus, where necessary, a tuned state colour. The MEANING is fixed in
   every theme — red is an agent that has stopped and needs a person — and only
   the hex may move, purely so it stays legible on that theme's own ground.

   Three of the values below deliberately differ from the canonical palette,
   because the canonical value fails AA here. Each is noted. Ratios are against
   that theme's own --bg unless stated, and every one is asserted by
   tests/themes.test.ts — do not hand-edit a value without re-running it.

   None of these blocks touches --term-bg/--term-fg (the agent's own escapes
   assume a dark terminal) or --tile-* (they carry their own grounds at
   documented ratios). */

:root[data-theme="dracula"] {
  --bg: #282a36;
  --surface: #343746;
  --border: #44475a;
  --fg: #f8f8f2;          /* 13.36 */
  /* Lightened from Dracula's own comment colour #6272a4, which is 4.38. */
  --fg-dim: #a2add0;      /* 6.39 */
  --accent: #bd93f9;      /* 5.90 */
  --accent-fg: #20222c;   /* 6.56 on accent */
  --accent-wash: #322a44;
  --danger-wash: #3a2430;
  /* Lightened from Dracula red #ff5555, which is 4.31. */
  --danger: #ff6e6e;      /* 5.23 */
  --warn: #ffb86c;        /* 8.36 */
  --ok: #69ff94;          /* 11.08 */
}

:root[data-theme="gruvbox-dark"] {
  --bg: #282828;
  --surface: #32302f;
  --border: #504945;
  --fg: #ebdbb2;          /* 10.75 */
  --fg-dim: #bdae93;      /* 6.77 */
  --accent: #fe8019;      /* 5.84 */
  --accent-fg: #241f1a;   /* 6.47 on accent */
  --accent-wash: #3a2e1f;
  --danger-wash: #3a2422;
  /* THE tuned value this design exists for: Gruvbox's own bright red #fb4934
     measures 4.29 here, below AA, on the state that matters most. Same hue,
     lightened until it clears, and still visibly red against #fe8019. */
  --danger: #fd7166;      /* 5.43 */
  --warn: #fabd2f;        /* 8.69 */
  --ok: #b8bb26;          /* 7.14 */
}

:root[data-theme="gruvbox-light"] {
  --bg: #fbf1c7;
  --surface: #f2e5bc;
  --border: #d5c4a1;
  --fg: #3c3836;          /* 10.22 */
  --fg-dim: #665c54;      /* 5.74 */
  --accent: #af3a03;      /* 5.40 */
  --accent-fg: #ffffff;   /* 6.12 on accent */
  --accent-wash: #f2e0b8;
  --danger-wash: #f5dfc8;
  /* Gruvbox's DARK variants, not its bright ones: on a cream ground the
     bright yellow and green measure 4.33 and 4.48. */
  --danger: #9d0006;      /* 7.60 */
  --warn: #79600a;        /* 5.30 */
  --ok: #4c6a04;          /* 5.49 */
}

:root[data-theme="nord"] {
  --bg: #2e3440;
  --surface: #3b4252;
  --border: #4c566a;
  --fg: #eceff4;          /* 10.84 */
  --fg-dim: #b8c2d4;      /* 6.96 */
  --accent: #88c0d0;      /* 6.24 */
  --accent-fg: #232830;   /* 7.40 on accent */
  --accent-wash: #333c4a;
  --danger-wash: #3b2f36;
  /* Nord's own nord11 #bf616a measures 3.73 and is replaced. */
  --danger: #ff7b72;      /* 4.95 */
  --warn: #ebcb8b;        /* 8.00 */
  --ok: #a3be8c;          /* 6.13 */
}
```

- [ ] **Step 3: Run the audit**

Run: `bun test tests/themes.test.ts`
Expected: PASS — consistency, required tokens, AA on all eight pairings per theme, and no forbidden token.

- [ ] **Step 4: Run the full suite**

Run: `make check && make check-clean && make test`
Expected: all green. `tests/tokens.test.ts` still passes — theme blocks override, they do not replace the bare `:root` definitions its `:root {` search finds.

- [ ] **Step 5: Commit**

```bash
git add src/web/styles.css
git commit -m "feat: Dracula, Gruvbox Dark, Gruvbox Light and Nord

Chrome plus, where necessary, one tuned state colour. The meaning is
fixed in every theme — red is an agent that has stopped and needs a
person — and only the hex moves, purely to stay legible on that theme's
ground.

Three values deliberately differ from the canonical palette because the
canonical value fails AA here. The clearest is Gruvbox's own bright red
#fb4934, which measures 4.29 on #282828: below AA, on the state that
matters most. #fd7166 is the same hue lightened until it clears at 5.43.

Every ratio in the file is asserted by tests/themes.test.ts."
```

---

## Task 5: The picker

**Files:**
- Modify: `src/web/components/settings/DeviceSection.tsx:9-13` (the local `THEMES` const) and its Appearance card
- Test: `tests/settings-view.test.tsx`

**Interfaces:**
- Consumes: `THEMES` and `ThemePref` from `@web/prefs` (Task 2).
- Produces: nothing other tasks depend on.

**Note:** `DeviceSection` currently declares its own local `THEMES` array. That array is deleted — the registry replaces it, which is the whole point of Task 2.

- [ ] **Step 1: Write the failing test**

Add to `tests/settings-view.test.tsx`:

```tsx
test("the theme picker offers every registered theme", async () => {
  const host = await render(<Settings />);
  await settle();
  const select = host.querySelector('select[data-field="theme"]') as HTMLSelectElement;
  expect(select, "Appearance renders a select, not a segmented control").not.toBeNull();
  expect([...select.options].map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
  expect([...select.options].map((o) => o.textContent)).toEqual(THEMES.map((t) => t.label));
});
```

Add `THEMES` to that file's import from `@web/prefs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/settings-view.test.tsx`
Expected: FAIL — the select does not exist; `Segmented` renders buttons.

- [ ] **Step 3: Replace the control**

In `src/web/components/settings/DeviceSection.tsx`, delete the local `THEMES` const (lines 9-13) and change the import on line 1 to:

```tsx
import { RATE_MS, THEMES, type Prefs, type RatePref, type ThemePref } from "@web/prefs";
```

Replace the Appearance card's `<Segmented>` with:

```tsx
        {/* A `<select>`, not `Segmented`. Segmented holds three options well
            and seven badly, and `.card-row select` is already styled — on iOS
            this renders as the native wheel.

            No swatch previews, deliberately: `setPref` applies `themeAttr`
            synchronously, so changing the selection repaints the whole app at
            once. The operator sees the theme itself, which is strictly better
            than a chip of it. */}
        <label className="card-row">
          <span>Theme</span>
          <select
            data-field="theme"
            value={prefs.theme}
            onChange={(e) => setPref("theme", e.target.value as ThemePref)}
          >
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
```

If `Segmented` is now unused in this file, remove its import; if it is still used by the Live-updates card, leave it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/settings-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Verify the live repaint in a browser**

```bash
bun run build:web
bunx vite --port 5173 --host 127.0.0.1 &
```

Open `http://127.0.0.1:5173/#/settings` at 390x844, pick each of the seven themes in turn, and confirm:
- the whole app repaints immediately, with no Save
- the tab bar's active label and the badge stay legible in every theme
- the terminal pane stays dark in Gruvbox Light (open an agent to check)

- [ ] **Step 6: Run the full suite**

Run: `make check && make check-clean && make test`

- [ ] **Step 7: Commit**

```bash
git add src/web/components/settings/DeviceSection.tsx tests/settings-view.test.tsx
git commit -m "feat: a theme picker in Settings

Appearance swaps Segmented for a select: three options fit a segmented
control, seven do not, and .card-row select is already styled — iOS
renders it as the native wheel.

The local THEMES array in this file is gone; the registry in prefs.ts is
the one source, which is what stops the picker and the stylesheet
drifting apart.

No swatch previews and no Save: setPref applies themeAttr synchronously,
so the whole app repaints on selection. The operator sees the theme
rather than a chip of it."
```

---

## Task 6: Document it

**Files:**
- Modify: `docs/decisions.md`, `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Add the decision**

Append to `docs/decisions.md`, following the numbering already in the file:

```markdown
## N. Themes change hue, never meaning

paddock offers Dracula, Gruvbox and Nord. Those are syntax-highlighting
palettes — their red means "string literal" — and paddock's is a semantic one,
where red is spent on exactly one thing: an agent that has stopped and needs a
person.

So a theme sets the chrome, and may set a state colour ONLY as a legibility
adjustment for its own ground. The meaning never moves. What forced the
distinction: paddock's dark state colours were tuned against `--bg: #08090a`, a
near-black, and every popular palette uses a lighter ground — measured, Dracula
puts `--danger` at 4.25 and Nord at 3.73, both below AA, before anything is
changed at all. "Keep the state colours" is not the safe option it sounds like.

`tests/themes.test.ts` asserts AA for `--danger`, `--warn` and `--ok` against
each theme's own `--bg`, whether the theme overrode them or inherited them.
Inheriting is exactly how a theme drops below AA unnoticed, and no other test in
the suite asserts a computed colour.

A theme must not touch `--term-bg`/`--term-fg` — herdr sends the agent's own
truecolor escapes, chosen for a dark terminal — or `--tile-*`, which carry their
own grounds at documented ratios.

See `docs/design/2026-08-26-theme-picker-design.md`.
```

- [ ] **Step 2: Add the rule to CLAUDE.md**

In the **UI rules** section of `CLAUDE.md`, after the existing "Never define a colour only inside a media query" bullet:

```markdown
- **A theme changes hue, never meaning.** Named themes live in
  `:root[data-theme="…"]` blocks and set chrome; a state colour may be tuned
  only so it stays legible on that theme's ground. `tests/themes.test.ts`
  asserts AA per theme — including for state colours a theme INHERITS, which is
  how one drops below AA unnoticed. Never re-theme `--term-bg`/`--term-fg` or
  the tile hues.
```

- [ ] **Step 3: Run the scanner and commit**

```bash
make check-clean
git add docs/decisions.md CLAUDE.md
git commit -m "docs: themes change hue, never meaning

Records the measurement that shaped the design — paddock's dark state
colours were tuned against a near-black, so every popular palette's
lighter ground drops --danger below AA before anything is changed — and
the rule that follows: a theme sets chrome, and may tune a state colour
only for legibility on its own ground."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 guard change | Task 1 |
| §3.2 what a theme must not touch | Task 3 (asserted), Task 4 (observed), Task 6 (documented) |
| §3.3 tokens a theme defines | Task 3 (`REQUIRED`), Task 4 |
| §4 registry and picker | Tasks 2 and 5 |
| §4.1 select, no swatches, no Save | Task 5 |
| §5 audit test | Task 3 |
| §6 the four themes | Task 4 |
| §8 risks — browser verification | Task 1 Step 5, Task 5 Step 5 |

No gaps.

**Placeholder scan:** none. Every code step carries the literal content.

**Type consistency:** `THEMES` entries use `id`/`label` throughout — Task 2 defines them, Tasks 3 and 5 consume them. The design doc's prose says "id + label"; the spec's §4 wording does not contradict this. `ThemePref` is derived, never re-declared. `themeAttr`'s body is unchanged in all tasks.

**One known-awkward step, called out rather than hidden:** Task 3 Step 2 leaves the consistency test red until Task 4 lands, because the registry (Task 2) lists four themes that have no blocks yet. The alternative — reordering so blocks precede the audit — would mean the first palette lands unverified, which is the thing this plan is arranged to prevent. The step says how to get a green checkpoint if one is wanted.
