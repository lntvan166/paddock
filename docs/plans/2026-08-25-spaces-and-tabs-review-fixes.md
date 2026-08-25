# Spaces and Tabs — Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped Spaces screen read correctly, give a shell pane a keyboard, and send Back where the operator came from.

**Architecture:** No new subsystems. Five repairs to code that shipped in `docs/plans/2026-08-25-spaces-and-tabs-read.md`, driven by a design review of the live screen. Two new POST routes reuse the existing action-route shape; everything else is presentation and navigation.

**Tech Stack:** Bun, TypeScript, Hono, React 19, `bun:test`, happy-dom.

**Spec:** `docs/design/2026-08-25-spaces-and-tabs-management-design.md` — **read §16 first**; it records what the review found and why. §8 also carries a dated correction.

**Branch:** `feat/spaces-and-tabs` — the same branch PR #14 is open on. These fixes must land before it merges, so the duplicated-label rows never reach `main`.

**Scope:** Items 1, 2, 3 and 6 of the review. Item 5 (create / rename / close) is a separate plan on a fresh branch and is already designed in §7/§9/§10 — **do not start it here**, and do not add a `+` or `⋯` control (§16.7 explains why a create control ships only with the sheet that fills it).

## Global Constraints

- **This repository is public.** No real hostnames, absolute home paths, usernames, or real agent/workspace names in committed content. Invented names only: `dev-box`, `/srv/project`, `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`.
- **`make check-clean` before every commit.** If it fails, fix the content — never add a string to an ignore list.
- **`make test` builds the UI first.** Never bare `bun test` with no path for a full run.
- **No device detection, no `isMobile`, no user-agent parsing.** Width media queries for layout, `(pointer: coarse)` / `(hover: hover)` for interaction.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, then redefined under `prefers-color-scheme: dark` AND `:root[data-theme="dark"]`.
- **No hover-only affordances.** Respect `prefers-reduced-motion` and `env(safe-area-inset-bottom)`.
- **Never swallow errors.** No `2>/dev/null`, no empty catch, no unconditional success.
- **Type must sit on the `--t-*` scale.** Do not add an `OFF_SCALE` exemption for prose; that list is for glyph-only declarations.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/herdr/tree.ts` | **Modify.** Tilde-ise `$HOME` in `cwd` so no username crosses the wire. |
| `src/web/components/SpaceRow.tsx` | **Modify.** Slug-normalised alias compare; shell label from cwd; tab label demoted to a pane caption. |
| `src/web/styles.css` | **Modify.** Containment bracket for a space's children; caption style; header grouping. |
| `src/web/components/HostHeader.tsx` | **Modify.** Group the Spaces control beside Settings. |
| `src/server/herdr/actions.ts` | **Modify.** `sendPaneText`, `sendPaneKey` via `pane.send_text` / `pane.send_keys`. |
| `src/server/routes.ts` | **Modify.** `POST /api/panes/:id/text`, `POST /api/panes/:id/key`. |
| `src/web/api.ts` | **Modify.** `sendPaneText`, `sendPaneKey` clients. |
| `src/web/components/PaneTerminal.tsx` | **Modify.** Reply box + keypad for a shell, wired to the pane routes. |
| `src/web/components/App.tsx` | **Modify.** An agent pane returns to the surface it was opened from. |
| `src/web/components/Spaces.tsx` | **Modify.** Use the shared `term-back` control. |
| `docs/decisions.md` | **Modify.** Record the xterm.js refusal with its number. |

---

## Task 1: The Spaces screen says the right things

Four presentation defects, one file plus CSS, reviewed as one unit because they are all "what a row tells you".

**Files:**
- Modify: `src/server/herdr/tree.ts`, `src/web/components/SpaceRow.tsx`, `src/web/styles.css`, `src/web/components/HostHeader.tsx`
- Test: `tests/spaces-screen.test.tsx`, `tests/tree.test.ts`

**Interfaces:**
- Consumes: `Space`, `TreePane` from `@shared/types`; `paneHash`; `StatusDot`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add to `tests/spaces-screen.test.tsx`:

```tsx
const SLUG: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w1", label: "api refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "x", cwd: "/srv/project", state: "idle" },
    ] }],
  }],
};

const DIVERGED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w2", label: "api refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w2:t1", label: null, panes: [
      { paneId: "w2:p1", harness: "claude", name: "chasing a flaky test", title: "x", cwd: "/srv/project", state: "idle" },
    ] }],
  }],
};

const TABBED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w3", label: "schema migration", tabCount: 2, paneCount: 2,
    tabs: [
      { tabId: "w3:t1", label: "migrate up", panes: [{ paneId: "w3:p1", harness: "codex", name: "schema-migration", title: "x", cwd: "/srv/project", state: "working" }] },
      { tabId: "w3:t2", label: null, panes: [{ paneId: "w3:p2", harness: "claude", name: "schema-migration-2", title: "x", cwd: "/srv/project", state: "idle" }] },
    ],
  }],
};

const SHELL_HOME: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w4", label: "scratch", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w4:t1", label: null, panes: [
      { paneId: "w4:p1", harness: null, name: null, title: "operator@dev-box:~", cwd: "~", state: null },
    ] }],
  }],
};

test("a name that is the slug of its space label shows no alias", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SLUG} />);
  await settle();
  expect(el.textContent).toContain("api refactor");
  expect(el.querySelector(".space-alias")).toBeNull();
  await unmount();
});

test("a genuinely different name is shown, on the pane not the space", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => DIVERGED} />);
  await settle();
  expect(el.textContent).toContain("api refactor");
  expect(el.textContent).toContain("chasing a flaky test");
  await unmount();
});

test("a tab label is a caption on its pane, not a heading above a group", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => TABBED} />);
  await settle();
  expect(el.querySelector("h3")).toBeNull();
  const cap = el.querySelector(".pane-tab");
  expect(cap?.textContent).toContain("migrate up");
  // The pane it captions, not a sibling of the group.
  expect(cap?.closest("[data-pane-row]")).not.toBeNull();
  await unmount();
});

test("an unnamed tab contributes no caption at all", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => TABBED} />);
  await settle();
  expect(el.querySelectorAll(".pane-tab")).toHaveLength(1);
  await unmount();
});

test("a shell is labelled by its folder, never by its prompt", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => SHELL_HOME} />);
  await settle();
  const row = el.querySelector("[data-pane-row]")!;
  expect(row.textContent).not.toContain("operator@dev-box");
  expect(row.textContent).toContain("~");
  await unmount();
});
```

Add to `tests/tree.test.ts`:

```ts
test("a home-directory cwd is tilde-ised, so no username crosses the wire", () => {
  const snap = { ...(snapshot as any), panes: (snapshot as any).panes.map((p: any) =>
    p.pane_id === "w3:p1" ? { ...p, cwd: "/base/operator/work" } : p) };
  const t = toSpaceTree(snap as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("~/work");
  expect(pane.cwd).not.toContain("operator");
});

test("a cwd outside home is untouched", () => {
  const t = toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW, { home: "/base/operator" });
  const pane = t.spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.cwd).toBe("/srv/project");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/spaces-screen.test.tsx tests/tree.test.ts`
Expected: FAIL — the alias renders for a slug match, an `h3` still exists, the shell shows its prompt, and `toSpaceTree` takes no third argument.

- [ ] **Step 3: Tilde-ise `$HOME` in `tree.ts`**

Add an options argument (defaulted, so existing callers keep working):

```ts
export interface TreeOptions {
  /** The operator's home directory, so `cwd` can be tilde-ised before it
   *  leaves the server. Injected rather than read from `process.env` here:
   *  this module is pure and its tests must not depend on the machine. */
  home?: string;
}

export function toSpaceTree(
  snap: HerdrSessionSnapshot, now: number, opts: TreeOptions = {},
): SpaceTree { /* … pass opts.home into toPane … */ }

/**
 * `/base/operator/work` -> `~/work`.
 *
 * Not cosmetic. A pane with no agent is labelled by its folder (§16.6), and
 * the folder of a home directory IS the username — which this repo's first
 * rule exists to keep out of screens and screenshots. Doing it server-side
 * means the username never crosses the wire at all, rather than being hidden
 * by the client that happens to render it.
 */
function tildeise(cwd: string, home: string | undefined): string {
  if (!home || home === "/" || !cwd) return cwd;
  const h = home.replace(/\/+$/, "");
  if (cwd === h) return "~";
  return cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}
```

Pass `{ home: process.env.HOME }` from the `readTree` wiring in `src/server/index.ts`.

- [ ] **Step 4: Fix the alias, the shell label and the tab caption in `SpaceRow.tsx`**

```tsx
/**
 * Are these two strings the same label, allowing for herdr's own slugging?
 *
 * §14.7 measured that herdr initialises an agent's `name` to the SLUG of its
 * workspace label. A literal comparison therefore reports a difference that is
 * not one — `"api refactor"` vs `"api-refactor"` — and the first version of
 * this screen printed every merged row's title twice, once de-spaced. §16.1.
 *
 * Deliberately loose. A false negative hides an alias on a row whose labels
 * differ only in punctuation, which costs nothing. A false positive is visible
 * noise on nearly every row, which is the defect this replaces.
 */
function sameLabel(a: string, b: string): boolean {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug(a) === slug(b);
}

/**
 * What to call a pane that has no agent.
 *
 * NOT its terminal title: for a pane sitting at a prompt that title IS the
 * prompt (`operator@dev-box:~`), which labels nothing and puts a hostname on
 * screen. The folder answers the question an unnamed pane actually raises —
 * where is it — and `cwd` arrives already tilde-ised (§16.6).
 */
function shellLabel(p: TreePane): string {
  const trimmed = p.cwd.replace(/\/+$/, "");
  const seg = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return seg || "shell";
}
```

Then: `paneIdentity` becomes `only.name ?? (only.harness === null ? shellLabel(only) : only.title)`, and `showAlias` uses `!sameLabel(paneIdentity, spaceLabel)`.

Delete the `<h3 className="tab-name">` group heading. Each pane row instead renders, **inside** the row, beneath the pane name:

```tsx
{t.label !== null && <span className="pane-tab">{t.label}</span>}
```

A structured space's pane row labels itself with `p.name ?? (p.harness === null ? shellLabel(p) : p.title) ?? p.paneId`.

- [ ] **Step 5: Containment and header grouping in CSS**

`.space-tabs` gets a left rule and indent so a space's children are visibly bracketed — one existing border token, **no new colour**. `.pane-tab` uses `--t-xs` and `--fg-dim`. In `HostHeader.tsx`, wrap the Spaces and Settings controls in one flex container so the title owns one end and the controls read as a cluster, instead of `justify-between` stranding the middle child.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/spaces-screen.test.tsx tests/tree.test.ts && make check`
Expected: PASS, and the four pre-existing `spaces-screen` tests still pass **unmodified**.

- [ ] **Step 7: Look at it**

Run `make dev` on a spare `PADDOCK_PORT` (8787 is the operator's own instance — do not touch it), load `#/spaces` at 390px. Confirm: no row prints its title twice; a space's children are visibly contained; a tab caption sits under its pane; the shell row shows a folder, not a prompt; the header controls are grouped; no horizontal scroll. Do not commit screenshots.

- [ ] **Step 8: Commit**

```bash
make check-clean
git add src/server/herdr/tree.ts src/server/index.ts src/web/components/SpaceRow.tsx src/web/components/HostHeader.tsx src/web/styles.css tests/spaces-screen.test.tsx tests/tree.test.ts
git commit -m "fix: a space row said its own name twice, and a tab label pretended to be a section"
```

---

## Task 2: Send text and keys to a pane with no agent

**Files:**
- Modify: `src/server/herdr/actions.ts`, `src/server/routes.ts`
- Test: `tests/pane-input.test.ts` (create)

**Interfaces:**
- Produces: `HerdrActions.sendPaneText(paneId, text)`, `HerdrActions.sendPaneKey(paneId, key)`; routes `POST /api/panes/:id/text`, `POST /api/panes/:id/key`.

- [ ] **Step 1: Write the failing tests**

Create `tests/pane-input.test.ts`, following `tests/spaces-route.test.ts`'s injected-fake style. Cover: text reaches `sendPaneText` verbatim; a key outside the allowlist is **refused** with 400 and never forwarded; a pane that *has* an agent gets 409 directing the caller to the agent route; an unknown pane 404s; a herdr throw becomes `{ok:false,detail}` 502; text over the ceiling is refused, not truncated.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/pane-input.test.ts` → FAIL, routes not registered.

- [ ] **Step 3: Implement the actions**

```ts
    async sendPaneText(paneId, text) {
      // `pane.send_text`, the mirror of the agent path's `agent.prompt`.
      // Parameter is `pane_id`, not `target` — measured; they are not
      // interchangeable.
      await request(socketPath, "pane.send_text", { pane_id: paneId, text });
    },

    async sendPaneKey(paneId, key) {
      await request(socketPath, "pane.send_keys", { pane_id: paneId, keys: [key] });
    },
```

- [ ] **Step 4: Implement the routes**

Both inside the `deps.actions` block, both validating the pane against `deps.readTree` exactly as `/api/panes/:id/output` does — 404 unknown, 409 when the pane has a harness, 502 on a herdr throw, all inside one `try`. **Reuse the existing `isNavKey` allowlist** for `/key`: the reason `NavKey` is closed applies identically here, and a shell is if anything a larger lever than an agent's prompt. Bound the text with the existing `MAX_TEXT_LEN` and **refuse** rather than truncate.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/pane-input.test.ts && bun test tests/action-routes.test.ts && make check`
Expected: PASS. The `HerdrActions` interface widened, so existing hand-rolled mocks need stubs — add them, change no assertion.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/server/herdr/actions.ts src/server/routes.ts tests/pane-input.test.ts tests/action-routes.test.ts
git commit -m "feat: a shell pane can be typed into, on the same closed key allowlist as an agent"
```

---

## Task 3: Give the shell terminal its keyboard

**Files:**
- Modify: `src/web/api.ts`, `src/web/components/PaneTerminal.tsx`
- Test: `tests/shell-terminal.test.tsx`, `tests/web-api.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/web-api.test.ts`: `sendPaneText` POSTs to the encoded `/api/panes/:id/text` and rejects on non-2xx with the server's detail; same for `sendPaneKey`.

In `tests/shell-terminal.test.tsx`: a shell renders a reply box and a keypad; typing and sending calls the injected sender with the text verbatim; a send failure is surfaced, not swallowed; and — the invariant — a shell still renders **no prompt options** (`[data-prompt-option]`), because there is no prompt to parse.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/shell-terminal.test.tsx tests/web-api.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Add `sendPaneText` / `sendPaneKey` to `api.ts`, reusing `request`, `detailFrom` and `readJson` — do not write parallel helpers. In `PaneTerminal`, the reply box and keypad render when the pane has no harness, taking injected senders so the tests need no network. **Reuse the existing keypad component** rather than a second implementation; the agent path keeps its own senders untouched.

Note the asymmetry deliberately in a comment: an agent's reply goes through `agent.prompt` because it is answering a prompt; a shell's goes through `pane.send_text` because it is typing at a shell. Same control, different verb, and the pane's `harness` decides.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/shell-terminal.test.tsx tests/web-api.test.ts && make test`
Expected: PASS, full suite green.

- [ ] **Step 5: Verify against the live shell**

`make dev` on a spare port. Open the shell pane from `#/spaces`, type `ls`, send, confirm the transcript updates. Then type `claude` and confirm the pane promotes to an agent view with the transcript retained. **This is the first time that promotion path can be exercised without writing to a pane the operator is using** — report what you see. Kill only your own instance.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/api.ts src/web/components/PaneTerminal.tsx tests/shell-terminal.test.tsx tests/web-api.test.ts
git commit -m "feat: type into a shell from the phone, which is the whole point of a shell"
```

---

## Task 4: Back goes where you came from, dressed like everything else

**Files:**
- Modify: `src/web/components/App.tsx`, `src/web/components/Spaces.tsx`
- Test: `tests/pane-deep-link.test.tsx` or a new `tests/back-navigation.test.tsx`

- [ ] **Step 1: Write the failing tests**

A pane opened from `#/spaces` returns to `#/spaces` — **for an agent pane, not only a shell**. A pane opened from the dashboard (or cold, from a notification deep link) returns to the dashboard. The Spaces screen's back control uses the shared treatment.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/back-navigation.test.tsx` → FAIL: `App.tsx:210` sends every agent pane to `""`.

- [ ] **Step 3: Implement**

`App.tsx` records the surface a pane was opened from and returns there; the shell branch already does this and the agent branch must match. Derive it from where navigation came from rather than guessing — a cold deep link has no origin and must land on the dashboard, never on a Spaces screen the operator never visited.

`Spaces.tsx` replaces `<button type="button" onClick={onBack}>Back</button>` with the shared `term-back` control and its `‹` chevron, matching `Settings.tsx:296`. Label it for its destination.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/back-navigation.test.tsx && make test` → PASS.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/App.tsx src/web/components/Spaces.tsx tests/back-navigation.test.tsx
git commit -m "fix: back from an agent returns to the space you opened it from"
```

---

## Task 5: Record the xterm.js refusal

A decision made under a measurement deserves the number, or the next person re-litigates it from scratch.

**Files:**
- Modify: `docs/decisions.md`

- [ ] **Step 1: Write the entry**

Add a numbered decision: **paddock does not embed a terminal emulator.** State what was asked (interactive shell panes), what xterm.js buys (cursor addressing, resize, full-screen programs like vim and htop), and what it costs — **roughly 80 KB gzipped on top of a measured 102.45 KB bundle**, in a project that rejected a 76 KB webfont on the grounds that it would be the largest payload on a slow link (decision 6) and that ships one chunk deliberately (decision 5). State what shipped instead: `pane.send_text` / `pane.send_keys` behind the existing reply box and closed key allowlist, which covers typing a command and interrupting one. Name the condition for revisiting: a stated need to *run* a full-screen program from the phone, not a general wish for fidelity — and note that lazy-loading it on the terminal route alone would need decision 5 reopened.

- [ ] **Step 2: Verify and commit**

```bash
make check-clean
git add docs/decisions.md
git commit -m "docs: why paddock does not embed a terminal emulator, with the number"
```

---

## Done

PR #14 then describes a screen that reads correctly, a shell you can type into, and Back that respects where you were.

Item 5 — create, rename and close for spaces and tabs — is next, on a fresh branch, from §7/§9/§10 plus §16.7's placement, and starts by measuring the three §13 probes that are still unmeasured.
