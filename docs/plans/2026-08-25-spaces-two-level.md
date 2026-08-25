# Spaces Two-Level Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split paddock's Spaces screen into two levels — `#/spaces` lists spaces only, `#/space/<id>` lists one space's tabs and owns rename, close and create — and correct three icons found while measuring it.

**Architecture:** UI only. Every server route this needs already exists on this
branch, so no route, store, hub or adapter is touched and §3's management
invariant holds by construction. The new screen loads the same
`GET /api/spaces` tree the list does and selects its own space from it, which
is why no per-space endpoint is added. Two new shared units carry rules that
would otherwise exist twice: `space-sort.ts` (rollup state + order, used by
both the list and the picker) and `spaceHash`/`spaceIdFromHash` in
`src/shared/route.ts`, beside `paneHash`, because that file is where hash
formats live and a format kept somewhere else is a format free to drift.

**Tech Stack:** Bun, TypeScript, React 19, `bun:test` + happy-dom, shadcn
`Sheet`, Vite. No new dependency.

**Spec:** `docs/design/2026-08-25-spaces-two-level-redesign.md` (committed
`9cfb50f`). Read it and this plan together; the spec is the authority.

## Global Constraints

- **This repository is PUBLIC.** No real hostnames, domains, tunnel ids, cloud
  org or team names, absolute home paths, usernames, machine names or email
  addresses — in code, comments, commit messages, branch names or docs.
- **Fixtures, demo data and tests use INVENTED agent names only:**
  `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`.
- **The scanner bans the literal substring `/home/`.** Fixture paths use
  `/srv/project` or `/base/operator`, matching the existing fixtures.
- **Run `make check-clean` before EVERY commit, and do NOT pipe it.** Piping
  makes the pipeline return the last command's status, which has already let a
  commit through while the scan was failing. Run it as its own command.
- **`make test`, never bare `bun test`** — the suite needs the UI built first.
- Suite is green at **1455** before this plan starts.
- **No device detection.** No `isMobile`, no user-agent parsing. Width media
  queries for layout, `(pointer: coarse)` / `(hover: hover)` for interaction.
- **Never define a colour only inside a media query.** Tokens on bare `:root`,
  redefined under `prefers-color-scheme` and `[data-theme]`.
- **No webfont.** `tests/tokens.test.ts` guards both the `@import` and any font
  file reaching `dist/`.
- **No hover-only affordances**, and no unhinted long-press — a `⋯` is visible
  and enabled at rest.
- **Never swallow errors.** No `2>/dev/null`, no unconditional `exit 0`, no
  empty catch blocks. A `catch { /* private mode */ }` around `localStorage`
  is the one sanctioned pattern already in the codebase.
- **paddock's own eight glyphs stay hand-written** in `ui/icons.tsx`. Do not
  import lucide there; `tests/ui-icons.test.tsx` asserts it.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store →
  ws/hub → web/`. Nothing in this plan may import upstream of `web/`.
- Branch: `feat/spaces-manage`. Commit per task.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/web/components/space-sort.ts` | One rule for a space's rollup state and for the order spaces are listed in. Two consumers (the list, the picker) and no third copy. |
| `src/web/components/TabRow.tsx` | One tab as a row, plus its pane sub-rows when it holds more than one. Owns the tab-level `⋯`. |
| `src/web/components/SpacePicker.tsx` | The sheet the space screen's header title opens. |
| `src/web/components/Space.tsx` | One space's screen: header, tab list, add-tab row. |

**Modified:**

| File | Change |
|---|---|
| `src/shared/route.ts` | `spaceHash`, `spaceIdFromHash` |
| `src/web/route.ts` | `useSpaceRoute` |
| `src/web/components/App.tsx` | route `#/space/<id>`; pane origin becomes a hash string |
| `src/web/components/Spaces.tsx` | becomes the list; loses collapse and the cwd/canCreate fan-out to rows |
| `src/web/components/SpaceRow.tsx` | becomes a list row: dot, label, count. Loses `⋯`, `+`, sub-rows, alias |
| `src/web/components/CreateSheet.tsx` | optional `variant` so the same sheet can present as a row |
| `src/web/components/AgentTerminal.tsx` | drop the blocked pill's `StateIcon` |
| `src/web/components/ui/icons.tsx` | `SettingsIcon` → sliders |
| `src/web/styles.css` | `.dot-none` → square; restyle; delete dead selectors |
| `tests/tokens.test.ts` | drop the `[data-expand]` exception; guard the list against rot |
| `tests/ui-icons.test.tsx` | the settings glyph is not a sun |
| `tests/spaces-screen.test.tsx` | rewritten for the list |

`RowActions.tsx` and `pane-label.ts` are **not modified** — the sheets do not
change, only where they are reached from, and §16.6's labelling rule keeps its
one home.

**Task order note:** the new screen is built and wired (Tasks 4–7) *before* the
list is stripped (Task 8), so the app never sits in a state with no route to
rename, close or create.

---

## Task 1: The rollup state and the order

`Space` carries no state of its own — the list has to derive one from its
panes, and the picker has to derive the same one. Two rank tables, because
they answer different questions: severity picks the rollup, and the sort
buckets `done` with `idle` because §5.1 asks for "blocked, then working, then
everything else, then no agent".

**Files:**
- Create: `src/web/components/space-sort.ts`
- Test: `tests/space-sort.test.ts`

**Interfaces:**
- Consumes: `Space`, `AgentState` from `@shared/types`.
- Produces:
  - `spaceState(space: Space): AgentState | null`
  - `sortSpaces(spaces: Space[]): Space[]` — a NEW array, never a mutation

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { sortSpaces, spaceState } from "@web/components/space-sort";
import type { Space } from "@shared/types";

function space(spaceId: string, states: (Space["tabs"][number]["panes"][number]["state"])[]): Space {
  const panes = states.map((state, i) => ({
    paneId: `${spaceId}:p${i}`, harness: state === null ? null : "claude",
    name: null, title: null, cwd: "/srv/project", state,
  }));
  return {
    spaceId, label: spaceId, tabCount: 1, paneCount: panes.length,
    tabs: [{ tabId: `${spaceId}:t1`, label: null, panes }],
  };
}

test("the rollup is the worst state any pane is in", () => {
  expect(spaceState(space("w1", ["idle", "blocked", "working"]))).toBe("blocked");
  expect(spaceState(space("w2", ["idle", "working"]))).toBe("working");
  expect(spaceState(space("w3", ["idle", "done"]))).toBe("done");
  expect(spaceState(space("w4", ["idle", "idle"]))).toBe("idle");
});

test("a space whose every pane is a shell has NO state, not idle", () => {
  // A shell is not idle. Inventing a state for it would sort it among spaces
  // that have an agent doing nothing, which is a different thing.
  expect(spaceState(space("w5", [null, null]))).toBeNull();
});

test("one agent among shells still decides the rollup", () => {
  expect(spaceState(space("w6", [null, "blocked", null]))).toBe("blocked");
});

test("blocked first, working next, then everything else, then no agent", () => {
  const order = sortSpaces([
    space("idle", ["idle"]),
    space("none", [null]),
    space("blocked", ["blocked"]),
    space("done", ["done"]),
    space("working", ["working"]),
  ]).map((s) => s.spaceId);
  expect(order.slice(0, 2)).toEqual(["blocked", "working"]);
  expect(order[4]).toBe("none");
  expect(order.slice(2, 4).sort()).toEqual(["done", "idle"]);
});

test("done and idle share a bucket, so herdr's own order survives between them", () => {
  // Not a detail: re-reading the tree must not reshuffle rows the operator is
  // looking at. Array.prototype.sort is stable, and these two ranking equal is
  // what makes that stability visible.
  const a = sortSpaces([space("d", ["done"]), space("i", ["idle"])]).map((s) => s.spaceId);
  const b = sortSpaces([space("i", ["idle"]), space("d", ["done"])]).map((s) => s.spaceId);
  expect(a).toEqual(["d", "i"]);
  expect(b).toEqual(["i", "d"]);
});

test("sorting does not mutate the array it was given", () => {
  const input = [space("b", ["idle"]), space("a", ["blocked"])];
  const before = input.map((s) => s.spaceId);
  sortSpaces(input);
  expect(input.map((s) => s.spaceId)).toEqual(before);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/space-sort.test.ts`
Expected: FAIL — cannot resolve `@web/components/space-sort`.

- [ ] **Step 3: Write the module**

```ts
import type { AgentState, Space } from "@shared/types";

/**
 * How bad a state is, for picking a space's rollup.
 *
 * `Space` carries no state of its own — herdr's snapshot describes panes — so
 * the list and the picker both have to derive one, and deriving it twice is
 * how two screens come to disagree about the same space.
 */
const SEVERITY: Record<AgentState, number> = {
  blocked: 0, working: 1, done: 2, idle: 3,
};

/**
 * Which bucket a space sorts into, which is NOT the same question.
 *
 * §5.1 asks for blocked, then working, then everything else, then spaces with
 * no agent. `done` and `idle` therefore rank EQUAL here while ranking
 * differently in `SEVERITY` above: the rollup has to choose between them, the
 * order does not care. Collapsing them also buys something specific — see the
 * stability note on `sortSpaces`.
 */
const BUCKET: Record<AgentState, number> = {
  blocked: 0, working: 1, done: 2, idle: 2,
};
const NO_AGENT_BUCKET = 3;

/**
 * The worst state any pane in this space is in, or null when none of them has
 * one.
 *
 * Null is not `idle` and must not become it. A space holding only shells has
 * no triage state at all — the same discipline `TreePane.state` documents, and
 * the reason `.dot-none` exists as a separate marker.
 */
export function spaceState(space: Space): AgentState | null {
  let worst: AgentState | null = null;
  for (const tab of space.tabs) {
    for (const pane of tab.panes) {
      if (pane.state === null) continue;
      if (worst === null || SEVERITY[pane.state] < SEVERITY[worst]) worst = pane.state;
    }
  }
  return worst;
}

/**
 * The spaces in the order the list and the picker both show them.
 *
 * A NEW array: the tree this reads from is React state, and sorting in place
 * would mutate it.
 *
 * `Array.prototype.sort` is stable, and `done`/`idle` sharing a bucket is what
 * makes that matter — two spaces the operator sees as equally quiet keep
 * herdr's own order between them across a re-read, so a refetch does not
 * reshuffle rows under a thumb.
 */
export function sortSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort((a, b) => bucketOf(a) - bucketOf(b));
}

function bucketOf(space: Space): number {
  const state = spaceState(space);
  return state === null ? NO_AGENT_BUCKET : BUCKET[state];
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test tests/space-sort.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the stability test can fail**

Temporarily change `BUCKET`'s `idle` from `2` to `3`. Run the suite again: the
"done and idle share a bucket" test must FAIL. Revert the change and confirm
it passes. A test that cannot fail is the one signal this codebase treats as
worthless — do not skip this step.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/space-sort.ts tests/space-sort.test.ts
git commit -m "feat: a space's rollup state, and the order two screens must agree on"
```

---

## Task 2: The `#/space/<id>` address

**Files:**
- Modify: `src/shared/route.ts` (append beside `paneHash`)
- Modify: `src/web/route.ts` (append beside `useSpacesRoute`)
- Test: `tests/spaces-route.test.ts` (append)

**Interfaces:**
- Produces:
  - `spaceHash(spaceId: string): string` — `#/space/<encoded>`
  - `spaceIdFromHash(hash: string): string | null`
  - `useSpaceRoute(): string | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/spaces-route.test.ts`:

```ts
import { spaceHash, spaceIdFromHash } from "@shared/route";

test("a space id round-trips through its hash", () => {
  // Space ids are herdr coordinates and contain no colon today, but they are
  // herdr's to change; encoding costs nothing and a raw one would break the
  // day it does.
  expect(spaceIdFromHash(spaceHash("w1"))).toBe("w1");
  expect(spaceIdFromHash(spaceHash("w1:odd/id"))).toBe("w1:odd/id");
});

test("the plural route is not the singular one", () => {
  // `#/spaces` is the LIST. If it parsed as a space id the list would render
  // a space screen for a space called "s".
  expect(spaceIdFromHash("#/spaces")).toBeNull();
  expect(spaceIdFromHash("#/space/")).toBeNull();
  expect(spaceIdFromHash("#/settings")).toBeNull();
  expect(spaceIdFromHash("")).toBeNull();
});

test("a malformed escape lands on no space rather than throwing", () => {
  // Same rule `agentIdFromHash` follows: a hand-edited or truncated URL must
  // not crash the render.
  expect(spaceIdFromHash("#/space/%")).toBeNull();
});

test("a pane hash is not a space hash, and neither reads the other", () => {
  expect(spaceIdFromHash("#/pane/w1:p1")).toBeNull();
  expect(agentIdFromHash(spaceHash("w1"))).toBeNull();
});
```

If `agentIdFromHash` is not already imported in that file, add it to the
existing `@shared/route` import rather than writing a second import line.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/spaces-route.test.ts`
Expected: FAIL — `spaceHash` is not exported.

- [ ] **Step 3: Add the format to `src/shared/route.ts`**

Append at the end of the file:

```ts
/**
 * The space URL shape, here rather than in `src/web/` for the reason the file's
 * opening note gives about `paneHash`: this is where hash formats live, and a
 * format kept somewhere else is a format free to drift from the parser.
 *
 * `#/space/<id>` singular against `#/spaces` plural — the collection and one
 * member of it. The trailing slash in the pattern is what keeps them apart, so
 * `#/spaces` can never parse as a space whose id is "s".
 */
const SPACE_HASH_RE = /^#\/space\/(.+)$/;

export function spaceHash(spaceId: string): string {
  return `#/space/${encodeURIComponent(spaceId)}`;
}

/** The space id addressed by a hash, or null for anything else. Returns null
 *  rather than throwing on a malformed escape (`#/space/%`), the same rule
 *  `agentIdFromHash` follows and for the same reason. */
export function spaceIdFromHash(hash: string): string | null {
  const encoded = SPACE_HASH_RE.exec(hash)?.[1];
  if (encoded === undefined) return null;
  try {
    const id = decodeURIComponent(encoded);
    return id === "" ? null : id;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the hook to `src/web/route.ts`**

Change the existing re-export line to carry the new names, then append the
hook:

```ts
export { agentHash, agentIdFromHash, spaceHash, spaceIdFromHash } from "@shared/route";
```

```ts
/**
 * The space this hash addresses, or null.
 *
 * Returns the ID rather than a boolean, unlike `useSpacesRoute` beside it: the
 * screen needs to know WHICH space, and a boolean plus a second read of
 * `location.hash` would be two sources for one fact.
 */
export function useSpaceRoute(): string | null {
  const [id, setId] = useState(() => spaceIdFromHash(location.hash));
  useEffect(() => {
    const onChange = () => setId(spaceIdFromHash(location.hash));
    addEventListener("hashchange", onChange);
    // Re-read on mount as well, for the reason `useAgentRoute` gives: the hash
    // can change between the initial useState and the listener attaching.
    onChange();
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return id;
}
```

Add `spaceIdFromHash` to that file's existing `import { agentIdFromHash } from "@shared/route";`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test tests/spaces-route.test.ts`
Expected: PASS.

Run: `make check`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/shared/route.ts src/web/route.ts tests/spaces-route.test.ts
git commit -m "feat: #/space/<id> addresses one space, and #/spaces still means the list"
```

---

## Task 3: Three icon corrections

Batched deliberately: three small edits of the same shape — one visual defect
with a measured cause, one guard each. A reviewer takes them as one diff.

**Files:**
- Modify: `src/web/components/ui/icons.tsx` (`SettingsIcon`, and the module's
  header comment)
- Modify: `src/web/styles.css:1846` (`.dot-none`)
- Modify: `src/web/components/AgentTerminal.tsx:5,398`
- Test: `tests/ui-icons.test.tsx` (append), `tests/tokens.test.ts` (append),
  `tests/terminal-render.test.tsx` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. `SettingsIcon`'s signature is
  unchanged — same name, same `IconProps`.

- [ ] **Step 1: Write the three failing tests**

Append to `tests/ui-icons.test.tsx`:

```ts
test("the settings glyph is a gear or a slider, never a sun", async () => {
  // It drew a circle at the centre with six DETACHED ticks around it and no
  // outer rim, which is the standard brightness glyph — a gear's teeth are
  // teeth OF a rim, and without one they are ticks. A circle centred at 12,12
  // is what both the sun and the abandoned gear have in common, so its absence
  // is the discriminator.
  const host = await render(<icons.SettingsIcon />);
  const svg = host.querySelector("svg")!;
  expect(svg.querySelectorAll('circle[cx="12"][cy="12"]').length).toBe(0);
  await unmount();
});
```

Append to `tests/tokens.test.ts`:

```ts
test("the no-state marker is a complete shape, not a dashed circle", async () => {
  // A 7px circle with a 1.5px border has a ~17px border centreline, and a
  // dashed border sets dash and gap at roughly twice the border width — so
  // ~2.9 periods have to close a ring whose four sides are each stroked with
  // an independent dash phase. It rendered as four unequal arcs: an incomplete
  // circle. Shape is the channel that survives at this size, not border-style.
  const css = await Bun.file("src/web/styles.css").text();
  const rule = rules(css).find((r) => r.sel === ".dot-none");
  expect(rule).toBeDefined();
  expect(rule!.body).toContain("border-style: solid");
  expect(rule!.body).not.toContain("dashed");
  // A square, so it cannot be mistaken for `idle`'s hollow ring.
  expect(rule!.body).not.toContain("9999px");
});
```

Append to `tests/terminal-render.test.tsx`:

```ts
test("the blocked pill says its word without an illegible glyph", async () => {
  // lucide scales stroke with size, so at size=11 the stroke was 0.92px, the
  // circle 9.2px, and the "!" inside it a 1.8px bar over a sub-pixel dot. It
  // was also redundant: only `blocked` ever renders this pill, so there is no
  // green pill to confuse it with and the pill itself is the shape channel.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  const pill = host.querySelector(".term-title .term-state")!;
  expect(pill.textContent).toContain("blocked");
  expect(pill.querySelector("svg")).toBeNull();
});
```

That mount is this suite’s own shape, taken from the existing test in
`tests/terminal-render.test.tsx` that already asserts on `.term-state`:
`stubFetch` over `/output` and `/prompt`, `screenOf(...)`, **no `load` prop**,
then `await settle()`. `stubFetch`, `screenOf`, `settle` and `agent` are all
already imported in that file — reuse them, do not add a second helper.
call shape, and reuse that file's existing imports and fixtures.

- [ ] **Step 2: Run the three and confirm each fails**

```bash
bun test tests/ui-icons.test.tsx tests/tokens.test.ts tests/terminal-render.test.tsx
```

Expected: exactly three failures — a centred circle found, `dashed` found, an
`svg` found inside the pill. If any of the three passes already, stop and say
so: it means the assertion is not testing what it claims.

- [ ] **Step 3: Replace `SettingsIcon`**

In `src/web/components/ui/icons.tsx`, replace the whole `SettingsIcon`
function and its doc comment with:

```tsx
/**
 * The Settings entry point in the host header.
 *
 * Drawn, for the reason `SpacesIcon` above is drawn, and grouped with it by
 * §16.5 — two controls in the same cluster must not look like two systems.
 *
 * This was a gear, and it was not one: a circle at the centre with six
 * DETACHED ticks in the annulus and no outer rim, which is the standard
 * brightness glyph. The comment it replaced records how that happened — it
 * worried that more teeth would close the gaps into a ring, and removed the
 * rim to keep them distinct. That fixed the density and left the metaphor
 * behind.
 *
 * Sliders rather than restoring the rim, because the header renders at 18px:
 * a gear at that size has a 3.9px annulus holding 1.1px teeth, and rendered it
 * collapses into a blob. These two tracks have no detail inside a ring at all,
 * and their smallest feature is a 3.2px knob.
 */
export function SettingsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.1" />
      <circle cx="10" cy="17" r="2.1" />
    </Svg>
  );
}
```

The module's header comment says "Ten hand-written glyphs". The count is
unchanged — one glyph replaced, none added — so leave that number alone.

- [ ] **Step 4: Replace `.dot-none` in `src/web/styles.css`**

```css
/* A shell has no triage state at all — it is not `idle`, which is why it gets
   no `StatusDot`. Same 7px footprint as `.dot`, because hollowing a marker
   must not also move it.

   A SQUARE, not a dashed ring. Dashed was the first attempt at "not idle" and
   it does not survive this size: the border centreline is ~17px round, a
   dashed border sets dash and gap at roughly twice the 1.5px border width, so
   ~2.9 periods have to close a circle whose four sides are stroked with
   independent dash phases. It rendered as four unequal arcs — an incomplete
   circle, which is how an operator reported it. Shape is the channel that
   survives what a border-style does not, which is what `StateIcon`'s own
   comment already says. */
.dot-none {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  box-sizing: border-box;
  border-radius: 1.5px;
  border-width: 1.5px;
  border-style: solid;
  border-color: var(--fg-dim);
  background: var(--bg);
}
```

- [ ] **Step 5: Drop the pill's glyph in `src/web/components/AgentTerminal.tsx`**

At line 398, delete the `<StateIcon state="blocked" size={11} />` line. Delete
the now-unused `import { StateIcon } from "@web/components/ui/StateIcon";` at
line 5 — it is the file's only use, so leaving it is an unused import `make
check` will not necessarily flag.

In the comment block above that JSX, replace the sentence beginning "Colour
alone is not a channel" through the end of that paragraph with:

```
              Colour alone is not a channel a sighted colour-blind operator can
              read, and the palette pairs red with green. This pill answers that
              by its own shape: a tinted, bordered, uppercase pill against the
              bare dot every other state gets, plus the word itself. It carried
              a lucide `CircleAlert` at size 11 as a third channel, which at
              that size is 0.92px of stroke around a 9.2px circle holding a
              1.8px bar — and redundant besides, since `blocked` is the only
              state that ever renders this pill, so there is no green one here
              to confuse it with. `StateIcon` is untouched and still renders at
              its legible 13px default on `AgentCard`.
```

- [ ] **Step 6: Run the three tests and confirm they pass**

```bash
bun test tests/ui-icons.test.tsx tests/tokens.test.ts tests/terminal-render.test.tsx
```

Expected: PASS, and no other test in those three files regresses.

- [ ] **Step 7: Run the whole suite**

Run: `make test`
Expected: **exactly 3 more passing than the branch head you started from, and
0 fail.** Do not expect an absolute number: Tasks 1 and 2 run before this one
and add 10 tests between them, so the baseline is whatever `git stash`-free
`make test` reported before your edits — record that number first, then compare.
(The branch was at 1455 when the plan was written, so the figure you should see
here is 1468.) Any other failure is a real
regression from one of these three edits — do not adjust the failing test to
match; find what the edit broke.

- [ ] **Step 8: Commit**

```bash
make check-clean
git add src/web/components/ui/icons.tsx src/web/styles.css src/web/components/AgentTerminal.tsx tests/ui-icons.test.tsx tests/tokens.test.ts tests/terminal-render.test.tsx
git commit -m "fix: a sun where a gear was meant, a broken ring, and a 0.92px stroke"
```

---

## Task 4: `TabRow` — one tab, and its panes only when there are several

**Files:**
- Create: `src/web/components/TabRow.tsx`
- Test: `tests/tab-row.test.tsx`

**Interfaces:**
- Consumes: `Tab`, `TreePane` from `@shared/types`; `paneHash` from
  `@shared/route`; `paneLabel` from `@web/components/pane-label`;
  `RowActions`, `RenameTarget`, `RowSenders` from
  `@web/components/RowActions`; `StatusDot` from
  `@web/components/ui/StatusDot`.
- Produces:
  ```ts
  export function TabRow(props: {
    tab: Tab;
    onChanged: () => void;
    senders?: RowSenders;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { render, textsOf, unmount } from "./support/render";
import { TabRow } from "@web/components/TabRow";
import type { Tab } from "@shared/types";

afterEach(async () => { await unmount(); });

const pane = (paneId: string, over: Partial<Tab["panes"][number]> = {}): Tab["panes"][number] => ({
  paneId, harness: "claude", name: "api-refactor", title: "t",
  cwd: "/srv/project", state: "working", ...over,
});

const SINGLE: Tab = { tabId: "w1:t1", label: "migrate-up", panes: [pane("w1:p1")] };

const SPLIT: Tab = {
  tabId: "w2:t1", label: "backfill",
  panes: [pane("w2:p1"), pane("w2:p2", { paneId: "w2:p2", harness: null, name: null, title: "bash", cwd: "/srv/project/logs", state: null })],
};

test("a tab holding one pane IS that pane — the row opens it directly", async () => {
  // The whole reason a drill-down is affordable on a flat herd: every tab on
  // the machine this was measured against holds one pane, so every tab row is
  // one tap from an agent. If this regresses, the second level costs a tap and
  // buys nothing.
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  const row = host.querySelector("[data-tab-row]")!;
  expect(row.querySelector("a")?.getAttribute("href")).toBe("#/pane/w1%3Ap1");
  expect(host.querySelectorAll("[data-pane-row]").length).toBe(0);
});

test("a tab holding several panes shows them, and still opens its root pane", async () => {
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  expect(host.querySelector("[data-tab-row] > a")?.getAttribute("href")).toBe("#/pane/w2%3Ap1");
  const subs = [...host.querySelectorAll("[data-pane-row] a")].map((a) => a.getAttribute("href"));
  expect(subs).toEqual(["#/pane/w2%3Ap1", "#/pane/w2%3Ap2"]);
});

test("a pane with no agent is shown, marked, and never given a state it lacks", async () => {
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  const shell = host.querySelector('[data-pane-row][data-state="none"]')!;
  expect(shell).not.toBeNull();
  expect(shell.querySelector(".dot-none")).not.toBeNull();
  expect(shell.textContent).toContain("no agent");
  expect(shell.textContent).not.toContain("idle");
});

test("a shell is labelled by its folder, never by its prompt", async () => {
  // §16.6. `title` on that fixture is "bash" and its cwd's last segment is
  // "logs" — so the label proves which field was read.
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  expect(textsOf(host, ".pane-name")).toContain("logs");
});

test("an unnamed tab is labelled by its number, not left blank", async () => {
  // herdr returns a tab's NUMBER as a string when it has no label, so null
  // here means the operator never named it. The row still has to say
  // something, and the tabId is a herdr coordinate — correct and useless.
  const host = await render(
    <TabRow tab={{ tabId: "w3:t2", label: null, panes: [pane("w3:p1")] }} onChanged={() => {}} />,
  );
  expect(textsOf(host, "[data-tab-row] .tab-name")).toEqual(["api-refactor"]);
});

test("the tab's actions are reachable at rest, and announce the row's visible label", async () => {
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  const dots = [...host.querySelectorAll("[data-tab-row] button[aria-label]")]
    .filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("Actions"));
  expect(dots.length).toBe(1);
  expect(dots[0]!.hasAttribute("disabled")).toBe(false);
  expect(dots[0]!.getAttribute("aria-label")).toContain("migrate-up");
});

test("the ⋯ is a sibling of the link, never inside it", async () => {
  // A <button> inside an <a> is invalid HTML and unreachable by keyboard —
  // the trap RowActions and SpaceRow both carry notes about.
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  expect(host.querySelector("a button")).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/tab-row.test.tsx`
Expected: FAIL — cannot resolve `@web/components/TabRow`.

- [ ] **Step 3: Write the component**

```tsx
import { paneHash } from "@shared/route";
import type { Tab, TreePane } from "@shared/types";
import { paneLabel } from "@web/components/pane-label";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * One tab as a row, with its panes under it only when it holds more than one.
 *
 * This is the merged-row principle the superseded §6 applied at SPACE level,
 * moved down one. It is what keeps a drill-down affordable on a flat herd:
 * every tab on the machine this was measured against holds exactly one pane,
 * so every tab row is one tap from an agent and no level is spent rendering a
 * single child. Structure appears only where the operator built some.
 *
 * There is no third level. A pane has no children, so a split tab's sub-rows
 * are the end of the tree.
 */
export function TabRow({ tab, onChanged, senders }: {
  tab: Tab;
  /** Re-read the tree. Called after every write, win or lose — §11's no
   *  optimistic updates rule. */
  onChanged: () => void;
  senders?: RowSenders;
}) {
  const split = tab.panes.length > 1;
  // The tab's root pane. A tab with no panes at all is not a shape herdr
  // produces, but reading `[0]` on an empty array would be `undefined` handed
  // to `paneHash` — so the row degrades to a non-link rather than linking to
  // `#/pane/undefined`, the same defect `CreateSheet` guards its navigate on.
  const root: TreePane | null = tab.panes[0] ?? null;

  /**
   * What the row is called.
   *
   * The tab's own label when it has one. When it does not — herdr returns a
   * tab's NUMBER as a string, so null means genuinely unnamed — the ROOT
   * PANE's label stands in, because `tab.tabId` is a herdr coordinate and
   * `docs/gotchas.md` records what those are worth on screen: `w3:t2` is
   * correct and useless.
   */
  const tabName = tab.label ?? (root ? paneLabel(root) : tab.tabId);

  const renames: RenameTarget[] = [
    ...(root !== null && root.harness !== null
      ? [{ kind: "agent", id: root.paneId, current: root.name } as RenameTarget]
      : []),
    { kind: "tab", id: tab.tabId, current: tab.label },
  ];

  return (
    <li data-tab-row data-tab-id={tab.tabId}>
      <div className="tab-head">
        {/* Whatever sits beside this anchor stays a SIBLING of it, never a
            child: a <button> inside an <a> is invalid HTML and unreachable by
            keyboard. */}
        {root !== null ? (
          <a href={paneHash(root.paneId)}>
            {!split && <StateMarker state={root.state} />}
            <span className="tab-heading">
              <span className="tab-name">{tabName}</span>
            </span>
            {split
              ? <span className="tab-count">{tab.panes.length} panes</span>
              : <PaneState pane={root} />}
          </a>
        ) : (
          <span className="tab-heading"><span className="tab-name">{tabName}</span></span>
        )}
        <RowActions
          label={tabName}
          renames={renames}
          // Closing a tab takes its panes with it, which is what the
          // consequence line has to say — counted off the tree already on
          // screen (§10), never fetched.
          close={{ kind: "tab", id: tab.tabId, panes: tab.panes }}
          onChanged={onChanged}
          senders={senders}
        />
      </div>

      {split && (
        <ul className="tab-panes">
          {tab.panes.map((p) => (
            <li key={p.paneId} data-pane-row data-state={p.state ?? "none"}>
              <a href={paneHash(p.paneId)}>
                <StateMarker state={p.state} />
                <span className="pane-heading">
                  <span className="pane-name">{paneLabel(p)}</span>
                </span>
                <PaneState pane={p} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Colour is never the only channel — the marker is `aria-hidden`, so the state
 * has to be readable as text right here.
 *
 * The MARKER is not defined in this file: `ui/StateMarker.tsx` owns the rule
 * that a null state gets `.dot-none` rather than a `StatusDot`, because this
 * surface, the space rows and the space picker all need it. Only the class name
 * below is this surface's own, which is why this much stays local.
 */
function PaneState({ pane }: { pane: TreePane }) {
  return <span className="pane-state">{pane.state ?? NO_AGENT}</span>;
}
```

A split tab's own row shows a pane COUNT rather than a rollup state, and no
marker: its panes each carry their own below, and a rollup here would say the
same thing twice — the rule `SpaceRow` already states for structured spaces.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/tab-row.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the merged-row test can fail**

Temporarily change `const split = tab.panes.length > 1;` to `const split =
true;`. The "a tab holding one pane IS that pane" test must FAIL. Revert.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/TabRow.tsx tests/tab-row.test.tsx
git commit -m "feat: a tab holding one pane is that pane, so a flat herd pays no tax"
```

---

## Task 5: `SpacePicker` — the sheet the header title opens

**Files:**
- Create: `src/web/components/SpacePicker.tsx`
- Test: `tests/space-picker.test.tsx`

**Interfaces:**
- Consumes: `Space` from `@shared/types`; `sortSpaces`, `spaceState` from
  `@web/components/space-sort` (Task 1); `spaceHash` from `@shared/route`
  (Task 2); `StatusDot`, shadcn `Sheet`.
- Produces:
  ```ts
  export function SpacePicker(props: {
    spaces: Space[];
    currentId: string;
    navigate?: (hash: string) => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, textsOf, unmount } from "./support/render";
import { SpacePicker } from "@web/components/SpacePicker";
import type { Space } from "@shared/types";

afterEach(async () => { await unmount(); });

const space = (spaceId: string, label: string | null, state: "blocked" | "idle" | null): Space => ({
  spaceId, label, tabCount: 1, paneCount: 1,
  tabs: [{ tabId: `${spaceId}:t1`, label: null, panes: [{
    paneId: `${spaceId}:p1`, harness: state === null ? null : "claude",
    name: null, title: "t", cwd: "/srv/project", state,
  }] }],
});

const SPACES = [
  space("w1", "docs-cleanup", "idle"),
  space("w2", "schema-migration", "idle"),
  space("w3", "flaky-test-fix", "blocked"),
  space("w4", null, null),
];

test("the trigger is the space's own name, and it is a control", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  const trigger = host.querySelector("[data-space-picker]")!;
  expect(trigger.tagName).toBe("BUTTON");
  expect(trigger.textContent).toContain("schema-migration");
});

test("opening it lists every space, blocked first", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  await click(host.querySelector("[data-space-picker]"));
  const names = textsOf(document.body as HTMLElement, "[data-picker-row] .space-name");
  expect(names.length).toBe(4);
  expect(names[0]).toBe("flaky-test-fix");
  // A space with no agent sorts last, and an unnamed one still says something:
  // its id, because a blank row is not a row.
  expect(names[3]).toBe("w4");
});

test("the space you are in is marked, and the others are not", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  await click(host.querySelector("[data-space-picker]"));
  const here = [...document.querySelectorAll("[data-picker-row]")]
    .filter((r) => r.getAttribute("aria-current") === "true");
  expect(here.length).toBe(1);
  expect(here[0]!.textContent).toContain("schema-migration");
});

test("choosing a space navigates to it", async () => {
  const seen: string[] = [];
  const host = await render(
    <SpacePicker spaces={SPACES} currentId="w2" navigate={(h) => seen.push(h)} />,
  );
  await click(host.querySelector("[data-space-picker]"));
  const row = [...document.querySelectorAll("[data-picker-row]")]
    .find((r) => r.textContent?.includes("flaky-test-fix"))!;
  await click(row);
  expect(seen).toEqual(["#/space/w3"]);
});

test("choosing the space you are already in still closes, and does not re-navigate", async () => {
  const seen: string[] = [];
  const host = await render(
    <SpacePicker spaces={SPACES} currentId="w2" navigate={(h) => seen.push(h)} />,
  );
  await click(host.querySelector("[data-space-picker]"));
  const row = [...document.querySelectorAll("[data-picker-row]")]
    .find((r) => r.getAttribute("aria-current") === "true")!;
  await click(row);
  expect(seen).toEqual([]);
  expect(document.querySelector("[data-picker-row]")).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test tests/space-picker.test.tsx`
Expected: FAIL — cannot resolve `@web/components/SpacePicker`.

- [ ] **Step 3: Write the component**

Read `src/web/components/RowActions.tsx`'s `Sheet` usage first and follow it
exactly — the same `side="bottom"`, the same `showCloseButton={false}`, the
same `row-actions-sheet` base class. Getting a bottom sheet's focus trap and
scroll lock right is the reason `CLAUDE.md` sanctions shadcn here, and a
second hand-rolled variant would not inherit any of it.

```tsx
import { useState } from "react";
import { spaceHash } from "@shared/route";
import type { Space } from "@shared/types";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@web/components/shadcn/sheet";
import { sortSpaces, spaceState } from "@web/components/space-sort";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * Switching space, from the space screen's own header title.
 *
 * Not Collie's chip rail, and the reason is a measurement rather than a
 * preference: at 390px a chip carrying a dot and a label runs about 110px, so
 * three of the eleven spaces measured on the development machine would be
 * visible and eight would sit behind a sideways scroll with nothing saying they
 * exist — and the rail costs about 48px of height permanently. A sheet shows
 * all eleven, and would show forty.
 *
 * The title is the trigger because the title is what names the thing being
 * switched. It is a real `<button>`, not a tappable heading: an affordance an
 * operator has to guess at is the same defect as a hover-only one.
 */
export function SpacePicker({ spaces, currentId, navigate = (hash) => { location.hash = hash; } }: {
  spaces: Space[];
  currentId: string;
  /** Injected so a test can observe the navigation instead of mutating the
   *  document's hash — the same reason `CreateSheet` takes it. */
  navigate?: (hash: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = spaces.find((s) => s.spaceId === currentId) ?? null;
  // Falls back to the id so the header says something. A space can be unnamed;
  // a header cannot be blank.
  const currentLabel = current?.label ?? currentId;

  const choose = (space: Space) => {
    setOpen(false);
    // No navigation to where you already are. It would push an identical hash,
    // which fires no `hashchange` and so leaves the sheet's close as the only
    // visible effect — a control that appears to do nothing.
    if (space.spaceId === currentId) return;
    navigate(spaceHash(space.spaceId));
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger data-space-picker className="space-picker-btn">
        <span className="space-picker-name">{currentLabel}</span>
        {/* The chevron says this is a control. `aria-hidden` because the
            button's own text already names it. */}
        <span aria-hidden="true" className="space-picker-caret">▾</span>
      </SheetTrigger>
      <SheetContent side="bottom" className="row-actions-sheet space-picker-sheet" showCloseButton={false}>
        <SheetHeader className="row-actions-head">
          <SheetTitle className="row-actions-title">Switch space</SheetTitle>
          <SheetDescription className="row-actions-scope">
            Every space in this herdr session.
          </SheetDescription>
        </SheetHeader>
        <ul className="space-picker-list">
          {sortSpaces(spaces).map((s) => {
            const state = spaceState(s);
            const here = s.spaceId === currentId;
            return (
              <li key={s.spaceId}>
                <button
                  type="button"
                  data-picker-row
                  // `aria-current`, not a visual tick alone: the marking has to
                  // reach a screen reader too.
                  aria-current={here ? "true" : undefined}
                  onClick={() => choose(s)}
                >
                  {/* `StateMarker`, not a local null-check: the rule that a
                      null state gets `.dot-none` rather than a `StatusDot`
                      lives in one place now (`ui/StateMarker.tsx`), because
                      this picker, the space rows and the tab rows all need it
                      and three copies would be three things free to drift. */}
                  <StateMarker state={state} surfaceVar="--surface" />
                  <span className="space-name">{s.label ?? s.spaceId}</span>
                  {/* Colour is never the only channel: StatusDot is
                      aria-hidden, so the state is said in words here. */}
                  <span className="space-state">{state ?? NO_AGENT}</span>
                  <span className="space-count">{s.paneCount}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
```

`surfaceVar="--surface"` on the dot is not cosmetic: a ring dot fills its
interior with the named variable, and a sheet's ground is `--surface`, not
`--bg`. Left at the default, a hollow ring on the sheet reads as a notch cut
out of it — the case `StatusDot`'s own comment documents.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/space-picker.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the no-self-navigate test can fail**

Temporarily delete the `if (space.spaceId === currentId) return;` line. The
"choosing the space you are already in" test must FAIL. Revert.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/SpacePicker.tsx tests/space-picker.test.tsx
git commit -m "feat: switch space from the title, because eight of eleven chips would be off-screen"
```

---

## Task 6: `Space` — the screen, and the add-tab row

**Files:**
- Create: `src/web/components/Space.tsx`
- Modify: `src/web/components/CreateSheet.tsx` (add an optional `variant`)
- Test: `tests/space-screen.test.tsx`, `tests/create-sheet.test.tsx` (append
  one case)

**Interfaces:**
- Consumes: `TabRow` (Task 4), `SpacePicker` (Task 5), `fetchSpaceTree` from
  `@web/api`, `CreateSheet`/`CreateSenders`, `RowActions`/`RowSenders`,
  `useStore`.
- Produces:
  ```ts
  export function Space(props: {
    spaceId: string;
    onBack: () => void;
    load?: () => Promise<SpaceTree>;
    senders?: RowSenders;
    createSenders?: CreateSenders;
    navigate?: (hash: string) => void;
  }): JSX.Element
  ```
  And on `CreateSheet`, a new optional prop:
  ```ts
  variant?: "glyph" | "row";   // default "glyph" — existing call sites unchanged
  ```

- [ ] **Step 1: Add the `variant` prop to `CreateSheet`**

In `src/web/components/CreateSheet.tsx`, add to the props type:

```ts
  /**
   * How the trigger presents itself.
   *
   * `glyph` (the default) is the bare `+` §16.7 puts in a header, where
   * POSITION carries the scope and no text label is needed. `row` is the same
   * sheet presented as the last row of the list it adds to — on the space
   * screen there is no header position that says "a tab in this space", so the
   * control says it in words instead.
   *
   * Existing call sites are untouched by construction: the default is what
   * they already render.
   */
  variant?: "glyph" | "row";
```

Destructure it with `variant = "glyph"`, and replace the `SheetTrigger` with:

```tsx
      <SheetTrigger
        data-create={what}
        className={variant === "row" ? "create-row" : "create-btn"}
        // Position carries the scope when this is a glyph in a header; an
        // accessible name cannot rely on position, so it says the scope in
        // words either way.
        aria-label={isSpace ? "New space" : `New tab in ${where}`}
      >
        {variant === "row"
          ? <><span aria-hidden="true">+</span> New tab</>
          : <span aria-hidden="true">+</span>}
      </SheetTrigger>
```

Append to `tests/create-sheet.test.tsx`, reusing that file's existing render
helper and target fixtures:

```tsx
test("the row variant says in words what a header's position says silently", async () => {
  const host = await render(
    <CreateSheet
      variant="row"
      target={{ kind: "tab", spaceId: "w1", spaceLabel: "api-refactor", spaceCwd: "/srv/project" }}
      cwds={[]}
      onChanged={() => {}}
      senders={SENDERS}
    />,
  );
  const trigger = host.querySelector("[data-create]")!;
  expect(trigger.className).toContain("create-row");
  expect(trigger.textContent).toContain("New tab");
  // The accessible name still carries the scope, exactly as the glyph's does.
  expect(trigger.getAttribute("aria-label")).toBe("New tab in api-refactor");
});
```

`SENDERS` above must be whatever that file already uses for injected create
senders — reuse it rather than defining a second one.

- [ ] **Step 2: Write the failing screen test**

```tsx
import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, textsOf, unmount } from "./support/render";
import { Space } from "@web/components/Space";
import type { SpaceTree } from "@shared/types";

afterEach(async () => { await unmount(); });

const TREE: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [
    {
      spaceId: "w1", label: "schema-migration", tabCount: 2, paneCount: 3,
      tabs: [
        { tabId: "w1:t1", label: "migrate-up", panes: [
          { paneId: "w1:p1", harness: "codex", name: "schema-migration", title: "t", cwd: "/srv/project", state: "working" },
        ] },
        { tabId: "w1:t2", label: "backfill", panes: [
          { paneId: "w1:p2", harness: "claude", name: "schema-migration-2", title: "t", cwd: "/srv/project", state: "idle" },
          { paneId: "w1:p3", harness: null, name: null, title: "bash", cwd: "/srv/project/logs", state: null },
        ] },
      ],
    },
    {
      spaceId: "w2", label: "docs-cleanup", tabCount: 1, paneCount: 1,
      tabs: [{ tabId: "w2:t1", label: null, panes: [
        { paneId: "w2:p1", harness: "claude", name: "docs-cleanup", title: "t", cwd: "/srv/project", state: "blocked" },
      ] }],
    },
  ],
};

const load = (t: SpaceTree) => async () => t;

test("the screen lists the space's TABS, one row each", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  expect(host.querySelectorAll("[data-tab-row]").length).toBe(2);
  expect(textsOf(host, "[data-tab-row] .tab-name")).toEqual(["migrate-up", "backfill"]);
});

test("the header names the space and is the picker's trigger", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  const trigger = host.querySelector("[data-space-picker]")!;
  expect(trigger.textContent).toContain("schema-migration");
});

test("add-tab is the last row of the list it adds to, not a floating button", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  const rows = [...host.querySelectorAll("[data-tab-row], [data-create]")];
  expect(rows.at(-1)!.getAttribute("data-create")).toBe("tab");
  expect(rows.at(-1)!.textContent).toContain("New tab");
});

test("the space's own actions are in the header, and the tabs' are on their rows", async () => {
  const host = await render(<Space spaceId="w1" onBack={() => {}} load={load(TREE)} />);
  // One ⋯ in the header for the space, one per tab row. Never the same control
  // in the same place meaning two different scopes.
  expect(host.querySelectorAll(".space-screen-head [aria-label^='Actions']").length).toBe(1);
  expect(host.querySelectorAll("[data-tab-row] [aria-label^='Actions']").length).toBe(2);
});

test("a space id that addresses nothing says so, and never renders an empty list", async () => {
  // An empty tab list is indistinguishable from a real space that has none —
  // the same "an empty screen and a broken herdr must never look alike" rule
  // the failed-read branch follows.
  const host = await render(<Space spaceId="w9" onBack={() => {}} load={load(TREE)} />);
  expect(host.querySelectorAll("[data-tab-row]").length).toBe(0);
  expect(host.textContent).toContain("gone");
  expect(host.querySelector("a[href='#/spaces']")).not.toBeNull();
});

test("a failed read is surfaced, never rendered as a space with no tabs", async () => {
  const host = await render(
    <Space spaceId="w1" onBack={() => {}} load={async () => { throw new Error("herdr socket refused"); }} />,
  );
  expect(host.querySelector("[role='alert']")?.textContent).toContain("herdr socket refused");
  expect(host.textContent).not.toContain("gone");
});

test("back leaves for the list", async () => {
  let backs = 0;
  const host = await render(<Space spaceId="w1" onBack={() => { backs += 1; }} load={load(TREE)} />);
  await click(host.querySelector(".space-screen-head .term-back"));
  expect(backs).toBe(1);
});
```

- [ ] **Step 3: Run both test files and confirm they fail**

Run: `bun test tests/space-screen.test.tsx tests/create-sheet.test.tsx`
Expected: the space-screen file fails to resolve `@web/components/Space`; the
create-sheet file fails only on the new `variant` case.

- [ ] **Step 4: Write the screen**

```tsx
import { useCallback, useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { SpacePicker } from "@web/components/SpacePicker";
import { TabRow } from "@web/components/TabRow";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

/**
 * One space: its tabs, and the controls that act on them.
 *
 * This is the level the superseded §6 argued against, on a measurement that
 * counted children per space. What it did not count was controls per row —
 * eleven spaces each carrying a link, a `⋯` and a `+` put 33 tap targets on
 * one viewport while fitting every row without a scroll. This screen is where
 * those controls belong: you have already chosen what you are managing.
 *
 * It reads the SAME `GET /api/spaces` tree the list does and selects its own
 * space out of it. No per-space endpoint, because the tree is one call and
 * this screen also needs every other space for its picker.
 */
export function Space({
  spaceId, onBack, load = fetchSpaceTree, senders, createSenders, navigate,
}: {
  spaceId: string;
  /** Leaves for the list. There is only one route into this screen, so this
   *  takes no target — see `App.tsx`. */
  onBack: () => void;
  /** Injected for the same reason `Spaces` injects it: a test drives this
   *  without a network, and a failure is a value this renders rather than a
   *  thrown promise. */
  load?: () => Promise<SpaceTree>;
  senders?: RowSenders;
  createSenders?: CreateSenders;
  navigate?: (hash: string) => void;
}) {
  const { treeStaleAt, spacesAvailable } = useStore();
  const [tree, setTree] = useState<SpaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTree(await load());
      setError(null);
    } catch (err) {
      // The last good tree is KEPT. An empty screen and a broken herdr must
      // never look alike.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  // Refetches on mount and whenever the server says the tree MOVED. The server
  // sends `tree-stale` for structure only, so this does not fire on every
  // agent state change.
  useEffect(() => { void refresh(); }, [refresh, treeStaleAt]);

  const space = tree?.spaces.find((s) => s.spaceId === spaceId) ?? null;

  // Every cwd in the WHOLE tree, for the create sheet's quick picks (§9.3) —
  // not just this space's. A new tab commonly goes where another space already
  // is.
  const cwds = tree === null
    ? []
    : [...new Set(tree.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.cwd))))].sort();

  // The same capability the entry point is gated on, never a demo flag and
  // never a device check: with no herdr session the create routes 404 honestly,
  // so a `+` would be a control that always errors.
  const canCreate = spacesAvailable;

  /*
   * Built once and rendered from every branch below — the same rule `SpaceRow`
   * applies to its own heading, and for the same reason: this header is
   * identical in all four states, and four copies of it would be four things
   * free to drift. There is only one route into this screen, so its back
   * control takes no target.
   */
  const bare = (children: React.ReactNode) => (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="space-screen-head">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to spaces">
          ‹ Spaces
        </button>
      </header>
      {children}
    </main>
  );

  // The read failed and nothing is held from a previous one. Said, never
  // rendered as a space that happens to have no tabs.
  if (error !== null && tree === null) {
    return bare(<p className="error" role="alert">{error}</p>);
  }

  // Tree read, no such space. Said explicitly rather than rendered as a space
  // with no tabs, which is indistinguishable from a real one that has none.
  if (tree !== null && space === null) {
    return bare(
      <>
        <p className="empty">That space is gone.</p>
        <p><a href="#/spaces">All spaces</a></p>
      </>,
    );
  }

  // Still loading: no tree yet, and no error to show.
  if (tree === null || space === null) return bare(null);

  const spaceRenames: RenameTarget[] = [
    { kind: "space", id: space.spaceId, current: space.label },
  ];
  const panes = space.tabs.flatMap((t) => t.panes);

  return (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="space-screen-head">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to spaces">
          ‹ Spaces
        </button>
        <SpacePicker spaces={tree.spaces} currentId={space.spaceId} navigate={navigate} />
        {/* The SPACE's actions. Its position — in the header, beside the
            space's own name — is what separates it from the `⋯` on each tab
            row below. */}
        <RowActions
          label={space.label ?? space.spaceId}
          renames={spaceRenames}
          close={{ kind: "space", id: space.spaceId, panes }}
          onChanged={() => void refresh()}
          senders={senders}
        />
      </header>

      {error !== null && <p className="error" role="alert">{error}</p>}

      <ul className="tabs">
        {space.tabs.map((t) => (
          <TabRow
            key={t.tabId}
            tab={t}
            // Every write refetches, win or lose (§11) — no optimistic update,
            // because this screen's value is being accurate about someone
            // else's state.
            onChanged={() => void refresh()}
            senders={senders}
          />
        ))}
        {canCreate && (
          <li className="tab-create">
            <CreateSheet
              variant="row"
              target={{
                kind: "tab",
                spaceId: space.spaceId,
                // `space.label`, NOT the id fallback: handing the fallback on
                // made a herdr COORDINATE an agent's suggested name.
                spaceLabel: space.label,
                // The space's cwd is its FIRST pane's. Null asks herdr for its
                // default rather than guessing a path.
                spaceCwd: panes[0]?.cwd ?? null,
              }}
              cwds={cwds}
              onChanged={() => void refresh()}
              senders={createSenders}
              navigate={navigate}
            />
          </li>
        )}
      </ul>
    </main>
  );
}
```

- [ ] **Step 5: Run both test files and confirm they pass**

Run: `bun test tests/space-screen.test.tsx tests/create-sheet.test.tsx`
Expected: PASS. The create-sheet file's pre-existing tests must all still pass
unmodified — `variant` defaults to what they already render, so any failure
there means the default was not preserved.

- [ ] **Step 6: Prove the gone-state test can fail**

Temporarily change the gone branch to render the normal screen with
`space!.tabs`. The "a space id that addresses nothing" test must FAIL (and
likely throw). Revert.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/components/Space.tsx src/web/components/CreateSheet.tsx tests/space-screen.test.tsx tests/create-sheet.test.tsx
git commit -m "feat: the screen where you manage the space you already chose"
```

---

## Task 7: Wire the route, and make the back chain carry a hash

The pane origin is a boolean today — `fromSpaces` — and a boolean cannot say
WHICH space. Keeping it and adding a second field for the id would let the two
disagree; one field cannot.

**Files:**
- Modify: `src/web/components/App.tsx` (the `paneOriginRef` declaration, its
  `hashchange` handler, `backTargetFor`, and the render branches)
- Test: `tests/back-navigation.test.tsx` (append — this file already mounts
  `<App />` and already owns the back chain)

**Interfaces:**
- Consumes: `Space` (Task 6), `useSpaceRoute` (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

`tests/back-navigation.test.tsx` already owns this mechanism and already mounts
`<App />`. Append there — do not start a new file.

Follow that file's existing harness exactly. It drives a **real** hash
assignment inside `act`, not a synthetic `HashChangeEvent`: its own header
comment says the mechanism under test is the real `hashchange`, and a
hand-built event with an `oldURL` would test a listener against an input the
browser never produces. Reuse its `useStore.setState`, its `stubFetch`, its
`treeWith` helper and its `agent()` fixture.

```tsx
test("an agent pane opened from a SPACE returns to that space, not the list", async () => {
  // The defect this closes: the origin was a boolean (`fromSpaces`), so it
  // could say "came from Spaces" but not WHICH space — every pane opened from
  // a space screen returned to the plural list.
  useStore.setState({
    connect: () => {},
    agents: [agent({ agentId: "w9:p1", name: "docs-cleanup", workspaceId: "w9", workspaceLabel: "docs-cleanup" })],
  });
  location.hash = "#/space/w9";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith("claude"),
    "/output": () => ({ lines: ["out"], source: "visible" }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  expect(host.querySelector(".space-screen-head")).not.toBeNull();

  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  // Labelled by the space's own name, never its herdr coordinate.
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to docs-cleanup");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/space/w9");
});

test("a shell pane opened from a space returns there, labelled generically", async () => {
  // A shell is deliberately absent from `agents` (§3), so the store has no
  // `workspaceLabel` for it and `useTreePane` returns a `TreePane` that
  // carries none either. The destination is still exact; only the WORD is
  // generic, because the alternative is printing `w9` — a herdr coordinate,
  // which `docs/gotchas.md` bans on screen as "correct and useless".
  useStore.setState({ connect: () => {} });
  location.hash = "#/space/w9";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(null),
    "/output": () => ({ lines: ["out"], source: "visible" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to this space");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/space/w9");
});
```

The two pre-existing `#/spaces` tests and the two cold-deep-link tests in that
file must keep passing UNMODIFIED. They cover the other legs of the chain, and
this task changes the ref's field type, not the rules those four assert.

- [ ] **Step 2: Run it and confirm it fails**

Expected: the first test fails — the back label says "Spaces", not the space's
name, and the hash lands on `#/spaces`.

- [ ] **Step 3: Change the ref to hold a hash**

Replace the `paneOriginRef` declaration's type and its handler:

```tsx
  /**
   * Where the currently open pane was navigated FROM, as the origin's own
   * HASH — read off the real `hashchange`, not guessed from the pane's shape
   * (§16.4).
   *
   * A hash string rather than the `fromSpaces` boolean this replaced. The
   * boolean could say "came from Spaces" but not WHICH space, so every pane
   * opened from a space screen returned to the plural list. Adding a second
   * field for the id would have left two fields free to disagree; one cannot.
   *
   * A ref, and kept on `App`, deliberately: `App` never unmounts, while
   * `AgentTerminal` and `PaneTerminal` do on exactly the transition this has
   * to survive — a shell promoted to an agent unmounts one and mounts the
   * other under the SAME pane id.
   *
   * DECLARED BEFORE THE ROUTE HOOKS, and that is load-bearing — effects run in
   * declaration order, so this listener must register before `useAgentRoute`'s.
   */
  const paneOriginRef = useRef<{ paneId: string; origin: string } | null>(null);
  useEffect(() => {
    const onHashChange = (e: HashChangeEvent) => {
      const paneId = agentIdFromHash(hashOf(e.newURL));
      // Only a navigation INTO a pane is worth recording.
      if (paneId === null) return;
      paneOriginRef.current = { paneId, origin: hashOf(e.oldURL) };
    };
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);
```

- [ ] **Step 4: Teach `backTargetFor` the two spaces-family origins**

The label question is already settled by reading: `App` holds no spaces tree.
`useTreePane` returns a single `TreePane`, which carries no space label, and it
only fetches at all when the id misses `agents`. What `App` does have is the
store — and an `Agent` carries `workspaceLabel`. So an agent pane can be
labelled by its space's real name, and a shell (deliberately absent from
`agents`, §3) cannot. The id is never shown either way: `docs/gotchas.md` rates
a herdr coordinate on screen as "correct and useless".

```tsx
  /**
   * The back destination for the pane addressed by `paneId`, and the label that
   * goes with it.
   *
   * Applies to BOTH the agent branch and the shell branch below — one rule, not
   * two literals (§16.4's correction).
   *
   * Only a spaces-family origin is honoured. Anything else — the dashboard,
   * Settings, or no origin at all on a cold deep link — goes to the dashboard.
   * That is what "no origin, no Spaces" means, and it is why a notification tap
   * (which fires no `hashchange`) lands back on the list of agents.
   */
  function backTargetFor(paneId: string | null): { hash: string; label: string; ariaLabel: string } {
    const origin = paneId !== null && paneOriginRef.current?.paneId === paneId
      ? paneOriginRef.current.origin
      : null;
    if (origin === null) return { hash: "", label: "‹ Agents", ariaLabel: "Back to agents" };

    if (spaceIdFromHash(origin) !== null) {
      /*
       * Named where the store can name it, generic where it cannot, and NEVER
       * the space id.
       *
       * `App` has no spaces tree to ask — `useTreePane` resolves one pane and
       * carries no space label, and it does not even fetch for a pane the store
       * already holds. What it does have is the agent, and an `Agent` carries
       * `workspaceLabel`. A shell is deliberately absent from `agents` (§3), so
       * for those there is no label here and the word stands in.
       *
       * The DESTINATION is exact in both cases; only the wording differs. The
       * alternative was printing `w9`, which `docs/gotchas.md` bans on screen.
       */
      const label = agents.find((a) => a.agentId === paneId)?.workspaceLabel ?? null;
      return label !== null
        ? { hash: origin, label: `‹ ${label}`, ariaLabel: `Back to ${label}` }
        : { hash: origin, label: "‹ Space", ariaLabel: "Back to this space" };
    }
    if (origin === "#/spaces") {
      return { hash: "#/spaces", label: "‹ Spaces", ariaLabel: "Back to spaces" };
    }
    return { hash: "", label: "‹ Agents", ariaLabel: "Back to agents" };
  }
```

`agents` is the list `App` already reads from the store for the dashboard — use
that binding, do not add a second read.

- [ ] **Step 5: Route the new screen**

Add the hook beside the others, and the branch beside `showSpaces`:

```tsx
  const openSpaceId = useSpaceRoute();
```

```tsx
  if (openSpaceId !== null) {
    return (
      <Space
        spaceId={openSpaceId}
        onBack={() => { location.hash = "#/spaces"; }}
        senders={LIVE_SENDERS}
        createSenders={LIVE_CREATE_SENDERS}
        navigate={(hash) => { location.hash = hash; }}
      />
    );
  }
```

Place it BEFORE the `showSpaces` branch. `useSpacesRoute` matches
`"#/spaces"` exactly and `spaceIdFromHash` requires the trailing slash, so the
two cannot both be true — the ordering is belt and braces, not load-bearing,
and the comment should say which.

Add `spaceIdFromHash` and `useSpaceRoute` to the existing `@web/route` import,
and `Space` to the component imports. Use the same `LIVE_SENDERS` /
`LIVE_CREATE_SENDERS` the `Spaces` branch already passes.

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test tests/back-navigation.test.tsx`
Expected: PASS — the two new tests, and the file's four existing ones still
green and unmodified.

Run: `make check`
Expected: exit 0. A `fromSpaces` left anywhere is a type error now — that is
the point of changing the field rather than adding one.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/components/App.tsx tests/
git commit -m "feat: back from a pane returns to the space it was opened from, not the list"
```

---

## Task 8: The list stops carrying everything

Now that `#/space/<id>` exists and is reachable, the list can shed the
controls. This is the task the 33-target measurement is about.

**Files:**
- Modify: `src/web/components/Spaces.tsx`
- Modify: `src/web/components/SpaceRow.tsx`
- Test: `tests/spaces-screen.test.tsx` (rewritten)

**Interfaces:**
- Consumes: `sortSpaces`, `spaceState` (Task 1); `spaceHash` (Task 2).
- Produces: `SpaceRow`'s props shrink to:
  ```ts
  export function SpaceRow(props: { space: Space }): JSX.Element
  ```

- [ ] **Step 1: Rewrite the tests**

`tests/spaces-screen.test.tsx` is rewritten, not patched. Its fixtures
(`FLAT`, `STRUCTURED`, `SHELL`, `SPLIT`, `SLUG`, `DIVERGED`, `TABBED`,
`SHELL_HOME`) are good and are KEPT verbatim — reuse the file's existing
fixture block and replace only the tests below it.

Deleted, because they assert the superseded structure — a deliberate behaviour
change, not a refactor, so they go rather than being bent to pass:

- "a 1:1:1 space renders as ONE row with nothing to expand"
- "a space with two tabs renders sub-rows"
- "a tab label is a caption on its pane, not a heading above a group"
- "an unnamed tab contributes no caption at all"
- "a shell is labelled by its folder, never by its prompt" — moved to
  `tests/tab-row.test.tsx` in Task 4, which is where that rule now renders
- "a name that is the slug of its space label shows no alias"
- "a genuinely different name is shown, on the pane not the space"
- "every row announces the actions that now exist, and none of them is inert"
- "a structured space says the count that explains its shape, and says it
  grammatically"
- "a merged row is a link into the pane"
- "an agent's merged row opens the same way a shell's does"
- "a structured space's own row is not a link"
- "a pane with no agent is shown, and never labelled with a state" — moved to
  `tests/tab-row.test.tsx`

Kept: "a failed read is surfaced, never rendered as an empty session".

New:

```tsx
test("no row carries a management control — the whole point of the second level", async () => {
  // The regression guard for the measurement this redesign is built on: eleven
  // spaces each carrying a link, a ⋯ and a + put 33 tap targets on one 390px
  // viewport while fitting every row without a scroll. If a control comes back
  // onto a row, this fails.
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  const list = host.querySelector(".spaces")!;
  expect(list.querySelectorAll("[data-create]").length).toBe(0);
  expect(list.querySelectorAll("[aria-label^='Actions']").length).toBe(0);
  expect(list.querySelectorAll("button").length).toBe(0);
});

test("a row opens its space, not a pane", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector("[data-space-row] a")?.getAttribute("href")).toBe("#/space/w3");
});

test("a row says its name, its rollup state and its pane count, and nothing else", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  const row = host.querySelector("[data-space-row]")!;
  expect(row.querySelector(".space-name")?.textContent).toBe("schema migration");
  expect(row.querySelector(".space-state")?.textContent).toBe("working");
  expect(row.querySelector(".space-count")?.textContent).toBe("2");
  // The alias is gone with the merged row it explained.
  expect(row.querySelector(".space-alias")).toBeNull();
});

test("nothing collapses, so nothing offers to", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector("[data-expand]")).toBeNull();
  expect(host.querySelector("[aria-expanded]")).toBeNull();
});

test("the collapsed-state key is not written any more", async () => {
  // A stale key holding space ids that address nothing is worse than none.
  localStorage.removeItem("paddock.spaces.collapsed");
  await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(localStorage.getItem("paddock.spaces.collapsed")).toBeNull();
});

test("blocked sorts first and a space with no agent sorts last", async () => {
  const MIXED: SpaceTree = {
    readAt: 1_700_000_000_000,
    spaces: [
      { spaceId: "wi", label: "docs-cleanup", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wi:t1", label: null, panes: [{ paneId: "wi:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "idle" }] }] },
      { spaceId: "wn", label: "scratch", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wn:t1", label: null, panes: [{ paneId: "wn:p1", harness: null, name: null, title: "t", cwd: "/srv/project", state: null }] }] },
      { spaceId: "wb", label: "flaky-test-fix", tabCount: 1, paneCount: 1, tabs: [{ tabId: "wb:t1", label: null, panes: [{ paneId: "wb:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "blocked" }] }] },
    ],
  };
  const host = await render(<Spaces onBack={() => {}} load={load(MIXED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["flaky-test-fix", "docs-cleanup", "scratch"]);
});

test("the header keeps the one control that makes a space", async () => {
  const host = await render(<Spaces onBack={() => {}} load={load(TABBED)} />);
  expect(host.querySelector(".spaces-head [data-create='space']")).not.toBeNull();
});

test("an unnamed space is named by its id, because a blank row is not a row", async () => {
  const UNNAMED: SpaceTree = {
    readAt: 1_700_000_000_000,
    spaces: [{ spaceId: "w7", label: null, tabCount: 1, paneCount: 1, tabs: [{ tabId: "w7:t1", label: null, panes: [{ paneId: "w7:p1", harness: "claude", name: null, title: "t", cwd: "/srv/project", state: "idle" }] }] }],
  };
  const host = await render(<Spaces onBack={() => {}} load={load(UNNAMED)} />);
  expect(textsOf(host, "[data-space-row] .space-name")).toEqual(["w7"]);
});
```

The `MIXED` fixture's spaces are deliberately NOT already in sorted order, so
the assertion cannot pass on the fixture's own shape.

- [ ] **Step 2: Run and confirm the new tests fail**

Run: `bun test tests/spaces-screen.test.tsx`
Expected: the new tests fail — rows still carry `⋯` and `+`, the row links to
a pane, `[data-expand]` still renders.

- [ ] **Step 3: Rewrite `SpaceRow.tsx`**

The file shrinks to one row shape. Delete `sameLabel`, `PaneMarker`,
`PaneState`, the alias, the sub-row tree, the `⋯`, the `+`, the chevron, and
the whole opening note about the `⋯` — that note's requirements now live on
`TabRow` and in `RowActions`'s own header, and a note describing a control
this file no longer renders is worse than none.

```tsx
import { spaceHash } from "@shared/route";
import type { Space } from "@shared/types";
import { spaceState } from "@web/components/space-sort";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * One space, as a row in the list — and nothing else.
 *
 * It used to carry a `⋯`, a `+`, a chevron, an alias and its panes' sub-rows.
 * Measured at 390px with eleven spaces, that was 33 tap targets on a screen
 * whose eleven rows all fitted without a scroll: the problem was never
 * vertical space, it was that a list had become a control panel. Those
 * controls now live on `#/space/<id>`, where the operator has already chosen
 * what they are managing.
 *
 * Three things, in this order: what it is, how it is doing, how big it is. The
 * count is the cheap honest answer to "is there structure in here" — a `1`
 * opens onto one tab, a `4` is worth the tap.
 */
export function SpaceRow({ space }: { space: Space }) {
  // Falls back to the id so the row says something. A space can be unnamed; a
  // row cannot be blank. This is the fallback that must NEVER be passed on to
  // anything that writes — handing it to a create sheet made a herdr
  // coordinate an agent's suggested name.
  const label = space.label ?? space.spaceId;
  const state = spaceState(space);

  return (
    <li data-space-row data-space-id={space.spaceId} data-state={state ?? "none"}>
      <a href={spaceHash(space.spaceId)}>
        {/* `StateMarker` carries the null-state rule for every surface that
            shows one — see `ui/StateMarker.tsx`. */}
        <StateMarker state={state} />
        <span className="space-name">{label}</span>
        {/* Colour is never the only channel: StatusDot is aria-hidden, and this
            palette spends red and green on the two states that matter most. */}
        <span className="space-state">{state ?? NO_AGENT}</span>
        {/* A bare number, in mono, because it is a quantity to compare down a
            column rather than a sentence to read. The pluralised
            "2 tabs"/"1 pane" phrasing went with the merged row that needed to
            explain its own shape. */}
        <span className="space-count">{space.paneCount}</span>
      </a>
    </li>
  );
}
```

- [ ] **Step 4: Simplify `Spaces.tsx`**

- Delete `COLLAPSED_KEY`, `readCollapsed`, the `collapsed` state and `toggle`.
- Delete the `cwds` computation and the `canCreate` fan-out to rows — the
  header's own `CreateSheet` still needs `cwds`, so keep that expression and
  delete only the props passed down to `SpaceRow`.
- Sort with `sortSpaces(tree.spaces)`.
- Render `<SpaceRow key={s.spaceId} space={s} />` and nothing else.
- Keep the header (back, `Spaces`, the header `+`), the error paragraph, and
  the footer with its "as of" refresh.
- Keep `senders` and `createSenders` in the props type ONLY if `App` still
  passes them for the header's create sheet; delete `senders` if nothing on
  this screen writes any more. Check before deleting, and let `make check`
  confirm.

Add `import { sortSpaces } from "@web/components/space-sort";` and drop the
now-unused imports (`RowSenders`, and `SpaceRow`'s removed props).

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test tests/spaces-screen.test.tsx`
Expected: PASS.

Run: `make check`
Expected: exit 0.

- [ ] **Step 6: Prove the 33-target guard can fail**

Temporarily add a `<RowActions …>` back onto `SpaceRow`. The "no row carries a
management control" test must FAIL. Revert. This is the one guard the whole
redesign exists to hold — a version of it that cannot fail is worth nothing.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/components/Spaces.tsx src/web/components/SpaceRow.tsx tests/spaces-screen.test.tsx
git commit -m "feat: the list goes back to being a list, and sheds 22 tap targets"
```

---

## Task 9: The restyle, and the selectors that no longer exist

**Files:**
- Modify: `src/web/styles.css`
- Modify: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: the class names Tasks 4–8 render: `.tabs`, `[data-tab-row]`,
  `.tab-head`, `.tab-heading`, `.tab-name`, `.tab-count`, `.tab-panes`,
  `.tab-create`, `.create-row`, `.space-screen-head`, `.space-picker-btn`,
  `.space-picker-name`, `.space-picker-caret`, `.space-picker-sheet`,
  `.space-picker-list`, `[data-picker-row]`, `.space-state`.
- Produces: nothing.

- [ ] **Step 1: Delete the dead rules FIRST**

The guard in Step 2 can only go red once the stylesheet has actually lost the
selector. Task 8 removed the chevron’s JSX, not its CSS, so `[data-expand]` is
still a live selector in `styles.css` until this step runs — write the guard
before deleting and it passes both before and after, which is a test whose red
state was never seen.

Remove from `src/web/styles.css` every rule whose selector nothing renders any
more. Confirm each one before deleting — this list was written before Tasks 4–8
existed, so do not delete on its authority:

```bash
for sel in "data-expand" "space-alias" "space-tabs" "pane-tab" "space-heading" "space-head"; do
  echo "== $sel"; grep -rn "$sel" src/web --include="*.tsx" --include="*.ts" | grep -v styles.css
done
```

A selector with no hit outside `styles.css` is dead and goes. A selector still
rendered by `TabRow`, `Space`, `SpacePicker` or `SpaceRow` **stays** —
`.pane-heading`, `.pane-name`, `.pane-state`, `.space-name`, `.space-count` and
`.dot-none` are all still rendered, so none of them is a candidate. `.dot-none`
in particular was just rewritten in Task 3; deleting it would undo that.

- [ ] **Step 2: Write the guard, and watch it go red**

Append to `tests/tokens.test.ts`:

```ts
test("every off-scale exception still names a selector the stylesheet has", async () => {
  // A list of exceptions that outlives the rules it excused stops being a
  // record of deliberate choices and becomes noise — and the failure mode of a
  // scanner is someone silencing it. `[data-expand]` is the first entry to go
  // stale: nothing collapses on either Spaces screen any more.
  const css = await Bun.file("src/web/styles.css").text();
  const selectors = new Set(rules(css).map((r) => r.sel));
  for (const sel of OFF_SCALE) {
    expect(selectors.has(sel)).toBe(true);
  }
});
```

Run: `bun test tests/tokens.test.ts`
Expected: **FAIL** — `[data-expand]` is in `OFF_SCALE` and no longer in the
stylesheet. If it PASSES, Step 1 did not actually delete the chevron rule and
this guard is asserting nothing; finish Step 1 before going on.

- [ ] **Step 3: Remove the stale exception, and watch it go green**

Delete `"[data-expand]",` and its `// sizes the ▸/▾ chevron GLYPH, not text`
comment from `OFF_SCALE` in `tests/tokens.test.ts`. Leave every other entry —
each excuses a rule that still exists.

Run: `bun test tests/tokens.test.ts`
Expected: PASS.
- [ ] **Step 4: Style the two screens**

Style A, the quiet dot (§6): hairline dividers, no per-row card, no border,
and the accent colour on exactly one control per screen. Requirements that are
not negotiable:

- Every colour comes from a token already on bare `:root`. Do not introduce a
  new one; if a shade is genuinely missing, add it to `:root` AND to both the
  `prefers-color-scheme` and `[data-theme="dark"]` blocks in the same edit.
- Every `font-size` is a `--t-*` step, or the selector goes in `OFF_SCALE`
  with a comment saying what it sizes and why it is not prose.
- Row height at least 44px of tap target. `.space-picker-btn` and every
  `[data-picker-row]` are tap targets too.
- `env(safe-area-inset-bottom)` respected on the sheet, in that rule's OWN
  `padding-bottom` — never a second class beside it, which is how the inset
  gets silently dropped.
- `.tab-count` and `.space-count` get `font-variant-numeric: tabular-nums`, so
  counts line up down the column.
- No hover-only affordance. Anything using `:hover` needs a
  `(hover: hover)` guard or a non-hover equivalent.
- `prefers-reduced-motion` respected on any transition added.

- [ ] **Step 5: Run the full suite**

Run: `make test`
Expected: 0 fail. `tests/tokens.test.ts`'s existing guards are the ones most
likely to catch a mistake here — the type scale, the "no rule declares
font-size twice" check, and "an ancestor's font shorthand cannot outrank a
glyph size it contains".

- [ ] **Step 6: Look at it at 390px**

Build and serve on a spare port — **8787 is the operator's own instance**, so
use a different `PADDOCK_PORT` and kill only the process you started:

```bash
make build
PADDOCK_PORT=8931 ./dist/paddock serve
```

Check, at 390px: the list's rows carry no controls; a row opens its space; the
header title opens the picker; add-tab is the last row; back from a pane
reaches the space it was opened from; the shell marker is a complete square;
the Settings glyph reads as sliders; the blocked pill has no glyph. Then stop
your own server.

The Spaces screens cannot be screenshotted for the README — `--demo` has no
herdr session, so `spacesAvailable` is false and the entry point correctly does
not render. That is the existing limitation, unchanged.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/web/styles.css tests/tokens.test.ts
git commit -m "style: a list that reads as a list, and an exceptions list that cannot rot"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/design/2026-08-25-spaces-two-level-redesign.md` maps to a task:

| Spec | Task |
|---|---|
| §4 routes | 2 |
| §4.1 back chain | 7 |
| §5.1 the list, sort order | 8 (order from 1) |
| §5.2 space screen, picker, add-tab | 5, 6 |
| §5.3 tab rows, no third level | 4 |
| §6 row style A | 8, 9 |
| §7.1 SettingsIcon | 3 |
| §7.2 `.dot-none` | 3 |
| §7.3 blocked pill | 3 |
| §3 collapse and the dropped key | 8 |
| §9 test list, items 1–9 | 8, 8, 4, 5, 7, 6, 3, 3, 3 |
| §10 file table | all |

**Type consistency.** `spaceState`/`sortSpaces` are spelled the same in Tasks
1, 5, and 8. `spaceHash`/`spaceIdFromHash` the same in 2, 5, 7, 8.
`SpaceRow`'s props shrink to `{ space }` in Task 8 and Task 8 is the only
caller. `CreateSheet`'s `variant` is added in Task 6 with a default, so the
call sites in `Spaces.tsx` and the deleted `SpaceRow` usage need no change.
`TabRow`'s `{ tab, onChanged, senders }` matches how Task 6 calls it.

**Two things checked rather than guessed**, because an earlier draft of this
plan left them open and the repository answers both:

1. Task 7's tests go in `tests/back-navigation.test.tsx`, which already mounts
   `<App />` and already owns this mechanism. It drives real hash assignments
   inside `act`, not synthetic `HashChangeEvent`s — the plan's test code follows
   that harness, because a hand-built event with an `oldURL` tests the listener
   against an input a browser never produces.
2. `App` holds no spaces tree, so the back label cannot come from one.
   `useTreePane` resolves one `TreePane` and carries no space label, and does
   not fetch at all for a pane the store already holds. The store's `Agent`
   does carry `workspaceLabel`, so Task 7 names the space for agent panes and
   uses a generic word for shells — never the space id, which
   `docs/gotchas.md` bans on screen.

**One thing genuinely left to the implementer:** Task 9 Step 3 deletes CSS
rules whose selectors nothing renders any more. The task gives the command to
confirm each one and says not to delete on the strength of the list, because
the list was written before Tasks 4–8 existed and a selector `TabRow` or
`Space` turns out to use must stay.
