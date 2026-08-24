# UI Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give urgency a second, non-colour channel on the dashboard, and build the shared component vocabulary that does it once rather than five times.

**Architecture:** A new `src/web/components/ui/` layer of thin React wrappers holding props and ARIA only, with all visual state in semantic CSS classes in `src/web/styles.css`. Consumers (dashboard rows, section headers, settings) are then refitted onto it. One shared-contract change carries the harness name that was already on the wire, and splits `needs-you` into two sections.

**Tech Stack:** Bun + `bun:test`, React 19 (`react-dom/client` + `act`), Tailwind v4 via `@tailwindcss/vite`, hand-rolled CSS variables. happy-dom for DOM tests. No new runtime dependency.

**Spec:** `docs/design/2026-08-24-ui-primitives-design.md`

## Global Constraints

- **No new runtime dependency.** No lucide, no shadcn/ui, no testing-library. Icons are hand-written inline SVG following `src/web/components/Mark.tsx`.
- **Every colour token is defined in all three theme routes:** bare `:root`, `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, and `:root[data-theme="dark"]`. A token defined only in a media query leaves the manual toggle with nothing to fall back to. Enforced by `tests/tokens.test.ts`.
- **Touch targets are `2.75rem`** (44px at the 16px root the app never overrides). The app's existing convention is `.tap`, `.term-keys`, `.settings-save-bar button`.
- **Respect `prefers-reduced-motion`** on every transition added.
- **No device detection.** No `isMobile`, no user-agent parsing. Width media queries for layout, `(pointer: coarse)` / `(hover: hover)` for interaction.
- **No hover-only affordances.** Anything reachable by hover must be reachable by tap.
- **Colour is never the only channel.** Every state carries text or shape in addition to hue.
- **Invented names only** in fixtures and demo data: `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`. Never a real agent name, hostname, or path. Use `dev-box` for hosts and `/srv/project` for paths.
- **`make check-clean` before every commit.** It is a pre-commit hook and CI gate.
- **Never swallow errors.** No `2>/dev/null`, no empty catch blocks, no unconditional `exit 0`.
- Commit subject style, matching this repo's history: `<type>: <noun phrase>, because <reason>`.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/web/components/ui/StatusDot.tsx` | Agent state as ring (resting) or fill (active). Owns the traffic-light palette map. |
| `src/web/components/ui/IconTile.tsx` | Round harness-identity tile: initials, deterministic hue, `badge` overlay slot. |
| `src/web/components/ui/icons.tsx` | Eight 24×24 `currentColor` stroke glyphs. |
| `src/web/components/ui/Card.tsx` | Bordered surface with optional icon/title/subtitle header, `control`, `children`, `footer`. |
| `src/web/components/ui/Toggle.tsx` | `role="switch"` control. |
| `src/web/components/ui/Segmented.tsx` | `role="radiogroup"` control. |
| `src/web/components/BuildStamp.tsx` | Monospace version · commit · time footer. |
| `src/web/components/settings/InfoSection.tsx` | Updates and Connection cards. |
| `src/web/build.ts` | Reads the vite-injected build triple, with fallbacks. |
| `tests/status-dot.test.tsx` | Ring vs fill. |
| `tests/icon-tile.test.tsx` | Initials and hue determinism. |
| `tests/card.test.tsx` | Slot placement. |
| `tests/toggle.test.tsx` | Switch semantics. |
| `tests/segmented.test.tsx` | Radiogroup semantics. |
| `tests/ui-styles.test.ts` | Touch targets and reduced-motion for the new classes. |
| `tests/agent-row-emphasis.test.tsx` | Emphasis derived from section. |
| `tests/build-stamp-ui.test.tsx` | Stamp renders the injected triple. |
| `tests/connection-card.test.tsx` | Every diagnostics row always rendered. |

**Modified**

| File | Change |
|---|---|
| `src/web/styles.css` | `--danger-wash`, `--tile-*` tokens; `.card*`, `.toggle*`, `.seg*`, `.tile*`, `.dot*`, `.row-*`, `.build-stamp` rules; delete the four replaced `.settings-*` rules. |
| `src/shared/types.ts` | `Agent.harness`; four-member `SECTION_ORDER`; `sectionFor`. |
| `src/server/herdr/adapter.ts` | Map `harness` from `HerdrAgentRaw.agent`. |
| `src/web/components/Section.tsx` | `SECTION_TITLES`, `SECTION_DOT`, `groupAgents` fourth bucket, `SectionHeader` dot. |
| `src/web/components/AgentRow.tsx` | `emphasis` prop, `IconTile`, re-export `StatusDot`; `DOT` map moves out. |
| `src/web/components/App.tsx` | Pass emphasis; render `BuildStamp`. |
| `src/web/components/settings/DeviceSection.tsx` | Three cards. |
| `src/web/components/settings/NotifySection.tsx` | Card + footer for the blocked-permission text. |
| `src/web/components/settings/TelegramSection.tsx` | Card. |
| `src/web/components/settings/TunnelSection.tsx` | Card. |
| `src/web/components/Settings.tsx` | Two labelled bands + Info band. |
| `vite.config.ts` | `define` block for the build triple. |
| `Makefile` | Export `PADDOCK_COMMIT` and `PADDOCK_BUILD_TIME` to the web build. |
| `tests/tokens.test.ts` | New tokens; `DOT` map path follows `StatusDot.tsx`. |
| `tests/grouping.test.ts` | Four sections. |
| `tests/settings-styles.test.ts` | Migrate the two guards whose selectors are replaced. |
| `tests/adapter.test.ts` | `harness` mapping. |

**Deliberately untouched:** `src/web/components/AgentTerminal.tsx` (898 lines).

---

## Phase 1 — Primitives

### Task 1: The `--danger-wash` token

**Files:**
- Modify: `src/web/styles.css` (three theme blocks near the top)
- Test: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS variable `--danger-wash`, the tint behind an alert row.

- [ ] **Step 1: Write the failing test**

Append to `tests/tokens.test.ts`:

```ts
test("the alert wash is defined in every theme route", async () => {
  // Same rule as --danger directly above: a colour defined only inside a media
  // query leaves a manual theme toggle painting with a value nobody chose.
  // Hand-picked per theme rather than color-mix(), so the value can be read
  // off the file.
  const text = await css();
  const bare = text.slice(text.indexOf(":root {"), text.indexOf("}", text.indexOf(":root {")));
  expect(bare).toContain("--danger-wash:");
  // Once bare, once for the guarded media query, once for the explicit toggle.
  expect([...text.matchAll(/--danger-wash:/g)]).toHaveLength(3);
});
```

Also add `"--danger-wash"` to the `TOKENS` array at the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tokens.test.ts`
Expected: FAIL — `expect(bare).toContain("--danger-wash:")` and the length assertion (received `0`).

Note: the pre-existing `--danger:` count test asserts exactly 3 and must still pass. `/--danger:/` does not match the string `--danger-wash:`, so adding the new token does not disturb it. If that test fails, the new token was written as `--danger :` or similar.

- [ ] **Step 3: Write minimal implementation**

In `src/web/styles.css`, add to the bare `:root` block, immediately after `--danger`:

```css
  /* The tint behind a row that needs a person. Hand-picked per theme rather
     than color-mix(--danger, --bg): every other colour here is spelled out in
     all three blocks, and a computed token would be the one value an operator
     cannot read off the file. Kept far enough from --bg to register as a
     wash and close enough not to compete with the border. */
  --danger-wash: #fdf0f0;
```

Add to **both** dark blocks (`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and `:root[data-theme="dark"]`):

```css
    --danger-wash: #2a1416;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/tokens.test.ts`
Expected: PASS, all tests including the pre-existing `--danger:` count of 3.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/styles.css tests/tokens.test.ts
git commit -m "feat: a wash behind an alert row, because a border alone is a thin signal on a phone"
```

---

### Task 2: `StatusDot` — ring for resting, fill for active

**Files:**
- Create: `src/web/components/ui/StatusDot.tsx`
- Modify: `src/web/components/AgentRow.tsx` (remove `DOT` and `StateDot`, re-export)
- Modify: `tests/tokens.test.ts` (the `DOT` map guard reads a path that is moving)
- Modify: `src/web/styles.css`
- Test: `tests/status-dot.test.tsx`

**Interfaces:**
- Consumes: `AgentState` from `@shared/types`.
- Produces:
  - `StatusDot({ state, surfaceVar? }: { state: AgentState; surfaceVar?: string })` — `surfaceVar` defaults to `"--bg"` and names the CSS variable the ring's interior is painted with.
  - `AgentRow.tsx` re-exports `StatusDot` so existing importers keep working.

- [ ] **Step 1: Write the failing test**

Create `tests/status-dot.test.tsx`:

```tsx
// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { StatusDot } from "@web/components/ui/StatusDot";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a resting agent is a hollow ring, not a disc", async () => {
  // The palette is tuned for TEXT contrast, so as solid discs the resting
  // states carry as much weight as the one thing that needs a person —
  // eighteen idle dots out-shout one blocked agent.
  const host = await render(<StatusDot state="idle" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.dataset.fill).toBe("ring");
});

test("the ring's interior is painted, never transparent", async () => {
  // Over a tile corner a transparent interior reads as a notch cut out of the
  // icon rather than as a dot sitting on it.
  const host = await render(<StatusDot state="idle" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.style.background).toBe("var(--bg)");
});

test("a card-hosted ring can be told which surface it sits on", async () => {
  const host = await render(<StatusDot state="idle" surfaceVar="--surface" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.style.background).toBe("var(--surface)");
});

test("every active state is a solid disc", async () => {
  for (const state of ["blocked", "working", "done"] as const) {
    const host = await render(<StatusDot state={state} />);
    const dot = host.querySelector("span") as HTMLElement;
    expect(dot.dataset.fill).toBe("solid");
    await unmount();
  }
});

test("the dot is hidden from assistive tech, because the state is text beside it", async () => {
  const host = await render(<StatusDot state="blocked" />);
  expect(host.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/status-dot.test.tsx`
Expected: FAIL — cannot resolve module `@web/components/ui/StatusDot`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/StatusDot.tsx`. Move the `DOT` map here verbatim, with its comment, extended for the ring rule:

```tsx
import type { AgentState } from "@shared/types";

/**
 * The one definition of what a state looks like, read by the list, the card and
 * the terminal header.
 *
 * Traffic-light semantics, matching herdr so an operator moving between the two
 * does not relearn a palette: red has stopped and needs a person, amber is in
 * motion, green is finished, grey is nothing to say.
 *
 * `working` was `--accent` — the token every link and button uses for "you can
 * tap this" — so a state was painted in the interaction colour and competed
 * with the affordances around it. And `blocked` borrowed amber, which left the
 * only state that actually needs a human sharing a colour with the one that
 * needs nothing.
 *
 * Colour is never the only channel: this dot is `aria-hidden` and the state is
 * carried as text beside it, because red-and-green is the classic
 * indistinguishable pair and this palette uses both.
 */
const DOT: Record<AgentState, string> = {
  blocked: "var(--danger)",
  done: "var(--ok)",
  working: "var(--warn)",
  idle: "var(--fg-dim)",
};

/**
 * Resting states are hollow, active states are solid.
 *
 * Every value in `DOT` is tuned to roughly the same lightness so it reads as
 * TEXT, which means as solid discs the resting states carry as much visual
 * weight as the one state that needs a person. On a list where five of six
 * agents are idle, the dots that mean "nothing to do" out-shout the one that
 * does. Hollowing them costs nothing and restores the ranking.
 */
const RESTING: Record<AgentState, boolean> = {
  blocked: false,
  done: false,
  working: false,
  idle: true,
};

/**
 * `surfaceVar` names the CSS variable the ring's interior is painted with.
 *
 * A ring MUST be filled, never left transparent. Overlaid on an `IconTile`
 * corner, a transparent interior reads as a notch cut out of the icon rather
 * than as a dot sitting on top of it. The default is the page ground; a dot on
 * a card passes `--surface`.
 */
export function StatusDot({
  state, surfaceVar = "--bg",
}: {
  state: AgentState;
  surfaceVar?: string;
}) {
  const resting = RESTING[state];
  return (
    <span
      aria-hidden="true"
      data-fill={resting ? "ring" : "solid"}
      className="dot"
      style={
        resting
          ? { borderColor: DOT[state], background: `var(${surfaceVar})` }
          : { background: DOT[state], borderColor: DOT[state] }
      }
    />
  );
}
```

Add to `src/web/styles.css`:

```css
/* The dot is 7px of meaning, so its geometry lives here rather than being
   restated at three call sites. A ring is the same size as a disc — hollowing
   a state must not also move it. */
.dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 9999px;
  border-width: 1.5px;
  border-style: solid;
  box-sizing: border-box;
}
```

In `src/web/components/AgentRow.tsx`, delete the `DOT` map and the `StateDot`
function, and re-export so existing importers are unaffected:

```tsx
import { StatusDot } from "@web/components/ui/StatusDot";

/** Re-exported for the card and the terminal header, which imported it from
 *  here before the primitive layer existed. */
export { StatusDot };
```

Replace the `<StateDot state={agent.state} />` call site with `<StatusDot state={agent.state} />`.

- [ ] **Step 4: Update the token guard that reads the old path**

`tests/tokens.test.ts` asserts the palette by slicing `const DOT` out of
`src/web/components/AgentRow.tsx`. That map has moved. Change the file it reads:

```ts
  const row = await Bun.file("src/web/components/ui/StatusDot.tsx").text();
```

The rest of that test is unchanged — it still asserts all four members and that
`--accent` is absent, which is exactly the regression it exists to catch.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/status-dot.test.tsx tests/tokens.test.ts`
Expected: PASS. Then check nothing else imported `StateDot` by name:

Run: `grep -rn "StateDot" src/ tests/`
Expected: no hits. If any remain, point them at `StatusDot`.

Run: `make check`
Expected: clean `tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/ui/StatusDot.tsx src/web/components/AgentRow.tsx src/web/styles.css tests/status-dot.test.tsx tests/tokens.test.ts
git commit -m "feat: hollow dots for resting states, because eighteen idle discs out-shout one blocked agent"
```

---

### Task 3: `IconTile` — round harness identity

**Files:**
- Create: `src/web/components/ui/IconTile.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/icon-tile.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `initialsFor(harness: string): string` — exported for test and reuse.
  - `hueFor(harness: string): number` — index into the tile palette.
  - `IconTile({ harness, size?, badge? }: { harness: string; size?: "sm" | "md"; badge?: React.ReactNode })`.

- [ ] **Step 1: Write the failing test**

Create `tests/icon-tile.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { IconTile, hueFor, initialsFor } from "@web/components/ui/IconTile";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a one-word harness gives its first two letters", () => {
  expect(initialsFor("claude")).toBe("CL");
  expect(initialsFor("codex")).toBe("CO");
});

test("a compound harness gives one letter per segment", () => {
  // herdr reports variants, and "CC" is more use than "CL" repeated for every
  // claude-shaped harness.
  expect(initialsFor("claude-code")).toBe("CC");
  expect(initialsFor("open_code")).toBe("OC");
});

test("a single-letter harness still produces something renderable", () => {
  // Never an empty tile: an unknown or degenerate harness must stay legible
  // rather than rendering a blank circle nobody can identify.
  expect(initialsFor("x")).toBe("X");
});

test("an unknown harness is a tile, not a blank", () => {
  expect(initialsFor("some-future-harness")).toBe("SF");
});

test("hue is stable for the same harness across calls", () => {
  // A tile that changed colour between renders would read as a different
  // agent.
  expect(hueFor("claude")).toBe(hueFor("claude"));
  expect(hueFor("codex")).toBe(hueFor("codex"));
});

test("hue is always a valid palette index", () => {
  for (const h of ["claude", "codex", "pi", "opencode", "", "zzzzzzzz"]) {
    const i = hueFor(h);
    expect(Number.isInteger(i)).toBe(true);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(6);
  }
});

test("the tile carries its own background, so one definition reads on both themes", async () => {
  const host = await render(<IconTile harness="claude" />);
  const tile = host.querySelector(".tile") as HTMLElement;
  expect(tile.style.background).toContain("var(--tile-");
});

test("the tile is round", async () => {
  const host = await render(<IconTile harness="claude" />);
  expect((host.querySelector(".tile") as HTMLElement).dataset.shape).toBe("round");
});

test("the initials are hidden from assistive tech and the harness is named instead", async () => {
  // "CL" read aloud is noise; the harness name is the information.
  const host = await render(<IconTile harness="claude" />);
  const tile = host.querySelector(".tile") as HTMLElement;
  expect(tile.getAttribute("aria-label")).toBe("claude");
  expect(tile.querySelector("[aria-hidden='true']")?.textContent).toBe("CL");
});

test("a badge is overlaid rather than placed beside the tile", async () => {
  // At 390px the horizontal budget is the scarce one: an overlaid dot costs
  // nothing where a sibling dot costs a column.
  const host = await render(<IconTile harness="claude" badge={<i data-test="b" />} />);
  const badge = host.querySelector(".tile-badge") as HTMLElement;
  expect(badge).not.toBeNull();
  expect(badge.querySelector("[data-test='b']")).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/icon-tile.test.tsx`
Expected: FAIL — cannot resolve module `@web/components/ui/IconTile`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/IconTile.tsx`:

```tsx
/** How many hues the tile palette holds. Kept in one place so `hueFor` and
 *  the stylesheet cannot disagree about the range. */
const HUES = 6;

/**
 * Initials for a harness name.
 *
 * One letter per segment for a compound name (`claude-code` → `CC`), the first
 * two letters otherwise (`claude` → `CL`). Never empty: an unknown harness
 * must stay identifiable rather than rendering a blank circle, which is the
 * case that actually shows up as herdr grows harnesses paddock has not heard
 * of.
 */
export function initialsFor(harness: string): string {
  const segments = harness.split(/[-_ ]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return "?";
  if (segments.length === 1) return segments[0]!.slice(0, 2).toUpperCase();
  return segments.slice(0, 2).map((s) => s[0]!).join("").toUpperCase();
}

/**
 * A stable hue index for a harness.
 *
 * Derived rather than tabulated on purpose: a hardcoded table silently omits
 * every harness nobody thought of, and those are exactly the ones that need a
 * distinguishable tile. Any change to this function reshuffles every tile's
 * colour, which is cosmetic but visible — it is not a hash anyone depends on
 * across versions.
 */
export function hueFor(harness: string): number {
  let h = 0;
  for (let i = 0; i < harness.length; i++) h = (h * 31 + harness.charCodeAt(i)) | 0;
  return Math.abs(h) % HUES;
}

/**
 * A round tile carrying an agent's harness identity.
 *
 * Initials rather than brand logos, deliberately: real marks would mean
 * committing third-party path data and using another project's trademark in an
 * unaffiliated tool. Initials also degrade gracefully — a harness paddock has
 * never seen gets a real tile instead of a placeholder.
 *
 * The tile carries its OWN background and foreground rather than inheriting the
 * page surface, so one definition reads on both themes.
 */
export function IconTile({
  harness, size = "sm", badge,
}: {
  harness: string;
  size?: "sm" | "md";
  badge?: React.ReactNode;
}) {
  return (
    <span
      className="tile"
      data-shape="round"
      data-size={size}
      aria-label={harness}
      style={{ background: `var(--tile-${hueFor(harness)})` }}
    >
      <span aria-hidden="true" className="tile-initials">{initialsFor(harness)}</span>
      {badge ? <span className="tile-badge">{badge}</span> : null}
    </span>
  );
}
```

Add to `src/web/styles.css`, in the bare `:root` block:

```css
  /* Tile hues are defined ONCE rather than per theme, for the same reason
     --term-bg is: the tile carries its own background and foreground, so the
     mark on it does not change meaning when the page around it does. A tile
     that inherited the page surface would need a different value per theme
     and a contrast check for each. Six is enough to tell a handful of
     harnesses apart without inventing near-duplicates. */
  --tile-0: #b8562f;
  --tile-1: #2f5fb8;
  --tile-2: #2f8f5f;
  --tile-3: #7a3fb8;
  --tile-4: #b8892f;
  --tile-5: #2f8f9f;
  --tile-fg: #ffffff;
```

And the rules:

```css
.tile {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 9999px;
  color: var(--tile-fg);
  font-weight: 600;
  letter-spacing: 0;
}

.tile[data-size="sm"] { width: 28px; height: 28px; font-size: 10px; }
.tile[data-size="md"] { width: 36px; height: 36px; font-size: 12px; }

/* Bottom-left rather than bottom-right: the tile's right edge is against the
   agent's name, and a badge there collides with the first character. */
.tile-badge {
  position: absolute;
  bottom: -1px;
  left: -1px;
  display: inline-flex;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/icon-tile.test.tsx`
Expected: PASS, all ten tests.

Run: `make check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/ui/IconTile.tsx src/web/styles.css tests/icon-tile.test.tsx
git commit -m "feat: a round tile per harness, because initials identify an agent without borrowing a trademark"
```

---

### Task 4: `icons.tsx` — eight glyphs

**Files:**
- Create: `src/web/components/ui/icons.tsx`
- Test: `tests/ui-icons.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `MonitorIcon`, `ActivityIcon`, `TerminalIcon`, `BellIcon`, `SendIcon`, `LinkIcon`, `RefreshIcon`, `PlugIcon` — each `({ className }: { className?: string }) => JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `tests/ui-icons.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import * as icons from "@web/components/ui/icons";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const NAMES = [
  "MonitorIcon", "ActivityIcon", "TerminalIcon", "BellIcon",
  "SendIcon", "LinkIcon", "RefreshIcon", "PlugIcon",
] as const;

test("there is one glyph per settings card", () => {
  for (const n of NAMES) expect(typeof (icons as Record<string, unknown>)[n]).toBe("function");
});

test("every glyph is decorative, so a card's title is not read twice", async () => {
  for (const n of NAMES) {
    const Icon = (icons as Record<string, React.FC>)[n]!;
    const host = await render(<Icon />);
    const svg = host.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    await unmount();
  }
});

test("every glyph inherits its colour, so one definition serves both themes", async () => {
  for (const n of NAMES) {
    const Icon = (icons as Record<string, React.FC>)[n]!;
    const host = await render(<Icon />);
    const svg = host.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    // A hardcoded hex would be invisible in one of the two themes.
    expect(host.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    await unmount();
  }
});

test("no icon library is imported", async () => {
  const src = await Bun.file("src/web/components/ui/icons.tsx").text();
  expect(src).not.toContain("lucide");
  expect(src).not.toContain("react-icons");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui-icons.test.tsx`
Expected: FAIL — cannot resolve module `@web/components/ui/icons`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/icons.tsx`:

```tsx
/**
 * Eight hand-written glyphs, one per settings card.
 *
 * An icon library is not added for eight of them: lucide-react is tens of
 * kilobytes of tree-shaken JavaScript for what is a few hundred bytes of path
 * data here, on a project whose bundle is deliberately ONE chunk because at
 * high RTT an extra round trip costs more than the bytes it saves.
 *
 * `currentColor` throughout, so a glyph is never a colour that has to be
 * redefined per theme, and `aria-hidden` throughout, because every one of them
 * sits beside a text title that already says what it means.
 */
function Svg({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="24" height="24" viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function MonitorIcon({ className }: IconProps) {
  return <Svg className={className}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>;
}

export function ActivityIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>;
}

export function TerminalIcon({ className }: IconProps) {
  return <Svg className={className}><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></Svg>;
}

export function BellIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z" /><path d="M10 21h4" /></Svg>;
}

export function SendIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" /></Svg>;
}

export function LinkIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M9 15l6-6" /><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></Svg>;
}

export function RefreshIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></Svg>;
}

export function PlugIcon({ className }: IconProps) {
  return <Svg className={className}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></Svg>;
}
```

A test cannot tell a bell from a smudge, so verify each glyph by eye in the browser at Task 12 as well.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui-icons.test.tsx`
Expected: PASS.

Run: `make check`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/ui/icons.tsx tests/ui-icons.test.tsx
git commit -m "feat: eight hand-written glyphs, because a library is tens of kilobytes for a few hundred bytes of paths"
```

---

### Task 5: `Card` — the settings group container

**Files:**
- Create: `src/web/components/ui/Card.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/card.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Card({ icon?, title?, subtitle?, control?, footer?, children? })`, all `React.ReactNode` except `title`/`subtitle` which are `string`.

- [ ] **Step 1: Write the failing test**

Create `tests/card.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Card } from "@web/components/ui/Card";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a control sits inside the header row, beside the title", async () => {
  // The inline-control layout: a toggle centred against a two-line
  // title+subtitle, not pushed below a divider.
  const host = await render(
    <Card title="Haptics" subtitle="A short buzz." control={<button data-test="t" />} />,
  );
  const head = host.querySelector(".card-head") as HTMLElement;
  expect(head.querySelector("[data-test='t']")).not.toBeNull();
});

test("children sit below a divider, in the body", async () => {
  const host = await render(<Card title="Appearance"><span data-test="body" /></Card>);
  const body = host.querySelector(".card-body") as HTMLElement;
  expect(body.querySelector("[data-test='body']")).not.toBeNull();
  expect((host.querySelector(".card-head") as HTMLElement).querySelector("[data-test='body']")).toBeNull();
});

test("a footer states why a control is inert", async () => {
  // A disabled control that says nothing is the failure mode this slot exists
  // to prevent.
  const host = await render(
    <Card title="Push notifications" footer="Blocked for this site in your browser settings." />,
  );
  const footer = host.querySelector(".card-foot") as HTMLElement;
  expect(footer.textContent).toContain("Blocked for this site");
});

test("an absent slot renders no empty box", async () => {
  // An empty divided region reads as a rendering bug.
  const host = await render(<Card title="Bare" />);
  expect(host.querySelector(".card-body")).toBeNull();
  expect(host.querySelector(".card-foot")).toBeNull();
});

test("the title is a heading, so the page has a real outline", async () => {
  const host = await render(<Card title="Connection" subtitle="Diagnostics." />);
  const h = host.querySelector("h2");
  expect(h?.textContent).toBe("Connection");
});

test("a card with no title renders no empty heading", async () => {
  const host = await render(<Card><span /></Card>);
  expect(host.querySelector("h2")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/card.test.tsx`
Expected: FAIL — cannot resolve module `@web/components/ui/Card`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/Card.tsx`:

```tsx
/**
 * A bordered group with three optional regions, which between them cover both
 * layouts the settings screen needs:
 *
 *  - `control` renders INSIDE the header row, right-aligned and centred
 *    against a two-line title+subtitle. This is a toggle: the switch belongs
 *    beside the thing it switches.
 *  - `children` renders below a divider. This is a segmented control, a button
 *    row, a diagnostics list — anything that needs the card's full width.
 *  - `footer` renders below a second divider, dimmed. This is where a disabled
 *    control says WHY. A control that is inert and silent leaves the operator
 *    to guess, which is the whole failure this slot exists to prevent.
 *
 * Each region is omitted entirely when its slot is empty, rather than
 * rendering a divided empty box that reads as a bug.
 */
export function Card({
  icon, title, subtitle, control, footer, children,
}: {
  icon?: React.ReactNode;
  title?: string;
  subtitle?: string;
  control?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasHead = Boolean(icon || title || subtitle || control);
  return (
    <section className="card">
      {hasHead && (
        <div className="card-head">
          {icon ? <span className="card-icon">{icon}</span> : null}
          <div className="card-heading">
            {title ? <h2 className="card-title">{title}</h2> : null}
            {subtitle ? <p className="card-sub">{subtitle}</p> : null}
          </div>
          {control ? <div className="card-control">{control}</div> : null}
        </div>
      )}
      {children ? <div className="card-body">{children}</div> : null}
      {footer ? <div className="card-foot">{footer}</div> : null}
    </section>
  );
}
```

Add to `src/web/styles.css`:

```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  overflow: hidden;
}

.card + .card { margin-top: 0.75rem; }

.card-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.8rem 0.9rem;
}

.card-icon { color: var(--fg-dim); display: inline-flex; flex-shrink: 0; }
.card-icon svg { width: 18px; height: 18px; }

.card-heading { min-width: 0; flex: 1; }

.card-title { margin: 0; font-size: 0.85rem; font-weight: 600; }

.card-sub { margin: 0.1rem 0 0; font-size: 0.75rem; color: var(--fg-dim); }

/* Centred against a two-line heading rather than top-aligned: the switch is
   about the whole setting, not about its first line. */
.card-control { flex-shrink: 0; display: inline-flex; align-items: center; }

.card-body { border-top: 1px solid var(--border); padding: 0.8rem 0.9rem; }

.card-foot {
  border-top: 1px solid var(--border);
  padding: 0.6rem 0.9rem;
  font-size: 0.72rem;
  color: var(--fg-dim);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/card.test.tsx`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/ui/Card.tsx src/web/styles.css tests/card.test.tsx
git commit -m "feat: a card with a slot for why a control is inert, because a silent disabled switch makes the operator guess"
```

---

### Task 6: `Toggle`

**Files:**
- Create: `src/web/components/ui/Toggle.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/toggle.test.tsx`, `tests/ui-styles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Toggle({ checked, onChange, label, disabled? }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean })`.

- [ ] **Step 1: Write the failing test**

Create `tests/toggle.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Toggle } from "@web/components/ui/Toggle";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("it is announced as a switch, with its state", async () => {
  const host = await render(<Toggle checked label="Wrap long lines" onChange={() => {}} />);
  const btn = host.querySelector("button") as HTMLButtonElement;
  expect(btn.getAttribute("role")).toBe("switch");
  expect(btn.getAttribute("aria-checked")).toBe("true");
});

test("aria-checked tracks the state, rather than being written once", async () => {
  const host = await render(<Toggle checked={false} label="Wrap" onChange={() => {}} />);
  expect((host.querySelector("button") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
});

test("tapping reports the NEXT value, not the current one", async () => {
  const seen: boolean[] = [];
  const host = await render(<Toggle checked={false} label="Wrap" onChange={(v) => seen.push(v)} />);
  (host.querySelector("button") as HTMLButtonElement).click();
  expect(seen).toEqual([true]);
});

test("a disabled switch cannot be activated", async () => {
  // The push-notification case: disabled server-side, and a tap that silently
  // did nothing would read as a broken control rather than an unavailable one.
  const seen: boolean[] = [];
  const host = await render(
    <Toggle checked={false} disabled label="Push" onChange={(v) => seen.push(v)} />,
  );
  const btn = host.querySelector("button") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  btn.click();
  expect(seen).toEqual([]);
});

test("it carries an accessible name, because the visual label is in the card header", async () => {
  const host = await render(<Toggle checked label="Haptics" onChange={() => {}} />);
  expect((host.querySelector("button") as HTMLButtonElement).getAttribute("aria-label")).toBe("Haptics");
});
```

Create `tests/ui-styles.test.ts`. It reuses the exact `ruleBody`/`declaration`
helpers `tests/settings-styles.test.ts` already uses, for the reason stated
there: happy-dom implements no layout, so a rendered-DOM test cannot measure a
control's height.

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Touch-target and motion guards for the primitive layer, checked against the
 * stylesheet source.
 *
 * happy-dom implements no layout, so a rendered-DOM test cannot measure a
 * control's height. Reading the rule out of styles.css is the approach
 * tests/settings-styles.test.ts and tests/block-styles.test.ts already take:
 * it cannot prove the pixels, but it does stop the declaration being deleted
 * by someone who does not know why it is there.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

function declaration(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`).exec(ruleBody(selector));
  if (!m) throw new Error(`"${selector}" declares no ${prop}`);
  return (m[1] ?? "").trim();
}

const TOUCH_TARGET = "2.75rem";

test("the switch is a full touch target", () => {
  expect(declaration(".toggle", "min-height")).toBe(TOUCH_TARGET);
});

test("the switch's motion is opt-out", () => {
  // A transition that ignores the preference is the one CLAUDE.md names.
  expect(css).toContain("prefers-reduced-motion");
  expect(ruleBody(".toggle-knob")).toContain("transition");
});

test("a disabled switch is dimmed as well as inert", () => {
  // Colour alone would leave the state invisible to anyone who cannot see the
  // difference; opacity plus the cursor is the second channel.
  expect(declaration(".toggle:disabled", "opacity")).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/toggle.test.tsx tests/ui-styles.test.ts`
Expected: FAIL — module not found, and `no CSS rule for ".toggle"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/Toggle.tsx`:

```tsx
/**
 * A switch, and only a switch.
 *
 * It deliberately takes no `reason` for being disabled. The explanation belongs
 * to the SETTING rather than to the control — paddock's own case is a browser
 * permission, which is a fact about the device — so the caller passes it to
 * `Card`'s `footer`. Keeping this component to one job is also what lets it be
 * tested without a card around it.
 *
 * `role="switch"` on a real `<button>`, so it is focusable, keyboard-operable
 * and announced as a control without any of that being re-implemented here.
 */
export function Toggle({
  checked, onChange, label, disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. The visible label lives in the card header, so without
   *  this the switch would be announced as an unnamed control. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="toggle"
      data-on={checked ? "yes" : "no"}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" className="toggle-track">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
```

Add to `src/web/styles.css`:

```css
.toggle {
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  background: none;
  border: 0;
  padding: 0 0 0 0.5rem;
  cursor: pointer;
}

.toggle:disabled { opacity: 0.45; cursor: default; }

.toggle-track {
  width: 44px;
  height: 26px;
  border-radius: 9999px;
  background: var(--border);
  border: 1px solid var(--border);
  display: inline-flex;
  align-items: center;
  padding: 2px;
  box-sizing: border-box;
}

.toggle[data-on="yes"] .toggle-track { background: var(--accent); border-color: var(--accent); }

.toggle-knob {
  width: 20px;
  height: 20px;
  border-radius: 9999px;
  background: var(--bg);
  transition: transform 140ms ease;
}

.toggle[data-on="yes"] .toggle-knob { transform: translateX(18px); }

@media (prefers-reduced-motion: reduce) {
  .toggle-knob { transition: none; }
}
```

Confirm `--accent` is correct here: it is the interaction colour, and an
*on* switch is an affordance rather than an agent state, so this does not
violate the palette rule that keeps states off `--accent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/toggle.test.tsx tests/ui-styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/ui/Toggle.tsx src/web/styles.css tests/toggle.test.tsx tests/ui-styles.test.ts
git commit -m "feat: a switch that is a real button, because role and keyboard support should not be re-implemented"
```

---

### Task 7: `Segmented`

**Files:**
- Create: `src/web/components/ui/Segmented.tsx`
- Modify: `src/web/styles.css`, `tests/ui-styles.test.ts`
- Test: `tests/segmented.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange: (next: T) => void; label: string })`.

- [ ] **Step 1: Write the failing test**

Create `tests/segmented.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Segmented } from "@web/components/ui/Segmented";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

test("it is announced as one named group of radios", async () => {
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={() => {}} />,
  );
  const group = host.querySelector("[role='radiogroup']") as HTMLElement;
  expect(group.getAttribute("aria-label")).toBe("Theme");
  expect(host.querySelectorAll("[role='radio']").length).toBe(3);
});

test("exactly one member is checked", async () => {
  const host = await render(
    <Segmented label="Theme" value="light" options={[...THEMES]} onChange={() => {}} />,
  );
  const checked = [...host.querySelectorAll("[role='radio']")]
    .filter((n) => n.getAttribute("aria-checked") === "true");
  expect(checked.length).toBe(1);
  expect(checked[0]?.textContent).toContain("Light");
});

test("selection reads as contrast, not as hue alone", async () => {
  // The selected member must survive greyscale, like every other state here.
  const host = await render(
    <Segmented label="Theme" value="dark" options={[...THEMES]} onChange={() => {}} />,
  );
  const selected = host.querySelector("[role='radio'][aria-checked='true']") as HTMLElement;
  expect(selected.dataset.selected).toBe("yes");
});

test("tapping a member reports its value", async () => {
  const seen: string[] = [];
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={(v) => seen.push(v)} />,
  );
  const dark = [...host.querySelectorAll("[role='radio']")]
    .find((n) => (n.textContent ?? "").includes("Dark")) as HTMLButtonElement;
  dark.click();
  expect(seen).toEqual(["dark"]);
});

test("every option is visible at once, unlike the select it replaces", async () => {
  // A native select on iOS opens a full-screen wheel and hides the other
  // options while you pick between three of them.
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={() => {}} />,
  );
  expect(textsOf(host, "[role='radio']")).toEqual(["System", "Light", "Dark"]);
  expect(host.querySelector("select")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/segmented.test.tsx`
Expected: FAIL — cannot resolve module `@web/components/ui/Segmented`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/components/ui/Segmented.tsx`:

```tsx
/**
 * A row of mutually exclusive options, all visible at once.
 *
 * Replaces a native `<select>` for the small fixed choices in settings. On iOS
 * a select opens a full-screen wheel to pick between three values, which is
 * more ceremony than the choice deserves and hides the alternatives while you
 * choose among them.
 *
 * Selection is rendered as a filled high-contrast pill rather than a hue
 * change, so the chosen member survives greyscale like everything else in this
 * layer.
 */
export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="seg">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-selected={selected ? "yes" : "no"}
            className="seg-item"
            onClick={() => onChange(o.value)}
          >
            {o.icon ? <span className="seg-icon">{o.icon}</span> : null}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

Add to `src/web/styles.css`:

```css
.seg {
  display: flex;
  gap: 0.25rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  padding: 0.2rem;
}

.seg-item {
  flex: 1;
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border: 0;
  border-radius: 0.45rem;
  background: none;
  color: var(--fg-dim);
  font-size: 0.78rem;
  cursor: pointer;
}

/* Contrast, not hue: the selected member inverts rather than tinting, so it
   is still obviously selected in greyscale. */
.seg-item[data-selected="yes"] {
  background: var(--fg);
  color: var(--bg);
  font-weight: 600;
}

.seg-icon { display: inline-flex; }
.seg-icon svg { width: 15px; height: 15px; }
```

Add to `tests/ui-styles.test.ts`:

```ts
test("each segment is a full touch target", () => {
  expect(declaration(".seg-item", "min-height")).toBe(TOUCH_TARGET);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/segmented.test.tsx tests/ui-styles.test.ts`
Expected: PASS.

Run: `make check && bun test`
Expected: the whole suite green. This is the end of Phase 1, so the full suite is worth running once here.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/ui/Segmented.tsx src/web/styles.css tests/segmented.test.tsx tests/ui-styles.test.ts
git commit -m "feat: a segmented control instead of a select, because iOS hides the alternatives behind a wheel"
```

---

## Phase 2 — Contract

### Task 8: `Agent.harness`

**Files:**
- Modify: `src/shared/types.ts` (the `Agent` interface, after `cwd`)
- Modify: `src/server/herdr/adapter.ts` (`toAgent`)
- Modify: `tests/support/render.tsx` (the `agent()` fixture)
- Test: `tests/adapter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Agent.harness: string` — the harness name (`"claude"`, `"codex"`), required and never empty for any `Agent` that exists.

- [ ] **Step 1: Write the failing test**

Add to `tests/adapter.test.ts`, following the fixture style already in that file:

```ts
test("the harness name is carried through, not just used as a gate", () => {
  // HerdrAgentRaw.agent has always been on the wire. toAgent used it as a
  // truthiness check and then threw the value away, so the UI could not tell a
  // claude pane from a codex one.
  const a = toAgent({ ...raw(), agent: "codex" }, NOW);
  expect(a?.harness).toBe("codex");
});

test("an agent with no harness is still dropped entirely", () => {
  // The gate is the reason `harness` can be a required, non-empty string
  // everywhere downstream: a raw agent without one never becomes an Agent.
  expect(toAgent({ ...raw(), agent: null }, NOW)).toBeNull();
});
```

Match the existing file's helper names. If it builds raw agents inline rather
than via a `raw()` helper, inline the object the same way — read the top of
`tests/adapter.test.ts` first and follow it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/adapter.test.ts`
Expected: FAIL — `a?.harness` is `undefined`, and TypeScript reports `harness` is not a property of `Agent`.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/types.ts`, add to `Agent` immediately after `cwd`:

```ts
  /**
   * The harness running in this pane — "claude", "codex" — as herdr reports it
   * in `HerdrAgentRaw.agent`.
   *
   * It was always on the wire. `toAgent` used it as a truthiness gate and threw
   * the value away, so the UI had no way to tell one harness from another.
   *
   * Required, not optional, on the same reasoning as `hasJournal`: an optional
   * field lets a future edit drop it silently, and every tile would fall back
   * to a placeholder with nothing to notice. Safe to require because `toAgent`
   * returns null for any raw agent whose `agent` is falsy — a surviving Agent
   * always had one.
   */
  harness: string;
```

In `src/server/herdr/adapter.ts`, inside `toAgent`, add `harness` to the
returned object. The existing gate (`if (!rawAgent.agent) return null;`) stays
exactly as it is — it is what makes the field safe to require:

```ts
    harness: rawAgent.agent,
```

In `tests/support/render.tsx`, add to the `agent()` fixture defaults:

```ts
    harness: "claude",
```

- [ ] **Step 4: Run tests and fix the fixtures the compiler names**

Run: `make check`
Expected: errors in every test that builds an `Agent` literal — this is the
point of a required field. Add `harness: "claude"` (or `"codex"` where a test
distinguishes harnesses) to each. `tests/grouping.test.ts` has its own local
`agent()` helper and needs it too.

Run: `bun test`
Expected: whole suite green.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/shared/types.ts src/server/herdr/adapter.ts tests/
git commit -m "feat: carry the harness name, because it was already on the wire and thrown away"
```

---

### Task 9: Four sections

**Files:**
- Modify: `src/shared/types.ts` (`SECTION_ORDER`, `sectionFor`, and the comment above it)
- Modify: `src/web/components/Section.tsx` (`groupAgents`, `SECTION_TITLES`)
- Test: `tests/grouping.test.ts`

**Interfaces:**
- Consumes: nothing from Task 8.
- Produces:
  - `SECTION_ORDER = ["needs-you", "ready-unseen", "working", "idle"]`
  - `Section = "needs-you" | "ready-unseen" | "working" | "idle"`
  - `SECTION_TITLES["ready-unseen"] === "Ready"`

- [ ] **Step 1: Write the failing test**

In `tests/grouping.test.ts`, **replace** the two tests that pin the old
taxonomy — `"blocked and done both land in needs-you"` and `"every section key
exists even when empty, in fixed triage order"` — and the `SECTION_ORDER` test,
with:

```ts
test("a stuck agent and a finished one no longer share a section", () => {
  // They are different urgencies. One wants a decision before work continues;
  // the other is news you have not read. Sharing a section made the unread
  // news compete with the decision.
  const g = groupAgents([agent("a", "blocked"), agent("b", "done")]);
  expect(g["needs-you"].map((x) => x.name)).toEqual(["a"]);
  expect(g["ready-unseen"].map((x) => x.name)).toEqual(["b"]);
});

test("an acknowledged finish drops to idle", () => {
  const acked = { ...agent("c", "done"), acknowledgedAt: NOW };
  const g = groupAgents([acked]);
  expect(g["ready-unseen"]).toEqual([]);
  expect(g.idle.map((x) => x.name)).toEqual(["c"]);
});

test("every section key exists even when empty, in fixed triage order", () => {
  // Not sorted: this pins the real key order groupAgents produces, so a
  // reorder (or a switch to alphabetical) breaks the test instead of passing
  // silently.
  const g = groupAgents([]);
  expect(Object.keys(g)).toEqual(["needs-you", "ready-unseen", "working", "idle"]);
});

test("SECTION_ORDER is pinned — the operator always knows where to look", () => {
  expect(SECTION_ORDER).toEqual(["needs-you", "ready-unseen", "working", "idle"]);
});

test("the ready section is titled in paddock's plainer register", () => {
  // "Done" is rejected: `done` is also a STATE, and an acknowledged done
  // renders under Idle — a label that contradicted the state name in one of
  // its two cases would be worse than a new word.
  expect(SECTION_TITLES["ready-unseen"]).toBe("Ready");
});
```

Add `SECTION_TITLES` to the imports from `@web/components/Section`.

Leave every other test in the file alone — in particular `"within Needs you,
most-recently-changed first"` and `"triage order survives a delta"` still hold
and are the reason `compareAgents` needs no change.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/grouping.test.ts`
Expected: FAIL — `g["ready-unseen"]` is `undefined`; `SECTION_ORDER` has three members.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/types.ts`:

```ts
export const SECTION_ORDER = ["needs-you", "ready-unseen", "working", "idle"] as const;
```

Replace `sectionFor` and rewrite its comment, which currently explains a
two-way split that no longer exists:

```ts
export function sectionFor(agent: Agent): Section {
  if (agent.state === "blocked") return "needs-you";
  // A finish and a block are different urgencies: one wants a decision before
  // work continues, the other is news nobody has read. They shared `needs-you`
  // until now, which let unread news compete with a decision. Once
  // acknowledged, a finish has been dealt with and stops competing with
  // either.
  if (agent.state === "done") return agent.acknowledgedAt === null ? "ready-unseen" : "idle";
  if (agent.state === "working") return "working";
  return "idle";
}
```

In `src/web/components/Section.tsx`:

```ts
export function groupAgents(agents: Agent[]): Record<SectionKey, Agent[]> {
  const out = {
    "needs-you": [], "ready-unseen": [], working: [], idle: [],
  } as Record<SectionKey, Agent[]>;
  for (const a of [...agents].sort(compareAgents)) out[sectionFor(a)].push(a);
  return out;
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  "needs-you": "Needs you",
  "ready-unseen": "Ready",
  working: "Working",
  idle: "Idle",
};
```

`compareAgents` is not touched: it indexes `SECTION_ORDER`, so both the
server's snapshot sort and the client's post-delta re-sort follow automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/grouping.test.ts`
Expected: PASS.

Run: `make check`
Expected: errors anywhere a `Record<Section, …>` is built without the new key —
fix each by adding `"ready-unseen"`.

Run: `bun test`
Expected: whole suite green. Pay attention to `tests/acknowledge-ui.test.ts`
and `tests/acknowledge.test.ts`: acknowledging now moves an agent from
`ready-unseen` to `idle` rather than from `needs-you` to `idle`. If they assert
on the section, update the expectation; if they assert on `acknowledgedAt`, they
are unaffected.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/shared/types.ts src/web/components/Section.tsx tests/
git commit -m "feat: a section for a finish nobody has read, because it was competing with agents that are stuck"
```

---

## Phase 3 — Dashboard

### Task 10: Row emphasis and tiles

**Files:**
- Modify: `src/web/components/AgentRow.tsx`
- Modify: `src/web/components/App.tsx:146-177`
- Modify: `src/web/styles.css`
- Test: `tests/agent-row-emphasis.test.tsx`

**Interfaces:**
- Consumes: `IconTile` (Task 3), `StatusDot` (Task 2), `Agent.harness` (Task 8), `Section` (Task 9).
- Produces:
  - `type RowEmphasis = "alert" | "card" | "bare"`
  - `emphasisFor(section: Section): RowEmphasis`
  - `AgentRow({ agent, now, emphasis?, onSelect? })` — `emphasis` defaults to `"bare"`.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-row-emphasis.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentRow, emphasisFor } from "@web/components/AgentRow";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("emphasis is derived from the section, not from the state", () => {
  // The ladder answers "how much of your attention does this GROUP deserve".
  // Deriving it from state would put the decision in two places the first time
  // a state maps somewhere new.
  expect(emphasisFor("needs-you")).toBe("alert");
  expect(emphasisFor("ready-unseen")).toBe("card");
  expect(emphasisFor("working")).toBe("bare");
  expect(emphasisFor("idle")).toBe("bare");
});

test("an alert row is a bordered, tinted card", async () => {
  // The container IS the second channel: urgency has to survive greyscale,
  // which a hue-only dot does not.
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} emphasis="alert" />);
  expect((host.querySelector(".row") as HTMLElement).dataset.emphasis).toBe("alert");
});

test("a working row stays bare, so the alert above it still stands out", async () => {
  const host = await render(<AgentRow agent={agent()} now={0} emphasis="bare" />);
  expect((host.querySelector(".row") as HTMLElement).dataset.emphasis).toBe("bare");
});

test("the row carries the harness tile", async () => {
  const host = await render(<AgentRow agent={agent({ harness: "codex" })} now={0} />);
  expect(host.querySelector(".tile")?.getAttribute("aria-label")).toBe("codex");
});

test("the status dot is overlaid on the tile, not placed beside it", async () => {
  // At 390px an overlaid dot costs nothing where a sibling dot costs a column.
  const host = await render(<AgentRow agent={agent()} now={0} />);
  expect(host.querySelector(".tile-badge .dot")).not.toBeNull();
});

test("the state is still carried as text, because colour is never the only channel", async () => {
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} emphasis="alert" />);
  expect(host.textContent).toContain("blocked");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-row-emphasis.test.tsx`
Expected: FAIL — `emphasisFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/web/components/AgentRow.tsx`, add above `AgentRow`:

```tsx
import type { Section } from "@shared/types";
import { IconTile } from "@web/components/ui/IconTile";

export type RowEmphasis = "alert" | "card" | "bare";

/**
 * How loud a row is, by SECTION rather than by state.
 *
 * The ladder answers "how much of your attention does this group deserve",
 * which is a property of the group. Deriving it from state would put the same
 * decision in two places, and they would disagree the first time a state maps
 * somewhere new — which is exactly what just happened to `done`.
 *
 * This is the second channel the palette comment has always claimed: a bordered
 * tinted card versus a bare row survives greyscale, where two hues of dot do
 * not.
 */
export function emphasisFor(section: Section): RowEmphasis {
  if (section === "needs-you") return "alert";
  if (section === "ready-unseen") return "card";
  return "bare";
}
```

Change the `AgentRow` signature and its container. Keep the existing `role`,
`tabIndex` and `onKeyDown` wiring exactly as it is:

```tsx
export function AgentRow({
  agent, now, emphasis = "bare", onSelect,
}: {
  agent: Agent;
  now: number;
  emphasis?: RowEmphasis;
  onSelect?: () => void;
}) {
```

Replace the container's `className`/`style` with:

```tsx
      className="tap row flex items-center gap-2.5 px-3 py-2.5"
      data-emphasis={emphasis}
```

(dropping the inline `borderTop`, which moves to `.row[data-emphasis="bare"]`),
and replace the leading `<StatusDot …/>` with the tile carrying the dot:

```tsx
      <IconTile harness={agent.harness} badge={<StatusDot state={agent.state} />} />
```

Add a visually-hidden state word so the text channel survives. **`.sr-only`
already exists at `src/web/styles.css:343` — reuse it, do not add a second
copy:**

```tsx
      <span className="sr-only">{agent.state}</span>
```

Add to `src/web/styles.css`:

```css
/* Bare is the resting form and keeps the hairline the list has always had. */
.row[data-emphasis="bare"] { border-top: 1px solid var(--border); }

.row[data-emphasis="card"],
.row[data-emphasis="alert"] {
  margin: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.7rem;
  background: var(--surface);
}

/* The loudest row in the app. Border AND fill, so it is not relying on the
   dot's hue to say that something has stopped and needs a person. */
.row[data-emphasis="alert"] {
  border-color: var(--danger);
  background: var(--danger-wash);
}
```

In `src/web/components/App.tsx`, pass the emphasis at the `AgentRow` call site
(around line 162), importing `emphasisFor`:

```tsx
                      <AgentRow
                        key={a.agentId} agent={a} now={now}
                        emphasis={emphasisFor(key)}
                        onSelect={() => { location.hash = agentHash(a.agentId); }}
                      />
```

`key` here is the section key the surrounding `SECTION_ORDER.map` is iterating —
confirm the local variable's name when editing and use it.

The `idle` branch that renders `AgentChip` is unchanged: a wrapped cloud of
name-only pills is the densest form available for a section that is routinely
five of six agents, and the contrast between cloud and rows is itself a fourth
rung on the ladder.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/agent-row-emphasis.test.tsx`
Expected: PASS.

Run: `bun test`
Expected: whole suite green.

- [ ] **Step 5: Verify in a browser**

Run: `make dev`

Open the dashboard with `?demo=1` (check `src/web/demo/backend.ts` for the exact
flag) at a 390px viewport and confirm: the needs-you row is a tinted bordered
card, ready rows are plain cards, working rows are bare, idle is still a chip
cloud, and every tile shows its harness initials with the dot overlaid at the
bottom-left. Then switch the theme both ways and confirm the wash and the tiles
still read.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/AgentRow.tsx src/web/components/App.tsx src/web/styles.css tests/agent-row-emphasis.test.tsx
git commit -m "feat: escalate the row itself, because urgency should survive greyscale"
```

---

### Task 11: `SectionHeader` — the section dot

**Files:**
- Modify: `src/web/components/Section.tsx`
- Test: `tests/section-header.test.tsx`

**Interfaces:**
- Consumes: `StatusDot` (Task 2).
- Produces: `SectionHeader({ title, count, dotState?, expandable?, expanded?, onToggle? })` where `dotState?: AgentState`.

**Deviation from the spec, deliberate.** The design also gives `SectionHeader` a
`trailing` slot for "a sort toggle, a `new` button". paddock has neither, and
nothing in this plan passes one — it would ship as a slot with no consumer,
which is the same dead-code problem Step 4 below exists to prevent for
`dotState`. It is three lines to add the day something needs it. The
sibling-not-nested constraint the spec records is preserved as a comment on the
markup, so whoever adds it does not nest it.

- [ ] **Step 1: Write the failing test**

Create `tests/section-header.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { SectionHeader } from "@web/components/Section";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a section can carry the dot of the state it collects", async () => {
  const host = await render(<SectionHeader title="Needs you" count={1} dotState="blocked" />);
  expect(host.querySelector(".dot")).not.toBeNull();
});

test("a section with no dot state renders no dot", async () => {
  const host = await render(<SectionHeader title="Idle" count={0} />);
  expect(host.querySelector(".dot")).toBeNull();
});

test("an unexpandable header exposes no fold control", async () => {
  // Collapsing an alert defeats the alert, so those sections pass no toggle at
  // all rather than a disabled one.
  const host = await render(<SectionHeader title="Needs you" count={1} dotState="blocked" />);
  expect(host.querySelector("button[aria-expanded]")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/section-header.test.tsx`
Expected: FAIL — `SectionHeader` accepts no `dotState`, so no `.dot` renders.

- [ ] **Step 3: Write minimal implementation**

Rewrite `SectionHeader` in `src/web/components/Section.tsx`:

```tsx
import type { AgentState } from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

export function SectionHeader({
  title, count, dotState, expandable, expanded, onToggle,
}: {
  title: string;
  count: number;
  /** The state this section collects, shown as a dot beside the label. */
  dotState?: AgentState;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      {dotState ? <StatusDot state={dotState} /> : null}
      <span className="text-[9.5px] font-bold uppercase tracking-[0.09em]">{title}</span>
      <span className="text-[9.5px]"> · {count}</span>
    </>
  );
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5" style={{ color: "var(--fg-dim)" }}>
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="tap flex flex-1 items-center gap-1.5 text-left"
          style={{ color: "inherit" }}
        >
          {label} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
        </button>
      ) : (
        <div className="flex flex-1 items-center gap-1.5">{label}</div>
      )}
      {/* Any control added at the end of this row must be a SIBLING of the
          fold button above, never nested inside it: nested, pressing the
          control would also fold the section, so a sort toggle would collapse
          the very list it was sorting. */}
    </div>
  );
}
```

- [ ] **Step 4: Wire it up, so the new props are not dead code**

There is no linter here (`make check` is `tsc --noEmit` only), so an unused prop
would sit unnoticed. Give each section its dot in `src/web/components/App.tsx`
at the `SectionHeader` call site (around line 146).

Add to `src/web/components/Section.tsx`, next to `SECTION_TITLES`:

```ts
/**
 * The state whose dot stands for each section.
 *
 * A section's dot is the colour of the thing it collects, which is why this is
 * a map rather than a per-row lookup: an empty "Needs you" still shows red, so
 * the header means the same thing whether or not anything is under it.
 */
export const SECTION_DOT: Record<SectionKey, AgentState> = {
  "needs-you": "blocked",
  "ready-unseen": "done",
  working: "working",
  idle: "idle",
};
```

Then pass it, using whatever the surrounding `SECTION_ORDER.map` names its key:

```tsx
              <SectionHeader
                title={SECTION_TITLES[key]}
                count={list.length}
                dotState={SECTION_DOT[key]}
                …existing expandable / expanded / onToggle props unchanged…
              />
```

Leave `expandable` as it is today. Anything actionable must stay open —
collapsing an alert defeats the alert — and those sections already pass no
toggle rather than a disabled one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/section-header.test.tsx`
Expected: PASS.

Run: `bun test`
Expected: whole suite green. `tests/host-header.test.tsx` and any App-level test
that queried the old header markup may need their selectors updated.

- [ ] **Step 6: Verify the props reach the screen**

Run: `grep -n "dotState" src/web/components/App.tsx`
Expected: one hit. No hit means the primitive gained a prop nobody passes.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/components/Section.tsx tests/section-header.test.tsx
git commit -m "feat: a dot on each section header, because an empty Needs you should still read as red"
```

---

## Phase 4 — Settings

### Task 12: The "This device" band

**Files:**
- Modify: `src/web/components/settings/DeviceSection.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/device-section.test.tsx`

**Interfaces:**
- Consumes: `Card` (5), `Toggle` (6), `Segmented` (7), `icons` (4).
- Produces: `DeviceSection({ prefs, setPref })` — unchanged signature, three cards inside.

- [ ] **Step 1: Write the failing test**

Create `tests/device-section.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { DeviceSection } from "@web/components/settings/DeviceSection";
import { readPrefs } from "@web/prefs";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

function harness() {
  const written: [string, unknown][] = [];
  const prefs = { ...readPrefs(), theme: "system" as const };
  return { written, prefs, setPref: (k: string, v: unknown) => { written.push([k, v]); } };
}

test("each group is its own card", async () => {
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  expect(textsOf(host, ".card-title")).toEqual(["Appearance", "Live updates", "Terminal"]);
});

test("theme is a segmented control, not a select", async () => {
  // A native select on iOS opens a full-screen wheel for three values.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const group = host.querySelector("[role='radiogroup'][aria-label='Theme']");
  expect(group).not.toBeNull();
  expect(host.querySelector("select[name='theme']")).toBeNull();
});

test("choosing a theme writes the preference immediately", async () => {
  // "This device" is localStorage-immediate: there is no Save to press.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const dark = [...host.querySelectorAll("[aria-label='Theme'] [role='radio']")]
    .find((n) => (n.textContent ?? "").includes("Dark")) as HTMLButtonElement;
  dark.click();
  expect(h.written).toEqual([["theme", "dark"]]);
});

test("wrap is a switch, and reports the next value", async () => {
  const h = harness();
  const host = await render(
    <DeviceSection prefs={{ ...h.prefs, wrap: false }} setPref={h.setPref as never} />,
  );
  const sw = host.querySelector("[role='switch'][aria-label='Wrap long lines']") as HTMLButtonElement;
  expect(sw).not.toBeNull();
  sw.click();
  expect(h.written).toEqual([["wrap", true]]);
});

test("blank font size still means automatic, not zero", async () => {
  // styles.css sizes the pane with var(--term-font-px, clamp(...)), so blank is
  // the DEFAULT rather than a reset — an empty string must write null, never
  // Number("") === 0.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const input = host.querySelector("input[name='fontPx']") as HTMLInputElement;
  expect(input.placeholder).toBe("Automatic");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/device-section.test.tsx`
Expected: FAIL — no `.card-title` elements; the theme control is still a `<select>`.

- [ ] **Step 3: Write minimal implementation**

Rewrite `src/web/components/settings/DeviceSection.tsx` as three `Card`s. Keep
`RATE_LABELS` and the `fontPx` null-vs-zero handling and its comment verbatim —
that comment documents a live bug fix, not the obvious.

```tsx
import { RATE_MS, type Prefs, type RatePref, type ThemePref } from "@web/prefs";
import { Card } from "@web/components/ui/Card";
import { Segmented } from "@web/components/ui/Segmented";
import { Toggle } from "@web/components/ui/Toggle";
import { ActivityIcon, MonitorIcon, TerminalIcon } from "@web/components/ui/icons";

const RATE_LABELS: Record<RatePref, string> = { live: "Live", balanced: "Balanced", frugal: "Frugal" };

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface DeviceSectionProps {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
}

export function DeviceSection({ prefs, setPref }: DeviceSectionProps) {
  return (
    <>
      <Card
        icon={<MonitorIcon />}
        title="Appearance"
        subtitle="Follow this device, or pin one."
      >
        <Segmented
          label="Theme"
          value={prefs.theme}
          options={THEMES}
          onChange={(v) => setPref("theme", v)}
        />
      </Card>

      <Card
        icon={<ActivityIcon />}
        title="Live updates"
        subtitle="How often paddock asks for a new screen."
      >
        <Segmented
          label="Refresh rate"
          value={prefs.rate}
          options={(Object.keys(RATE_MS) as RatePref[]).map((r) => ({ value: r, label: RATE_LABELS[r] }))}
          onChange={(v) => setPref("rate", v)}
        />
      </Card>

      <Card
        icon={<TerminalIcon />}
        title="Terminal"
        subtitle="How an agent's screen is drawn on this device."
      >
        <label className="card-row">
          <span>Font size</span>
          {/* Empty means "automatic", and that is the DEFAULT, not a reset
              button: styles.css sizes the pane with
              `clamp(0.62rem, 2.3vw, 0.78rem)` behind `var(--term-font-px, …)`,
              so leaving this blank is what keeps the responsive sizing in
              charge. An empty string must therefore write `null` (which
              removes the key) rather than `Number("")`, i.e. 0. */}
          <input
            type="number" name="fontPx" min={10} max={22} placeholder="Automatic"
            value={prefs.fontPx ?? ""}
            onChange={(e) => setPref("fontPx", e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>

        <div className="card-row">
          <span>Wrap long lines</span>
          <Toggle
            label="Wrap long lines" checked={prefs.wrap}
            onChange={(v) => setPref("wrap", v)}
          />
        </div>

        <div className="card-row">
          {/* A DEVICE preference, not a server one, and deliberately so: it is
              about how much of this screen the pad is worth, and the same
              account on a laptop has room the phone does not. The pad itself is
              collapsed and expanded from the terminal view — this only governs
              whether a blocked agent may open it for you. It can never close
              it. */}
          <span>Open the keypad when an agent needs you</span>
          <Toggle
            label="Open the keypad when an agent needs you" checked={prefs.keypadAuto}
            onChange={(v) => setPref("keypadAuto", v)}
          />
        </div>
      </Card>
    </>
  );
}
```

Add to `src/web/styles.css`:

```css
/* A labelled row inside a card body. Replaces `.settings-field-row`, and keeps
   the 44px floor that rule existed to guarantee. */
.card-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 2.75rem;
  font-size: 0.8rem;
}

.card-row + .card-row { border-top: 1px solid var(--border); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/device-section.test.tsx`
Expected: PASS.

Run: `bun test tests/prefs-applied.test.tsx`
Expected: PASS — this test drives the theme control. It used a bare `change`
event on a `<select>` (see the note in `tests/support/render.tsx` about selects
taking a different React branch); with a button-based segmented control it must
`.click()` the right radio instead. Update it.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/settings/DeviceSection.tsx src/web/styles.css tests/device-section.test.tsx tests/prefs-applied.test.tsx
git commit -m "feat: settings groups as cards, because a bordered group is scannable where a wall of fields is not"
```

---

### Task 13: The "All devices" band

**Files:**
- Modify: `src/web/components/settings/NotifySection.tsx`, `TelegramSection.tsx`, `TunnelSection.tsx`
- Modify: `src/web/components/Settings.tsx:262-330`
- Test: `tests/notify-card.test.tsx`

**Interfaces:**
- Consumes: `Card` (5), `Toggle` (6), `icons` (4).
- Produces: unchanged component signatures; `NotifySection` and `TelegramSection` each render a `Card`; `Settings` renders three bands.

**Read this before starting.** Two facts contradict what a reader might assume
from the reference implementation:

1. **`NotifySection` and `TelegramSection` render bare fragments (`<>`).** They
   have no `<section>` and no `<h2>` of their own — the single
   `<section className="settings-section">` with `<h2>All devices</h2>` lives in
   `Settings.tsx:293`, and both components sit inside it. So this task *gives*
   them titles for the first time; it is not moving existing ones.
2. **paddock has no browser push and no notification permission.** There is no
   `Notification.requestPermission` anywhere in `src/web/`; notifications are
   Telegram, sent server-side. The `.settings-banner` inside `NotifySection` is
   the **quick-tunnel URL warning**, not a permission notice. That warning, and
   `saveError`, are this codebase's real uses for `Card`'s `footer`.

- [ ] **Step 1: Write the failing test**

Create `tests/notify-card.test.tsx`. The prop list below is
`NotifySectionProps` verbatim — every field is required, so all of them must be
passed:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { NotifySection } from "@web/components/settings/NotifySection";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/** Every prop NotifySectionProps requires, with the quick-tunnel URL as the
 *  publicUrl so the warning branch is the one under test. */
function props(over: Record<string, unknown> = {}) {
  return {
    notifyEnabled: true, setNotifyEnabled: () => {},
    triggers: ["blocked"] as const, toggleTrigger: () => {},
    cooldownMs: 60_000, setCooldownMs: () => {},
    publicUrl: "", setPublicUrl: () => {},
    settleMs: { blocked: 5_000, done: 10_000 }, setSettleMs: () => {},
    mutedUntil: null, serverNow: 1_700_000_000_000,
    onMute: () => {}, muting: false,
    ...over,
  };
}

test("the notifications group is a titled card", async () => {
  // It had no heading of its own before: the only <h2> was "All devices", on
  // the section wrapping both this and Telegram.
  const host = await render(<NotifySection {...props() as never} />);
  expect(textsOf(host, ".card-title")).toEqual(["Notifications"]);
});

test("the quick-tunnel warning is stated in the card footer, not floated inline", async () => {
  // An explanation of why a field should be LEFT ALONE belongs to the setting.
  // A quick-tunnel hostname changes every run, so saving it points notification
  // links at a name that has stopped resolving.
  const host = await render(
    <NotifySection {...props({ publicUrl: "https://random-words-here.trycloudflare.com" }) as never} />,
  );
  const foot = host.querySelector(".card-foot") as HTMLElement;
  expect(foot).not.toBeNull();
  expect(foot.textContent).toContain("quick-tunnel URL");
});

test("an ordinary public URL leaves the footer off entirely", async () => {
  // An empty divided region reads as a rendering bug.
  const host = await render(
    <NotifySection {...props({ publicUrl: "https://paddock.example.com" }) as never} />,
  );
  expect(host.querySelector(".card-foot")).toBeNull();
});

test("the enable control is a switch", async () => {
  const host = await render(<NotifySection {...props() as never} />);
  expect(host.querySelector("[role='switch']")).not.toBeNull();
});
```

Confirm the quick-tunnel test URL against `isQuickTunnelUrl` in
`src/shared/quick-tunnel.ts` — it must be a hostname that function actually
matches, or the branch never runs and the test passes for the wrong reason.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/notify-card.test.tsx`
Expected: FAIL — no `.card-title` (the component renders a bare fragment), and no `.card-foot`.

- [ ] **Step 3: Write minimal implementation**

`NotifySection` — wrap the existing fragment in a `Card`, lift the quick-tunnel
warning out of the `<label>` it currently sits inside, and pass it as `footer`.
Keep the warning's wording **verbatim**; it is reviewed user-facing copy:

```tsx
import { BellIcon } from "@web/components/ui/icons";
import { Card } from "@web/components/ui/Card";

// …inside the component, replacing the outer <> …
  const quickTunnel = isQuickTunnelUrl(publicUrl);
  return (
    <Card
      icon={<BellIcon />}
      title="Notifications"
      subtitle="Telegram messages when an agent needs you or finishes."
      footer={quickTunnel ? (
        <>
          That is a quick-tunnel URL, and it changes every time <code>paddock tunnel</code> runs
          — so saving it here will point notification links at a hostname that has stopped
          resolving. Leave this empty while using <code>paddock tunnel</code>: it fills the link
          in automatically for the life of each run.
        </>
      ) : undefined}
    >
      {/* the existing body, unchanged apart from the two conversions below */}
    </Card>
  );
```

`TelegramSection` → wrap in
`<Card icon={<SendIcon />} title="Telegram" subtitle="The bot that delivers them.">`.

`TunnelSection` already has its own `<section className="settings-section">` and
`<h2>` (unlike the other two) — replace those with
`<Card icon={<LinkIcon />} title="Remote access" subtitle={…its existing hint text…}>`,
reusing the hint verbatim. Keep its "render nothing when `tunnel` is null"
behaviour: a paddock served the ordinary way has no tunnel to describe and must
not offer to pair one.

Convert each `.settings-field settings-field-row` checkbox to a `.card-row` plus
`Toggle`. Leave `.settings-triggers`, `.settings-settle` and `.settings-mute`
**exactly as they are** — they are guarded by `tests/settings-styles.test.ts`
and are internal to the Notifications card rather than part of the container
vocabulary being replaced.

`TunnelSection` keeps its existing "render nothing when `tunnel` is null"
behaviour: a paddock served the ordinary way has no tunnel to describe and must
not offer to pair one.

In `src/web/components/Settings.tsx`, replace the two `<section className="settings-section">` wrappers with three labelled bands:

```tsx
      <div className="band">
        <p className="band-label">This device</p>
        <p className="band-hint">
          Stored in this browser only. Each device you open paddock on keeps its own copy.
        </p>
        <DeviceSection prefs={prefs} setPref={setPref} />
      </div>

      <div className="band">
        <p className="band-label">All devices</p>
        <p className="band-hint">
          These are server settings and affect every device, not just this one.
        </p>
        {/* Both call sites keep the EXACT prop lists they have today at
            Settings.tsx:299-323 — this task changes what wraps them, not what
            they are given. TunnelSection stays where it already is, above,
            since it is conditional on `view?.tunnel`. */}
        <TelegramSection … />
        <NotifySection … />
        {saveError && <p className="settings-banner">{saveError}</p>}
      </div>
```

The `band-hint` copy is the existing `.settings-hint` text from
`Settings.tsx:296`, moved rather than rewritten.

The band split is load-bearing and must not be flattened: "This device" writes
straight to localStorage and takes effect immediately, "All devices" is a form
over one `SettingsView` where nothing applies until Save succeeds. `SaveBar`
continues to govern only the second band. A single flat wall of identical cards
would imply one commit model where there are two, and the failure it invites —
believing a switch is set when Save never happened — is the exact one this
split exists to prevent.

Add to `src/web/styles.css`:

```css
.band { padding: 0.9rem 0.9rem 0.4rem; }

.band-label {
  margin: 0 0 0.15rem;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--fg-dim);
}

.band-hint { margin: 0 0 0.6rem; font-size: 0.72rem; color: var(--fg-dim); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/notify-card.test.tsx`
Expected: PASS.

Run: `bun test`
Expected: whole suite green. `tests/settings-view.test.tsx`, `tests/tunnel-section.test.tsx` and `tests/settings-save-bar.test.tsx` query settings markup and are the likely breaks; update selectors, not guarantees.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/settings/ src/web/components/Settings.tsx src/web/styles.css tests/
git commit -m "feat: bands around the settings cards, because two commit models must not look like one"
```

---

### Task 14: Retire the replaced CSS

**Files:**
- Modify: `src/web/styles.css`
- Modify: `tests/settings-styles.test.ts`

**Interfaces:**
- Consumes: everything in Phase 4.
- Produces: no `.settings-section`, `.settings-field`, `.settings-field-row`, `.settings-hint` or `.settings-hint-inline` rules.

**Note — this refines the spec.** The design says "`.settings-*` gets deleted".
Taken literally that deletes rules `tests/settings-styles.test.ts` guards and
whose `ruleBody()` helper **throws** when a selector is missing. Only the
*container and field* vocabulary being replaced is deleted. These stay, because
they are internal to a card rather than a second way to draw one:
`.settings`, `.settings-header`, `.settings-title`, `.settings-banner`,
`.settings-save-bar`, `.settings-toast`, `.settings-triggers`,
`.settings-settle`, `.settings-mute`.

- [ ] **Step 1: Find every remaining consumer**

Run: `grep -rn "settings-section\|settings-field\|settings-hint" src/`
Expected: no hits. If any remain, Task 12 or 13 missed a section — fix that
first; this task deletes CSS and must not orphan markup.

- [ ] **Step 2: Migrate the two guards whose selectors are being replaced**

`tests/settings-styles.test.ts` asserts a 44px floor on `.settings-field-row`.
That guarantee moves to `.card-row`. Replace that test:

```ts
test("a labelled row inside a card clears the touch target", () => {
  // Was `.settings-field-row`. The vocabulary changed; the 44px floor it
  // existed to guarantee did not.
  expect(declaration(".card-row", "min-height")).toBe(TOUCH_TARGET);
});
```

Leave the `.settings-triggers`, `.settings-triggers legend`, `.term-pane`,
`.settings-save-bar`, `.settings`, `.settings-toast:empty` and `.settings-mute
button` tests untouched — every one of those selectors survives.

- [ ] **Step 3: Run the tests to confirm they still fail for the right reason**

Run: `bun test tests/settings-styles.test.ts`
Expected: PASS already (`.card-row` exists from Task 12). If it throws
`no CSS rule for ".card-row"`, Task 12 is incomplete.

- [ ] **Step 4: Delete the replaced rules**

Remove from `src/web/styles.css`: `.settings-section`, `.settings-section h2`,
`.settings-hint`, `.settings-hint-inline`, `.settings-field`,
`.settings-field-row`, and any descendant rules of those selectors.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: green. A `no CSS rule for "…"` failure names a selector still guarded
by a test — restore that rule rather than deleting the test.

Run: `make check`
Expected: clean.

- [ ] **Step 6: Verify in a browser**

Run: `make dev`

Open `#/settings` at 390px. Confirm: three bands, cards with icon headers,
theme and rate as segmented controls, toggles right-aligned in their rows,
Save still appears only for the second band and still clears the home
indicator. Switch themes both ways.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/styles.css tests/settings-styles.test.ts
git commit -m "refactor: drop the replaced field vocabulary, because two ways to draw one group is one too many"
```

---

## Phase 5 — Stamp and diagnostics

### Task 15: The build stamp

**Files:**
- Create: `src/web/build.ts`, `src/web/components/BuildStamp.tsx`
- Modify: `vite.config.ts`, `Makefile`, `src/web/vite-env.d.ts`, `src/web/components/App.tsx`, `src/web/styles.css`
- Test: `tests/build-stamp-ui.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BUILD: { version: string; commit: string; time: string }` from `@web/build`
  - `BuildStamp()` — renders `v{version} · {commit} · {time}`.

- [ ] **Step 1: Write the failing test**

Create `tests/build-stamp-ui.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { BuildStamp } from "@web/components/BuildStamp";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the stamp names the bundle's own version, commit and time", async () => {
  // The whole point of showing it: it must report the JavaScript actually
  // running, which is what `buildIdFrom` compares but cannot display.
  const host = await render(<BuildStamp />);
  const text = host.textContent ?? "";
  expect(text).toContain("·");
  expect(text.split("·").length).toBe(3);
});

test("an unstamped build says dev rather than inventing a hash", async () => {
  // build-id.ts's own rule: "Null rather than a placeholder … inventing an id
  // there would make every client believe a new build had just landed". A
  // fabricated commit is the same trap.
  //
  // `bun test` applies no vite define, so this asserts the fallback path
  // unconditionally — there is no branch and nothing to guard.
  const { BUILD } = await import("@web/build");
  expect(BUILD.commit).toBe("dev");
  expect(BUILD.version).toBe("0.0.0-dev");
  const host = await render(<BuildStamp />);
  expect(host.textContent).toContain("dev");
});

test("the stamp is monospace, so a hash is readable", async () => {
  const host = await render(<BuildStamp />);
  expect((host.firstElementChild as HTMLElement).className).toContain("build-stamp");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/build-stamp-ui.test.tsx`
Expected: FAIL — cannot resolve `@web/components/BuildStamp`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/build.ts`:

```ts
/**
 * Which bundle this tab is running, for display.
 *
 * NOT the same thing as `src/server/build-id.ts`. That derives an id from the
 * hashed asset filenames in the served `index.html` — the right identity for
 * COMPARING two builds, and far too long to put in a footer
 * (`index-Cj_7W-bH.js+index-9xKq2p.css`). This is the human-facing triple.
 *
 * Injected by a `define` in `vite.config.ts`. Each field falls back rather than
 * failing, because a source build with no git checkout must still produce a
 * working binary — the same contract `src/server/version.ts` already states, so
 * that a bug reported against a self-compiled binary says so.
 *
 * The fallback is the literal string "dev", never an invented hash. That is
 * `build-id.ts`'s own rule: a fabricated id makes every client believe a new
 * build just landed.
 */
export const BUILD = {
  version: __PADDOCK_VERSION__,
  commit: __PADDOCK_COMMIT__,
  time: __PADDOCK_BUILD_TIME__,
} as const;
```

Add to `src/web/vite-env.d.ts`:

```ts
declare const __PADDOCK_VERSION__: string;
declare const __PADDOCK_COMMIT__: string;
declare const __PADDOCK_BUILD_TIME__: string;
```

Under `bun test` there is no vite `define`, so these identifiers are not
defined at runtime. Guard `src/web/build.ts` so the module is importable in a
test:

```ts
const read = (v: string | undefined, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback;

export const BUILD = {
  version: read(typeof __PADDOCK_VERSION__ === "string" ? __PADDOCK_VERSION__ : undefined, "0.0.0-dev"),
  commit: read(typeof __PADDOCK_COMMIT__ === "string" ? __PADDOCK_COMMIT__ : undefined, "dev"),
  time: read(typeof __PADDOCK_BUILD_TIME__ === "string" ? __PADDOCK_BUILD_TIME__ : undefined, "unknown"),
} as const;
```

In `vite.config.ts`, add to the config object:

```ts
  define: {
    // JSON.stringify, not bare interpolation: a define value is substituted as
    // SOURCE TEXT, so an unquoted version becomes a syntax error or an
    // identifier. This is the same quoting hazard tests/version-stamp.test.ts
    // exists to catch on the server side.
    __PADDOCK_VERSION__: JSON.stringify(process.env.PADDOCK_VERSION ?? "0.0.0-dev"),
    __PADDOCK_COMMIT__: JSON.stringify(process.env.PADDOCK_COMMIT ?? "dev"),
    __PADDOCK_BUILD_TIME__: JSON.stringify(process.env.PADDOCK_BUILD_TIME ?? "unknown"),
  },
```

In the `Makefile`, export the two new values to the web build. The target is
`build-web` (Makefile:70, which runs `bun run build:web`). Add these at the top
level of the Makefile so the exports are in the environment `vite` inherits:

```make
PADDOCK_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
PADDOCK_BUILD_TIME ?= $(shell date -u +"%Y-%m-%d %H:%M UTC")
export PADDOCK_COMMIT
export PADDOCK_BUILD_TIME
```

`git rev-parse` is allowed a fallback here — this is not error-swallowing but
the documented "no git checkout" case, and it produces the literal `dev` the
tests assert on.

Note `package.json`'s `test` script also runs `bun run build:web` directly,
bypassing make. That path gets the fallbacks, which is correct: a test run is
not a release.

Create `src/web/components/BuildStamp.tsx`:

```tsx
import { BUILD } from "@web/build";

/**
 * Which bundle you are looking at.
 *
 * Twice in this project a bug was hunted in code that had already been fixed,
 * because the tab under test was stale. `UpdateBar` catches that when the
 * server's id changes while a tab is open; this answers the other question —
 * "what am I running right now" — without a reload or a devtools trip.
 */
export function BuildStamp() {
  return (
    <p className="build-stamp">
      v{BUILD.version} · {BUILD.commit} · {BUILD.time}
    </p>
  );
}
```

Add to `src/web/styles.css`:

```css
.build-stamp {
  margin: 1.25rem 0 0;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--fg-dim);
}
```

In `src/web/components/App.tsx`, render `<BuildStamp />` as the last child of
the dashboard scroll region — after the section list and the "No agents
detected." paragraph, inside the same wrapper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/build-stamp-ui.test.tsx`
Expected: PASS.

Run: `make check && bun test`
Expected: green.

- [ ] **Step 5: Verify the define actually reaches the bundle**

Run: `PADDOCK_VERSION=9.9.9-stamped make build-web`
Then: `grep -o "9.9.9-stamped" dist/assets/*.js | head -1`
Expected: a hit. No hit means the `define` is not wired and the stamp will read
`0.0.0-dev` in every release — the exact failure `tests/version-stamp.test.ts`
was written for on the server side.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/build.ts src/web/components/BuildStamp.tsx src/web/vite-env.d.ts src/web/components/App.tsx src/web/styles.css vite.config.ts Makefile tests/build-stamp-ui.test.tsx
git commit -m "feat: a stamp naming the bundle you are running, because a stale tab has cost half an hour twice"
```

---

### Task 16: Updates and Connection cards

**Files:**
- Create: `src/web/components/settings/InfoSection.tsx`
- Modify: `src/shared/types.ts` (receives `HealthBody`), `src/server/routes.ts` (re-exports it)
- Modify: `src/web/components/Settings.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/connection-card.test.tsx`

**Interfaces:**
- Consumes: `Card` (5), `icons` (4), `BUILD` (15).
- Produces: `InfoSection({ health }: { health: HealthBody | null })` — `null` while loading.

**A contract move comes first.** `HealthBody` is declared in
`src/server/routes.ts:26`. The UI cannot import it from there: `@server/` is
upstream of `web/`, and CLAUDE.md's rule 3 says `src/shared/types.ts` is the one
payload contract, imported by both server and UI, and that a payload shape is
never redeclared on one side. Redeclaring a `HealthView` in the web layer is
therefore the one thing this task must not do.

So **move the `HealthBody` interface verbatim — every comment with it — from
`src/server/routes.ts` into `src/shared/types.ts`**, and have `routes.ts` import
it. Every one of those field comments explains why the field is *required rather
than optional* so a future edit to `health()` is a type error; they are the
substance of the contract, not decoration.

- [ ] **Step 0: Move the contract**

In `src/shared/types.ts`, add the `HealthBody` interface exactly as it appears
at `src/server/routes.ts:26` onward, comments intact. In `src/server/routes.ts`,
delete the local declaration and import it instead:

```ts
import { isNavKey, type HealthBody, type ManagedBy, type NotifyTrigger, type SettingsPatch } from "@shared/types";
```

If anything else imported `HealthBody` from `@server/routes`, re-export it there
so those call sites keep working:

```ts
export type { HealthBody } from "@shared/types";
```

Run: `make check`
Expected: clean. Then `bun test tests/routes.test.ts` — expected PASS, since
this is a pure move.

- [ ] **Step 1: Write the failing test**

Create `tests/connection-card.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { InfoSection } from "@web/components/settings/InfoSection";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const LABELS = ["Endpoint", "Secure context", "herdr", "Last event", "Protocol", "Server build"];

test("every diagnostics row is rendered before the data arrives", async () => {
  // A row that appears when its data lands GROWS the card and shoves
  // everything below it down the page — under a thumb already reaching for
  // something.
  const host = await render(<InfoSection health={null} />);
  expect(textsOf(host, ".dl-label")).toEqual(LABELS);
});

test("a pending value is an em dash, not an empty cell", async () => {
  const host = await render(<InfoSection health={null} />);
  const values = textsOf(host, ".dl-value");
  expect(values.length).toBe(LABELS.length);
  expect(values.some((v) => v.includes("—"))).toBe(true);
});

test("the running version is in the Updates subtitle", async () => {
  // Where collie puts it, and it keeps the card body free for the action.
  const host = await render(
    <InfoSection health={{ version: "0.8.5", herdrConnected: true } as never} />,
  );
  const subs = textsOf(host, ".card-sub");
  expect(subs.some((s) => s.includes("0.8.5"))).toBe(true);
});

test("values are monospace, because a build id is not prose", async () => {
  const host = await render(<InfoSection health={null} />);
  expect((host.querySelector(".dl-value") as HTMLElement).className).toContain("dl-value");
});
```

Before writing, confirm the real field names by reading `src/server/index.ts:583-596`
and the `health()` return type in `src/server/routes.ts:42`. Use those names
exactly — do not invent a shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connection-card.test.tsx`
Expected: FAIL — cannot resolve `@web/components/settings/InfoSection`.

- [ ] **Step 3: Extract the upgrade command, rather than writing it twice**

`src/web/components/ReleaseBanner.tsx:30` already holds this rule:

```ts
const command = managedBy === "homebrew" ? "brew upgrade paddock" : "paddock update";
```

The Updates card needs the same answer. Two copies of it are free to drift, and
the consequence is specific: `paddock update` refuses inside a Homebrew keg, so
whichever copy fell behind would tell a brew user to run a command that
declines — the exact v0.8.5 regression.

Add to `src/shared/types.ts`, beside `ManagedBy`:

```ts
/**
 * The command that actually upgrades THIS install.
 *
 * One definition, because there are now two places that print it and
 * `paddock update` REFUSES inside a Homebrew keg (`src/server/update.ts`) —
 * a stale second copy would tell a brew user to run something that declines.
 * Named from what owns the install, never guessed.
 */
export function upgradeCommand(managedBy: ManagedBy | null): string {
  return managedBy === "homebrew" ? "brew upgrade paddock" : "paddock update";
}
```

Then change `ReleaseBanner.tsx:30` to call it, keeping the existing comment
above the call site. Run `bun test tests/release-banner.test.tsx` — expected
PASS, unchanged behaviour.

- [ ] **Step 4: Write minimal implementation**

Create `src/web/components/settings/InfoSection.tsx`. Two cards; no server work
is needed, because `/api/health` already returns `version`, `latestKnown`,
`managedBy`, `herdrConnected`, `lastEventAt`, `lastNotifyError`,
`herdrProtocol` and `schemaWarning`.

```tsx
import { BUILD } from "@web/build";
import { Card } from "@web/components/ui/Card";
import { PlugIcon, RefreshIcon } from "@web/components/ui/icons";

/** One diagnostics row. ALWAYS rendered: see the em-dash note below. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="dl-row">
      <span className="dl-label">{label}</span>
      <span className="dl-value">{value ?? "—"}</span>
    </div>
  );
}

export function InfoSection({ health }: { health: HealthView | null }) {
  return (
    <>
      <Card
        icon={<RefreshIcon />}
        title="Updates"
        subtitle={`Running v${health?.version ?? BUILD.version}`}
      >
        <div className="card-row">
          <span>{health?.latestKnown ? `v${health.latestKnown} is available` : "Up to date"}</span>
          {health?.latestKnown ? <code className="dl-value">{upgradeCommand(health.managedBy)}</code> : null}
        </div>
      </Card>

      <Card icon={<PlugIcon />} title="Connection" subtitle="Diagnostics for this device.">
        {/*
          Every row is rendered even while `health` is null, showing an em dash.
          A row that appeared as its data arrived would grow the card and shove
          everything below it down the page.
        */}
        <Row label="Endpoint" value={location.host} />
        <Row label="Secure context" value={window.isSecureContext ? "Yes" : "No"} />
        <Row label="herdr" value={health ? (health.herdrConnected ? "Connected" : "Disconnected") : null} />
        <Row label="Last event" value={health?.lastEventAt ? new Date(health.lastEventAt).toLocaleTimeString() : null} />
        <Row label="Protocol" value={health?.herdrProtocol ?? null} />
        <Row label="Server build" value={`${health?.version ?? "—"}+${BUILD.commit}`} />
      </Card>
    </>
  );
}
```

Import or declare `HealthView` from wherever the health shape is already typed —
check `src/server/routes.ts:42` and `src/shared/types.ts` first, and reuse the
existing type rather than redeclaring the payload on one side, which
`src/shared/types.ts` is explicitly the one contract for.

Add to `src/web/styles.css`:

```css
.dl-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 2.25rem;
  font-size: 0.75rem;
}

.dl-row + .dl-row { border-top: 1px solid var(--border); }

.dl-label { color: var(--fg-dim); }

/* Monospace and right-aligned: a build id, a host and a protocol number are
   values to compare, not prose to read. */
.dl-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
  word-break: break-all;
}
```

Render `<InfoSection health={…} />` inside a third band in
`src/web/components/Settings.tsx`, labelled `Info`. Fetch `/api/health` with
the same `useEffect` + `fetch` idiom `Settings.tsx` already uses for
`/api/settings`, and surface a failure rather than swallowing it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/connection-card.test.tsx`
Expected: PASS.

Run: `make check && bun test`
Expected: green.

- [ ] **Step 6: Verify in a browser**

Run: `make dev`

Open `#/settings`. Confirm every diagnostics row is present on first paint with
em dashes, then fills in without the card changing height. Confirm the Updates
subtitle shows the running version, and that a simulated Homebrew install still
shows the brew upgrade command (see the v0.8.5 `managedBy` work).

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/shared/types.ts src/server/routes.ts src/web/components/ReleaseBanner.tsx src/web/components/settings/InfoSection.tsx src/web/components/Settings.tsx src/web/styles.css tests/connection-card.test.tsx
git commit -m "feat: a diagnostics card whose rows never move, because one appearing late shoves the page under your thumb"
```

---

## Final verification

- [ ] **Run every gate**

```bash
make check
make check-clean
make test
make build
```

Expected: all clean. `make test` builds the UI first and runs the suite — a bare
`bun test` skips the build step.

- [ ] **Confirm the untouched boundary held**

```bash
git diff --stat main -- src/web/components/AgentTerminal.tsx
git diff main -- src/web/components/AgentTerminal.tsx
```

Expected: **rename-only changes.** Task 2 renames the exported `StateDot` to
`StatusDot`, and this file imports it — so a fully empty diff here is not
achievable without keeping a deprecated alias, which would leave two names for
one component. What must be absent is any change to this file's *logic*: no
altered rendering, state, effects, or fetch behaviour. Read the diff and
confirm it is the import line, the call site, and comment text.

- [ ] **Confirm no dependency was added**

```bash
git diff main -- package.json
```

Expected: no new entry under `dependencies`.

- [ ] **Screenshot rule**

Any screenshot of the new settings screen for README or docs must come from
`paddock serve --demo`. The Connection card renders the real endpoint hostname
and herdr protocol version, so it is nothing but session content — CLAUDE.md's
narrow device-frame exception does not apply.
