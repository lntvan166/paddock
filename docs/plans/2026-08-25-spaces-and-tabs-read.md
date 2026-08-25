# Spaces and Tabs — Read Half — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** paddock can see herdr's whole session — spaces, tabs, and panes that have no agent — and open any pane's terminal, including a plain shell.

**Architecture:** One `session.snapshot` call, shaped by a new `src/server/herdr/tree.ts` into a `SpaceTree`, served from `GET /api/spaces` and read on demand by a new `#/spaces` screen. Invalidated by a payload-free `tree-stale` push on structural herdr events. `AgentStore`, the delta path and the notifier are **not modified** — agents stay in the store; shell panes live only in the tree and the terminal view.

**Tech Stack:** Bun, TypeScript, Hono, React 19, `bun:test`, happy-dom.

**Spec:** `docs/design/2026-08-25-spaces-and-tabs-management-design.md` — read §3, §5 and §8 before Task 1.

**Branch:** `feat/spaces-and-tabs` (already checked out; the spec is committed there).

**Scope:** This plan covers spec §15 phases 1–3. Phases 4–6 (rename, create/spawn, close) are a separate plan. Stopping after this one leaves paddock strictly better: a space with no agent becomes visible for the first time.

## Global Constraints

- **This repository is public.** No real hostnames, paths, usernames, or agent names anywhere — fixtures and tests use `dev-box`, `/srv/project`, and the invented names `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`. A captured `session.snapshot` must **never** be committed raw; it carries workspace labels and absolute cwd paths.
- **`make check-clean` before every commit.** If it fails, fix the content — never add the string to the ignore list.
- **`make test` builds the UI first.** Never run bare `bun test`.
- **Dependency direction:** `herdr/socket → herdr/tree → routes → web/`. `tree.ts` must not import `state/store.ts` or `ws/hub.ts`.
- **Never swallow errors.** No `2>/dev/null`, no empty catch, no unconditional success.
- **`src/shared/herdr-api.d.ts` is never hand-edited.** Its interface bodies are literal text inside `scripts/gen-herdr-types.ts`; edit the script, then run `make types`.
- **No device detection, no `isMobile`, no user-agent parsing.** Width media queries for layout, `(pointer: coarse)` for interaction.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, redefined under `prefers-color-scheme` and `[data-theme]`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/gen-herdr-types.ts` | **Modify.** Add `HerdrSessionSnapshot`, `HerdrWorkspaceInfo`, `HerdrTabInfo`, `HerdrPaneInfo` to the emitted template. |
| `src/shared/herdr-api.d.ts` | **Regenerated** by `make types`. Never hand-edited. |
| `src/shared/types.ts` | **Modify.** `SpaceTree`, `Space`, `Tab`, `TreePane`; `tree-stale` on `ServerMessage`. |
| `src/server/herdr/tree.ts` | **Create.** The only module that knows `session.snapshot`'s field names. |
| `src/server/herdr/socket.ts` | **Modify.** Six structural subscribe/deliver name constants. |
| `src/server/supervisor.ts` | **Modify.** Subscribe to structural events; fire `onTreeStale`. |
| `src/server/ws/hub.ts` | **Modify.** `queueTreeStale()`. |
| `src/server/routes.ts` | **Modify.** `GET /api/spaces`. |
| `src/server/herdr/actions.ts` | **Modify.** `readPane()` via `pane.read`; extend `resolveSource` for `state: null`. |
| `src/web/api.ts` | **Modify.** `fetchSpaceTree()`. |
| `src/web/store.ts` | **Modify.** Handle `tree-stale` in `applyMessage` — **guarded before the delta fall-through**. |
| `src/web/route.ts`, `src/shared/route.ts` | **Modify.** `paneHash`, accept both hash prefixes. |
| `src/web/components/Spaces.tsx` | **Create.** The Spaces screen. |
| `src/web/components/SpaceRow.tsx` | **Create.** One space's row plus its sub-rows. |
| `src/web/components/PaneTerminal.tsx` | **Create.** Transcript + read loop for any pane. |
| `src/web/components/AgentTerminal.tsx` | **Modify.** Keeps agent-only controls; composes `PaneTerminal`. |

---

## Task 1: Probe the structural event names

Spec §13 probe 4. Matching a herdr event on the wrong spelling fails **silently, forever** — `socket.ts` already documents that trap for the existing four. Nothing in Task 7 may be written until this is measured.

**Files:**
- Create: `docs/probes/2026-08-25-structural-events.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the verified subscribe→deliver name pairs used verbatim in Task 7.

- [ ] **Step 1: Confirm a herdr server is running**

Run: `herdr status`
Expected: `server:` block shows `status: running` and `protocol: 20`. If not, start herdr before continuing.

- [ ] **Step 2: Subscribe to the six structural events and record what arrives**

Create `/tmp/probe-events.ts` (scratch, not committed):

```ts
import { connect } from "node:net";
const SOCK = `${process.env.HOME}/.config/herdr/herdr.sock`;
const SUBS = [
  "workspace.created", "workspace.closed", "workspace.renamed",
  "tab.created", "tab.closed", "tab.renamed",
].map((type) => ({ type }));

const sock = connect(SOCK, () => {
  sock.write(JSON.stringify({ id: "probe", method: "events.subscribe", params: { subscriptions: SUBS } }) + "\n");
  console.log("subscribed; now create/rename/close a tab and a space in herdr");
});
sock.on("data", (b) => {
  for (const line of b.toString().split("\n").filter(Boolean)) {
    const f = JSON.parse(line);
    console.log(f.error ? `REJECTED: ${JSON.stringify(f.error)}` : `DELIVERED: ${f.event ?? JSON.stringify(f).slice(0, 120)}`);
  }
});
```

Run: `bun /tmp/probe-events.ts`

Then, in herdr: create a tab, rename it, close it; create a space, rename it, close it.

- [ ] **Step 3: Record the result**

Write `docs/probes/2026-08-25-structural-events.md` containing, for each of the six: the name subscribed, the name delivered, and whether the subscribe was accepted.

If `events.subscribe` is **rejected** for any name, that is the finding — record the error code and the accepted spelling. Do not guess a working name.

- [ ] **Step 4: Verify the file states all six outcomes**

Run: `grep -c 'workspace\.\|tab\.' docs/probes/2026-08-25-structural-events.md`
Expected: at least 6.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add docs/probes/2026-08-25-structural-events.md
git commit -m "docs: measure herdr's structural event names, because matching the wrong one fails silently"
```

---

## Task 2: Declare the herdr snapshot types

**Files:**
- Modify: `scripts/gen-herdr-types.ts`
- Regenerate: `src/shared/herdr-api.d.ts`
- Modify: `tests/herdr-schema-drift.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HerdrSessionSnapshot`, `HerdrWorkspaceInfo`, `HerdrTabInfo`, `HerdrPaneInfo` from `@shared/herdr-api`.

- [ ] **Step 1: Write the failing drift test**

Append to `tests/herdr-schema-drift.test.ts`:

```ts
import type {
  HerdrPaneInfo, HerdrSessionSnapshot, HerdrTabInfo, HerdrWorkspaceInfo,
} from "@shared/herdr-api";

const DECLARED_TAB_FLAGS = {
  tab_id: true, workspace_id: true, label: true, number: true,
  agent_status: true, pane_count: true, focused: true,
} satisfies Record<keyof HerdrTabInfo, true>;

const DECLARED_WORKSPACE_INFO_FLAGS = {
  workspace_id: true, label: true, number: true, active_tab_id: true,
  agent_status: true, pane_count: true, tab_count: true, focused: true,
} satisfies Record<keyof HerdrWorkspaceInfo, true>;

const DECLARED_PANE_FLAGS = {
  pane_id: true, workspace_id: true, tab_id: true, agent: true,
  agent_status: true, cwd: true, focused: true, label: true,
  terminal_title: true, terminal_title_stripped: true, revision: true,
} satisfies Record<keyof HerdrPaneInfo, true>;

const DECLARED_SNAPSHOT_FLAGS = {
  workspaces: true, tabs: true, panes: true, agents: true,
} satisfies Record<keyof HerdrSessionSnapshot, true>;

test("TabInfo declares every field the installed herdr sends", async () => {
  const schema = await liveSchema();
  const actual = Object.keys(schema.schemas.success_response.$defs.TabInfo.properties);
  for (const field of Object.keys(DECLARED_TAB_FLAGS)) {
    expect(actual).toContain(field);
  }
});

test("PaneInfo models every field paddock reads, and names the rest", async () => {
  const schema = await liveSchema();
  const actual = Object.keys(schema.schemas.success_response.$defs.PaneInfo.properties);
  for (const field of Object.keys(DECLARED_PANE_FLAGS)) {
    expect(actual).toContain(field);
  }
});

test("SessionSnapshot carries the four collections the tree is built from", async () => {
  const schema = await liveSchema();
  const actual = Object.keys(schema.schemas.success_response.$defs.SessionSnapshot.properties);
  for (const field of Object.keys(DECLARED_SNAPSHOT_FLAGS)) {
    expect(actual).toContain(field);
  }
});
```

If `liveSchema()` does not already exist in that file, reuse whatever helper the existing tests use to read `herdr api schema --json`; do not add a second one.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/herdr-schema-drift.test.ts`
Expected: FAIL — `HerdrTabInfo` and friends are not exported from `@shared/herdr-api`.

- [ ] **Step 3: Add the interfaces to the generator template**

In `scripts/gen-herdr-types.ts`, inside the `out` template literal and **before** the `HerdrRequest` block at the end, insert:

```ts
/** One entry from `session.snapshot` -> result.snapshot.workspaces[].
 *
 * Richer than \`HerdrWorkspaceRaw\`, which models only what \`workspace.list\`
 * needed for labelling. The rollup \`agent_status\`, \`pane_count\` and
 * \`tab_count\` are what let the Spaces screen show a space's shape without
 * walking its children.
 */
export interface HerdrWorkspaceInfo {
  workspace_id: string;
  label?: string | null;
  number: number;
  active_tab_id?: string | null;
  agent_status: HerdrAgentStatus;
  pane_count: number;
  tab_count: number;
  focused: boolean;
}

/** One entry from \`session.snapshot\` -> result.snapshot.tabs[].
 *
 * \`label\` is the tab's NUMBER as a string when the operator has never named
 * it, so "1" means unnamed rather than named "1". \`tree.ts\` is where that is
 * normalised; nothing else may assume it.
 */
export interface HerdrTabInfo {
  tab_id: string;
  workspace_id: string;
  label?: string | null;
  number: number;
  agent_status: HerdrAgentStatus;
  pane_count: number;
  focused: boolean;
}

/** One entry from \`session.snapshot\` -> result.snapshot.panes[].
 *
 * Carries NO \`name\`: only \`agent.list\` does, which is why
 * docs/gotchas.md forbids labelling from this. \`label\` is a DIFFERENT field
 * that \`agent.list\` does not read — see the design doc §14.3 before using it.
 */
export interface HerdrPaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string | null;
  agent_status: HerdrAgentStatus;
  cwd: string;
  focused: boolean;
  label?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  revision: number;
}

/** \`session.snapshot\` -> result.snapshot. The whole tree in one call. */
export interface HerdrSessionSnapshot {
  workspaces: HerdrWorkspaceInfo[];
  tabs: HerdrTabInfo[];
  panes: HerdrPaneInfo[];
  agents: HerdrAgentRaw[];
}
```

- [ ] **Step 4: Regenerate and typecheck**

Run: `make types && make check`
Expected: `src/shared/herdr-api.d.ts` gains the four interfaces; `tsc --noEmit` passes.

- [ ] **Step 5: Run the drift test**

Run: `bun test tests/herdr-schema-drift.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add scripts/gen-herdr-types.ts src/shared/herdr-api.d.ts tests/herdr-schema-drift.test.ts
git commit -m "types: declare herdr's session snapshot, so the tree sits inside the drift guarantee"
```

---

## Task 3: The `SpaceTree` contract

**Files:**
- Modify: `src/shared/types.ts`
- Test: `tests/tree-contract.test.ts` (create)

**Interfaces:**
- Consumes: `AgentState` from `@shared/types`.
- Produces: `SpaceTree`, `Space`, `Tab`, `TreePane` from `@shared/types`.

- [ ] **Step 1: Write the failing test**

Create `tests/tree-contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { SpaceTree, TreePane } from "@shared/types";

test("a shell pane carries a null state, not idle", () => {
  const shell: TreePane = {
    paneId: "w1:p2", harness: null, name: null,
    title: "bash", cwd: "/srv/project", state: null,
  };
  // The whole point: a shell is not idle. Nothing may coerce this to a state.
  expect(shell.state).toBeNull();
  expect(shell.harness).toBeNull();
});

test("a tree records when it was read", () => {
  const tree: SpaceTree = { spaces: [], readAt: 1_700_000_000_000 };
  expect(tree.readAt).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tree-contract.test.ts`
Expected: FAIL — `SpaceTree` is not exported from `@shared/types`.

- [ ] **Step 3: Add the interfaces**

Append to `src/shared/types.ts` the four interfaces exactly as written in spec §4, comments intact. Do not abbreviate the comments — they carry the reasoning for `state: AgentState | null` and for `Tab.label`.

- [ ] **Step 4: Run the test**

Run: `bun test tests/tree-contract.test.ts && make check`
Expected: PASS, and `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/shared/types.ts tests/tree-contract.test.ts
git commit -m "types: a SpaceTree, where a shell's state is null rather than idle"
```

---

## Task 4: `tree.ts` — shape the snapshot

**Files:**
- Create: `src/server/herdr/tree.ts`
- Create: `tests/fixtures/session-snapshot.json`
- Test: `tests/tree.test.ts` (create)

**Interfaces:**
- Consumes: `HerdrSessionSnapshot` (Task 2), `SpaceTree` (Task 3).
- Produces: `export function toSpaceTree(snap: HerdrSessionSnapshot, now: number): SpaceTree`

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/session-snapshot.json`. **Invented names only** — this must never be a captured real snapshot:

```json
{
  "workspaces": [
    {"workspace_id":"w1","label":"api-refactor","number":1,"active_tab_id":"w1:t1","agent_status":"working","pane_count":1,"tab_count":1,"focused":false},
    {"workspace_id":"w2","label":"schema-migration","number":2,"active_tab_id":"w2:t1","agent_status":"working","pane_count":2,"tab_count":2,"focused":true},
    {"workspace_id":"w3","label":"docs-cleanup","number":3,"active_tab_id":"w3:t1","agent_status":"unknown","pane_count":1,"tab_count":1,"focused":false}
  ],
  "tabs": [
    {"tab_id":"w1:t1","workspace_id":"w1","label":"1","number":1,"agent_status":"working","pane_count":1,"focused":false},
    {"tab_id":"w2:t1","workspace_id":"w2","label":"migrate-up","number":1,"agent_status":"working","pane_count":1,"focused":true},
    {"tab_id":"w2:t2","workspace_id":"w2","label":"2","number":2,"agent_status":"idle","pane_count":1,"focused":false},
    {"tab_id":"w3:t1","workspace_id":"w3","label":"1","number":1,"agent_status":"unknown","pane_count":1,"focused":false}
  ],
  "panes": [
    {"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","agent":"claude","agent_status":"working","cwd":"/srv/project","focused":false,"terminal_title":"api-refactor","terminal_title_stripped":"api-refactor","revision":3},
    {"pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","agent":"codex","agent_status":"working","cwd":"/srv/project","focused":true,"terminal_title":"migrating","terminal_title_stripped":"migrating","revision":7},
    {"pane_id":"w2:p2","workspace_id":"w2","tab_id":"w2:t2","agent":"claude","agent_status":"idle","cwd":"/srv/project","focused":false,"terminal_title":"backfill","terminal_title_stripped":"backfill","revision":2},
    {"pane_id":"w3:p1","workspace_id":"w3","tab_id":"w3:t1","agent_status":"unknown","cwd":"/srv/project","focused":false,"terminal_title":"bash","terminal_title_stripped":"bash","revision":1}
  ],
  "agents": [
    {"pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","terminal_id":"t_a","agent":"claude","agent_status":"working","cwd":"/srv/project","focused":false,"name":"api-refactor","revision":3},
    {"pane_id":"w2:p1","workspace_id":"w2","tab_id":"w2:t1","terminal_id":"t_b","agent":"codex","agent_status":"working","cwd":"/srv/project","focused":true,"name":"schema-migration","revision":7},
    {"pane_id":"w2:p2","workspace_id":"w2","tab_id":"w2:t2","terminal_id":"t_c","agent":"claude","agent_status":"idle","cwd":"/srv/project","focused":false,"name":"schema-migration-2","revision":2}
  ]
}
```

Note `w3:p1`: a pane with no `agent` key, in a space whose rollup is `unknown`. That is the shell case, and it is the row paddock cannot see today.

- [ ] **Step 2: Write the failing test**

Create `tests/tree.test.ts`:

```ts
import { expect, test } from "bun:test";
import { toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot } from "@shared/herdr-api";
import snapshot from "./fixtures/session-snapshot.json";

const NOW = 1_700_000_000_000;
const tree = () => toSpaceTree(snapshot as unknown as HerdrSessionSnapshot, NOW);

test("every space in the snapshot reaches the tree", () => {
  expect(tree().spaces.map((s) => s.spaceId)).toEqual(["w1", "w2", "w3"]);
});

test("a pane with no agent survives, with a null harness and a null state", () => {
  const shell = tree().spaces.find((s) => s.spaceId === "w3")!.tabs[0]!.panes[0]!;
  expect(shell.paneId).toBe("w3:p1");
  expect(shell.harness).toBeNull();
  expect(shell.state).toBeNull();
  expect(shell.name).toBeNull();
  // Its only label is the terminal title.
  expect(shell.title).toBe("bash");
});

test("an agent pane carries agent.list's name, never the pane's title", () => {
  const pane = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!.panes[0]!;
  expect(pane.name).toBe("api-refactor");
  expect(pane.harness).toBe("claude");
  expect(pane.state).toBe("working");
});

test("an unnamed tab reports a null label, not its number as a string", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w1")!.tabs[0]!;
  expect(t.label).toBeNull();
});

test("a named tab keeps its label", () => {
  const t = tree().spaces.find((s) => s.spaceId === "w2")!.tabs.find((x) => x.tabId === "w2:t1")!;
  expect(t.label).toBe("migrate-up");
});

test("counts come from herdr rather than being recomputed", () => {
  const w2 = tree().spaces.find((s) => s.spaceId === "w2")!;
  expect(w2.tabCount).toBe(2);
  expect(w2.paneCount).toBe(2);
});

test("readAt is the clock passed in, so the UI can say how stale it is", () => {
  expect(tree().readAt).toBe(NOW);
});

test("a pane whose tab is missing from the snapshot is dropped, not orphaned", () => {
  const broken = {
    ...(snapshot as any),
    panes: [...(snapshot as any).panes, { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", agent_status: "idle", cwd: "/srv/project", focused: false, revision: 1 }],
  };
  const spaces = toSpaceTree(broken as HerdrSessionSnapshot, NOW).spaces;
  expect(spaces.map((s) => s.spaceId)).not.toContain("w9");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test tests/tree.test.ts`
Expected: FAIL — cannot resolve `@server/herdr/tree`.

- [ ] **Step 4: Implement `tree.ts`**

Create `src/server/herdr/tree.ts`:

```ts
import type {
  HerdrAgentRaw, HerdrPaneInfo, HerdrSessionSnapshot, HerdrTabInfo,
} from "@shared/herdr-api";
import type { AgentState, Space, SpaceTree, Tab, TreePane } from "@shared/types";

/**
 * Shape one `session.snapshot` into the tree the Spaces screen renders.
 *
 * The ONLY module that knows the snapshot's field names — the same
 * containment rule 2 places on `adapter.ts`. It deliberately does not import
 * `state/store.ts` or `ws/hub.ts`: the tree is read on demand and never
 * replicated into paddock's state, so that a browse feature cannot reach the
 * delta path the notifier rides on.
 */
export function toSpaceTree(snap: HerdrSessionSnapshot, now: number): SpaceTree {
  // agent.list's `name` is the ONLY source of an operator label. pane rows
  // carry a `label`, which is a different field that agent.list does not read
  // — see the design doc §14.3. Keyed by pane_id because that is the identity
  // paddock uses for an agent throughout.
  const named = new Map<string, HerdrAgentRaw>();
  for (const a of snap.agents) named.set(a.pane_id, a);

  const panesByTab = new Map<string, TreePane[]>();
  for (const p of snap.panes) {
    const list = panesByTab.get(p.tab_id) ?? [];
    list.push(toPane(p, named.get(p.pane_id)));
    panesByTab.set(p.tab_id, list);
  }

  const tabsBySpace = new Map<string, Tab[]>();
  for (const t of snap.tabs) {
    const list = tabsBySpace.get(t.workspace_id) ?? [];
    list.push({ tabId: t.tab_id, label: tabLabel(t), panes: panesByTab.get(t.tab_id) ?? [] });
    tabsBySpace.set(t.workspace_id, list);
  }

  // Driven from `snap.workspaces`, so a pane referencing a workspace the
  // snapshot does not list is dropped rather than inventing a space with no
  // label, no counts and no honest identity.
  const spaces: Space[] = snap.workspaces.map((w) => ({
    spaceId: w.workspace_id,
    label: w.label?.trim() || null,
    tabCount: w.tab_count,
    paneCount: w.pane_count,
    tabs: tabsBySpace.get(w.workspace_id) ?? [],
  }));

  return { spaces, readAt: now };
}

/**
 * herdr reports an unnamed tab's label as its NUMBER, as a string ("1").
 * Normalised to null here, and nowhere else, so no consumer has to know that
 * a tab called "1" is probably a tab called nothing.
 */
function tabLabel(t: HerdrTabInfo): string | null {
  const label = t.label?.trim();
  if (!label) return null;
  return label === String(t.number) ? null : label;
}

function toPane(p: HerdrPaneInfo, agent: HerdrAgentRaw | undefined): TreePane {
  return {
    paneId: p.pane_id,
    harness: p.agent?.trim() || null,
    name: agent?.name?.trim() || null,
    title: (p.terminal_title_stripped ?? p.terminal_title ?? "").trim() || null,
    cwd: p.cwd ?? "",
    // Null when there is no harness. A shell is not idle: it has no triage
    // state at all, and inventing one would file it under a section it does
    // not belong in.
    state: p.agent ? toState(p.agent_status) : null,
  };
}

/** Same narrowing `adapter.ts` applies: an unrenderable status is not a state. */
function toState(status: string): AgentState | null {
  return status === "blocked" || status === "done" || status === "working" || status === "idle"
    ? status
    : null;
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/tree.test.ts && make check`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/server/herdr/tree.ts tests/tree.test.ts tests/fixtures/session-snapshot.json
git commit -m "feat: shape herdr's session snapshot into a tree, including the panes paddock drops"
```

---

## Task 5: `GET /api/spaces`

**Files:**
- Modify: `src/server/routes.ts`
- Test: `tests/spaces-route.test.ts` (create)

**Interfaces:**
- Consumes: `toSpaceTree` (Task 4).
- Produces: `AppDeps.readTree?: () => Promise<SpaceTree>`; route `GET /api/spaces`.

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-route.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { SpaceTree } from "@shared/types";

const NOW = 1_700_000_000_000;

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "api-refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
    ] }],
  }],
};

function harness(readTree?: () => Promise<SpaceTree>) {
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    readTree,
    health: () => ({ ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
}

test("GET /api/spaces returns the tree", async () => {
  const res = await harness(async () => TREE).request("/api/spaces");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(TREE);
});

test("without a herdr reader the route 404s honestly, like the action routes in demo mode", async () => {
  const res = await harness(undefined).request("/api/spaces");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
});

test("a herdr failure surfaces, and is never reported as an empty tree", async () => {
  const res = await harness(async () => { throw new Error("socket refused"); }).request("/api/spaces");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("socket refused");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/spaces-route.test.ts`
Expected: FAIL — `readTree` is not a known `AppDeps` property; route 404s via the catch-all.

- [ ] **Step 3: Implement**

In `src/server/routes.ts`, add to the `AppDeps` interface:

```ts
  /**
   * Reads herdr's whole session tree. Absent in --demo, exactly like
   * `actions`: the route then 404s honestly rather than synthesising a tree
   * from fake agents.
   */
  readTree?: () => Promise<SpaceTree>;
```

Import `SpaceTree` from `@shared/types`, then register beside `GET /api/agents`:

```ts
  /**
   * The whole herdr session, read on demand.
   *
   * A GET, and that does not breach "never put payloads in a GET query
   * string": this request has no parameters at all. The tree is deliberately
   * NOT held in `state/store.ts` — see the design doc §5.2.
   *
   * An empty tree and a broken herdr must never look alike, so a failure is a
   * 502 carrying herdr's own message rather than `{spaces: []}`.
   */
  app.get("/api/spaces", async (c) => {
    if (!deps.readTree) {
      return c.json({ ok: false, detail: "herdr is not connected; no tree to read" }, 404);
    }
    try {
      return c.json(await deps.readTree());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warn(`spaces: could not read the herdr session: ${detail}`);
      return c.json({ ok: false, detail }, 502);
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/spaces-route.test.ts && make check`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it in `index.ts`**

In `src/server/index.ts`, where `actions` is constructed for the non-demo branch, also pass:

```ts
    readTree: async () => toSpaceTree(
      (await client.request<{ snapshot: HerdrSessionSnapshot }>("session.snapshot", {})).snapshot,
      Date.now(),
    ),
```

Leave the `--demo` branch without `readTree`, so the route 404s there — the same honesty `/output` already has.

- [ ] **Step 6: Verify against a live herdr**

Run: `make dev`, then in another shell: `curl -s localhost:8787/api/spaces | head -c 300`
Expected: JSON with a `spaces` array and a `readAt`. Confirm at least one pane has `"harness": null` if you have a shell pane open.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/server/routes.ts src/server/index.ts tests/spaces-route.test.ts
git commit -m "feat: GET /api/spaces, where a broken herdr is a 502 and never an empty tree"
```

---

## Task 6: `tree-stale` on the wire

**Files:**
- Modify: `src/shared/types.ts`, `src/server/ws/hub.ts`, `src/web/store.ts`
- Test: `tests/tree-stale.test.ts` (create)

**Interfaces:**
- Consumes: `ServerMessage` from `@shared/types`.
- Produces: `Hub.queueTreeStale(): void`; `ClientState.treeStaleAt: number`.

> **The trap:** `applyMessage` in `src/web/store.ts` handles `snapshot` and `heartbeat`, then **falls through and treats everything else as a delta**, reading `msg.upserted`. Adding a variant without a guard before that fall-through throws on `for (const a of undefined)`. Step 1 tests exactly that.

- [ ] **Step 1: Write the failing test**

Create `tests/tree-stale.test.ts`:

```ts
import { expect, test } from "bun:test";
import { applyMessage } from "@web/store";
import { Hub } from "@server/ws/hub";
import type { ClientState } from "@web/store";

const NOW = 1_700_000_000_000;

const base = (): ClientState => ({
  agents: [], hostId: null, connected: true, lastMessageAt: NOW,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null,
  treeStaleAt: 0,
});

test("a tree-stale frame does not crash the delta fall-through", () => {
  const next = applyMessage(base(), { type: "tree-stale", serverTime: NOW + 5 });
  expect(next.treeStaleAt).toBe(NOW + 5);
});

test("tree-stale never touches the agent list", () => {
  const state = { ...base(), agents: [{ agentId: "w1:p1" } as never] };
  const next = applyMessage(state, { type: "tree-stale", serverTime: NOW + 5 });
  expect(next.agents).toBe(state.agents);
});

test("tree-stale counts as liveness", () => {
  const next = applyMessage(base(), { type: "tree-stale", serverTime: NOW + 9 });
  expect(next.lastMessageAt).toBe(NOW + 9);
});

test("the hub sends one tree-stale frame per call", () => {
  const sent: string[] = [];
  const hub = new Hub({ now: () => NOW });
  hub.add({ send: (d) => sent.push(d) });
  sent.length = 0; // ignore anything `add` may emit on join
  hub.queueTreeStale();
  const frames = sent.map((s) => JSON.parse(s)).filter((f) => f.type === "tree-stale");
  expect(frames).toHaveLength(1);
});
```

If `ClientState` has fields beyond those in `base()`, add them — do not delete any.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tree-stale.test.ts`
Expected: FAIL — `tree-stale` is not a `ServerMessage` variant.

- [ ] **Step 3: Add the variant**

In `src/shared/types.ts`, add to the `ServerMessage` union:

```ts
  /**
   * "The session tree changed — refetch it if you are looking at it."
   *
   * Payload-free by design. The tree is read on demand (design doc §5.2), so
   * this is an INVALIDATION, not a delivery: sending the tree here would
   * replicate it onto the delta path, which is exactly what §3 refuses.
   *
   * Its own variant rather than an empty delta, for the same reason
   * `heartbeat` is: a delta states "these agents changed", and a client is
   * entitled to believe it.
   */
  | { type: "tree-stale"; serverTime: number }
```

- [ ] **Step 4: Handle it in the client, before the fall-through**

In `src/web/store.ts`, add `treeStaleAt: number` to `ClientState` (initial value `0`), and insert **immediately after the `heartbeat` block and before `const byId = ...`**:

```ts
  // BEFORE the delta fall-through below, which reads `msg.upserted`
  // unconditionally: an unhandled variant would throw there rather than being
  // ignored. Bumps a counter the Spaces screen watches; the agent list is
  // returned by identity so nothing re-renders that does not care.
  if (msg.type === "tree-stale") {
    return { ...state, treeStaleAt: msg.serverTime, lastMessageAt: msg.serverTime };
  }
```

- [ ] **Step 5: Add `queueTreeStale` to the hub**

In `src/server/ws/hub.ts`:

```ts
  /**
   * Tell every browser the session tree moved.
   *
   * Sent immediately rather than through the coalescing buffer: it carries no
   * payload to merge, and a structural change is rare enough that batching
   * buys nothing.
   */
  queueTreeStale(): void {
    this.broadcast(JSON.stringify({ type: "tree-stale", serverTime: this.now() }));
  }
```

Use whatever the existing private fan-out helper is called; do not add a second one.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/tree-stale.test.ts && make check`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/shared/types.ts src/web/store.ts src/server/ws/hub.ts tests/tree-stale.test.ts
git commit -m "feat: a tree-stale frame that invalidates rather than delivers"
```

---

## Task 7: Subscribe to the structural events

**Depends on Task 1's measured names.** Use the pairs recorded in `docs/probes/2026-08-25-structural-events.md` verbatim.

**Files:**
- Modify: `src/server/herdr/socket.ts`, `src/server/supervisor.ts`
- Test: `tests/tree-invalidation.test.ts` (create)

**Interfaces:**
- Consumes: `Hub.queueTreeStale` (Task 6).
- Produces: `SupervisorOptions.onTreeStale?: () => void`; `STRUCTURAL_SUBSCRIPTIONS`.

- [ ] **Step 1: Write the failing test**

Create `tests/tree-invalidation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Supervisor } from "@server/supervisor";
import { AgentStore } from "@server/state/store";

const NOW = 1_700_000_000_000;

function harness() {
  const stale: string[] = [];
  const subs: unknown[] = [];
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "agent.list") return { agents: [] } as T;
      if (method === "workspace.list") return { workspaces: [] } as T;
      return {} as T;
    },
    async openStream(s: unknown[]) { subs.push(...s); },
  };
  const sup = new Supervisor({
    client, store: new AgentStore("dev-box"), now: () => NOW,
    onDelta: () => {}, onTreeStale: () => stale.push("stale"),
  });
  return { sup, stale, subs, client };
}

test("a renamed tab invalidates the tree", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "tab_renamed", data: {} });
  expect(stale).toEqual(["stale"]);
});

test("a rollup-only event does NOT invalidate, or every agent state change would refetch", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "workspace_updated", data: {} });
  sup.handleEvent({ event: "workspace_metadata_updated", data: {} });
  expect(stale).toEqual([]);
});

test("a shell becoming an agent invalidates, reusing a subscription paddock already has", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "pane_agent_detected", data: {} });
  expect(stale).toEqual(["stale"]);
});
```

Adapt `handleEvent`/`start` to the supervisor's real method names — read `src/server/supervisor.ts` first. If event dispatch is private, expose the smallest seam that makes it testable rather than reaching into internals.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/tree-invalidation.test.ts`
Expected: FAIL — `onTreeStale` is not a `SupervisorOptions` property.

- [ ] **Step 3: Add the name constants**

In `src/server/herdr/socket.ts`, beside the existing four pairs, using **Task 1's measured spellings**:

```ts
/** Delivered names for structural changes — match incoming events on these. */
export const EVENT_WORKSPACE_CREATED = "workspace_created";
export const EVENT_WORKSPACE_CLOSED = "workspace_closed";
export const EVENT_WORKSPACE_RENAMED = "workspace_renamed";
export const EVENT_TAB_CREATED = "tab_created";
export const EVENT_TAB_CLOSED = "tab_closed";
export const EVENT_TAB_RENAMED = "tab_renamed";

/**
 * Structure only.
 *
 * `workspace.updated` and `workspace.metadata_updated` are deliberately
 * ABSENT: a space's rollup `agent_status` moves on those, so subscribing
 * would turn invalidation into a refetch on every agent state change —
 * strictly worse than having none.
 */
export const STRUCTURAL_SUBSCRIPTIONS: Subscription[] = [
  { type: "workspace.created" }, { type: "workspace.closed" }, { type: "workspace.renamed" },
  { type: "tab.created" }, { type: "tab.closed" }, { type: "tab.renamed" },
];
```

- [ ] **Step 4: Wire the supervisor**

Add `onTreeStale?: () => void` to `SupervisorOptions`. Append `STRUCTURAL_SUBSCRIPTIONS` to what `resubscribe` opens. In the event handler, fire `onTreeStale` for the six structural events **and** for the three paddock already receives (`pane_agent_detected`, `pane_closed`, `pane_exited`) — those change the tree too and cost nothing extra.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/tree-invalidation.test.ts && make check`
Expected: PASS, 3 tests.

- [ ] **Step 6: Wire in `index.ts`**

Pass `onTreeStale: () => hub.queueTreeStale()` where the supervisor is constructed. In `--demo`, leave it unset.

- [ ] **Step 7: Verify live**

Run `make dev`, open the browser devtools Network → WS, then create a tab in herdr.
Expected: a `{"type":"tree-stale"}` frame arrives. Then change an agent's state and confirm **no** `tree-stale` follows.

- [ ] **Step 8: Commit**

```bash
make check-clean
git add src/server/herdr/socket.ts src/server/supervisor.ts src/server/index.ts tests/tree-invalidation.test.ts
git commit -m "feat: invalidate the tree on structure, never on state"
```

---

## Task 8: `fetchSpaceTree` on the client

**Files:**
- Modify: `src/web/api.ts`
- Test: `tests/spaces-api.test.ts` (create)

**Interfaces:**
- Consumes: `SpaceTree` (Task 3), `Fetch` from `@web/api`.
- Produces: `export async function fetchSpaceTree(f?: Fetch): Promise<SpaceTree>`

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-api.test.ts`:

```ts
import { expect, test } from "bun:test";
import { fetchSpaceTree } from "@web/api";
import type { Fetch } from "@web/api";

const TREE = { spaces: [], readAt: 1 };

test("a 200 resolves with the tree", async () => {
  const f: Fetch = async () => new Response(JSON.stringify(TREE), { status: 200 });
  expect(await fetchSpaceTree(f)).toEqual(TREE);
});

test("a 404 rejects with the server's detail rather than resolving empty", async () => {
  const f: Fetch = async () =>
    new Response(JSON.stringify({ ok: false, detail: "herdr is not connected; no tree to read" }), { status: 404 });
  await expect(fetchSpaceTree(f)).rejects.toThrow("herdr is not connected");
});

test("it is a GET and sends no body", async () => {
  let seen: RequestInit | undefined;
  const f: Fetch = async (_p, init) => { seen = init; return new Response(JSON.stringify(TREE)); };
  await fetchSpaceTree(f);
  expect(seen?.method ?? "GET").toBe("GET");
  expect(seen?.body).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/spaces-api.test.ts`
Expected: FAIL — `fetchSpaceTree` is not exported.

- [ ] **Step 3: Implement**

Append to `src/web/api.ts`:

```ts
/**
 * The session tree. A GET with no body — the only read here that is not a
 * POST, because it has no payload to keep out of an access log.
 *
 * Rejects on non-2xx rather than resolving, for the reason `readJson`
 * records: a 404 body has no `spaces`, and resolving with it would hand the
 * caller an object TypeScript believes is a SpaceTree and isn't.
 */
export async function fetchSpaceTree(f: Fetch = fetch): Promise<SpaceTree> {
  const res = await f("/api/spaces", { method: "GET" });
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new Error(detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as SpaceTree;
}
```

Add `SpaceTree` to the type import at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/spaces-api.test.ts && make check`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/api.ts tests/spaces-api.test.ts
git commit -m "feat: fetch the session tree, rejecting rather than resolving empty"
```

---

## Task 9: The Spaces screen

**Files:**
- Create: `src/web/components/Spaces.tsx`, `src/web/components/SpaceRow.tsx`
- Modify: `src/web/route.ts`, `src/web/components/App.tsx`, `src/web/components/HostHeader.tsx`
- Test: `tests/spaces-screen.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchSpaceTree` (Task 8), `treeStaleAt` (Task 6), `StatusDot`.
- Produces: `<Spaces onBack={() => void} />`; `useSpacesRoute(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/spaces-screen.test.tsx`:

```tsx
import "./support/dom";
import { expect, test } from "bun:test";
import { render, settle, unmount } from "./support/render";
import { Spaces } from "@web/components/Spaces";
import type { SpaceTree } from "@shared/types";

const FLAT: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w1", label: "api-refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
    ] }],
  }],
};

const STRUCTURED: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w2", label: "schema-migration", tabCount: 2, paneCount: 2,
    tabs: [
      { tabId: "w2:t1", label: "migrate-up", panes: [{ paneId: "w2:p1", harness: "codex", name: "schema-migration", title: "m", cwd: "/srv/project", state: "working" }] },
      { tabId: "w2:t2", label: null, panes: [{ paneId: "w2:p2", harness: "claude", name: "schema-migration-2", title: "b", cwd: "/srv/project", state: "idle" }] },
    ],
  }],
};

const SHELL: SpaceTree = {
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w3", label: "docs-cleanup", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w3:t1", label: null, panes: [
      { paneId: "w3:p1", harness: null, name: null, title: "bash", cwd: "/srv/project", state: null },
    ] }],
  }],
};

const load = (t: SpaceTree) => async () => t;

test("a 1:1:1 space renders as ONE row with nothing to expand", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(FLAT)} />);
  await settle();
  expect(el.textContent).toContain("api-refactor");
  expect(el.querySelectorAll("[data-space-row]")).toHaveLength(1);
  expect(el.querySelector("[data-expand]")).toBeNull();
  unmount();
});

test("a space with two tabs renders sub-rows", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(STRUCTURED)} />);
  await settle();
  expect(el.querySelectorAll("[data-pane-row]")).toHaveLength(2);
  expect(el.textContent).toContain("migrate-up");
  unmount();
});

test("a pane with no agent is shown, and never labelled with a state", async () => {
  const el = await render(<Spaces onBack={() => {}} load={load(SHELL)} />);
  await settle();
  const row = el.querySelector("[data-pane-row]")!;
  expect(row.textContent).toContain("bash");
  expect(row.textContent).not.toContain("idle");
  expect(row.getAttribute("data-state")).toBe("none");
  unmount();
});

test("a failed read is surfaced, never rendered as an empty session", async () => {
  const el = await render(<Spaces onBack={() => {}} load={async () => { throw new Error("socket refused"); }} />);
  await settle();
  expect(el.textContent).toContain("socket refused");
  expect(el.textContent).not.toContain("No spaces");
  unmount();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/spaces-screen.test.tsx`
Expected: FAIL — cannot resolve `@web/components/Spaces`.

- [ ] **Step 3: Implement `SpaceRow.tsx`**

```tsx
import { paneHash } from "@shared/route";
import type { Space, TreePane } from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * One space, and its panes only when there is something to show.
 *
 * "Structured" means more than one pane or more than one tab. A space with
 * one tab and one pane has neither, so it renders as a SINGLE row with no
 * chevron — there is nothing to expand, and offering a control that reveals
 * nothing is worse than offering none. Most spaces are that shape.
 */
export function SpaceRow({ space, open, onToggle }: {
  space: Space;
  open: boolean;
  onToggle: () => void;
}) {
  const panes = space.tabs.flatMap((t) => t.panes);
  const structured = panes.length > 1 || space.tabs.length > 1;
  const only = !structured ? panes[0] ?? null : null;

  return (
    <li data-space-row data-space-id={space.spaceId}>
      <div className="space-head">
        {structured && (
          <button
            data-expand
            type="button"
            aria-expanded={open}
            onClick={onToggle}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="sr-only">{open ? "Collapse" : "Expand"} {space.label ?? space.spaceId}</span>
          </button>
        )}
        {/* A merged row shows the single pane's state; a structured one shows
            nothing here, because its panes each carry their own below and a
            rollup would say the same thing twice. */}
        {only && <PaneMarker pane={only} />}
        <span className="space-name">{space.label ?? space.spaceId}</span>
        {structured
          ? <span className="space-count">{space.tabCount} tabs</span>
          : only && <PaneState pane={only} />}
        {/* Inert here. Plan 2 opens the actions sheet from it. Rendered now so
            the row's layout is settled and the affordance is VISIBLE — an
            unhinted long-press is the touch equivalent of a hover-only
            control, which the UI rules ban. */}
        <button type="button" className="row-more" disabled aria-label={`Actions for ${space.label ?? space.spaceId}`}>⋯</button>
      </div>

      {structured && open && (
        <ul className="space-tabs">
          {space.tabs.map((t) => (
            <li key={t.tabId}>
              {/* An unnamed tab has no heading of its own: "1" is not a name,
                  and a heading that repeats the row below is noise. */}
              {t.label !== null && <h3 className="tab-name">{t.label}</h3>}
              <ul>
                {t.panes.map((p) => (
                  <li key={p.paneId} data-pane-row data-state={p.state ?? "none"}>
                    <a href={paneHash(p.paneId)}>
                      <PaneMarker pane={p} />
                      <span className="pane-name">{p.name ?? p.title ?? p.paneId}</span>
                      <PaneState pane={p} />
                    </a>
                    <button type="button" className="row-more" disabled aria-label={`Actions for ${p.name ?? p.paneId}`}>⋯</button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A shell has no state, so it gets no StatusDot — that component's whole
 *  contract is that a dot MEANS one of four states. */
function PaneMarker({ pane }: { pane: TreePane }) {
  if (pane.state === null) return <span className="dot-none" aria-hidden="true" />;
  return <StatusDot state={pane.state} />;
}

/** Colour is never the only channel — StatusDot is aria-hidden, so the state
 *  has to be readable as text right here. */
function PaneState({ pane }: { pane: TreePane }) {
  return <span className="pane-state">{pane.state ?? "no agent"}</span>;
}
```

- [ ] **Step 4: Implement `Spaces.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { SpaceRow } from "@web/components/SpaceRow";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

const COLLAPSED_KEY = "paddock.spaces.collapsed";

/**
 * `load` is injected so the tests can drive this without a network, and so a
 * failure is a value this component renders rather than a thrown promise.
 */
export function Spaces({ onBack, load = fetchSpaceTree }: {
  onBack: () => void;
  load?: () => Promise<SpaceTree>;
}) {
  const { treeStaleAt } = useStore();
  const [tree, setTree] = useState<SpaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const refresh = useCallback(async () => {
    try {
      setTree(await load());
      setError(null);
    } catch (err) {
      // The last good tree is KEPT. An empty screen and a broken herdr must
      // never look alike — that is the same rule the 502 in the route serves.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  // Refetches on mount and whenever the server says the tree moved. The
  // server sends `tree-stale` for STRUCTURE only, so this does not fire on
  // every agent state change.
  useEffect(() => { void refresh(); }, [refresh, treeStaleAt]);

  // The "as of" label ticks locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const toggle = (spaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) next.delete(spaceId); else next.add(spaceId);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  };

  return (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="spaces-head">
        <button type="button" onClick={onBack}>Back</button>
        <h2>Spaces</h2>
      </header>

      {error !== null && <p className="error" role="alert">{error}</p>}

      {tree !== null && (
        <ul className="spaces">
          {tree.spaces.map((s) => (
            <SpaceRow
              key={s.spaceId}
              space={s}
              // Defaults to OPEN, for the reason App.tsx gives for idleOpen: a
              // collapsed group shows a count where it could show its
              // contents, and revealing structure is this screen's whole job.
              open={!collapsed.has(s.spaceId)}
              onToggle={() => toggle(s.spaceId)}
            />
          ))}
        </ul>
      )}

      {tree !== null && (
        <footer className="spaces-foot">
          <span>{tree.spaces.length} spaces</span>
          {/* Says WHEN it read, because this screen is on-demand and an
              implied-live one would be a guess rendered as a fact. */}
          <button type="button" onClick={() => void refresh()}>
            as of {Math.max(0, Math.round((now - tree.readAt) / 1000))}s ago ⟳
          </button>
        </footer>
      )}
    </main>
  );
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
```

Add the classes used above to `src/web/styles.css`. **Every colour token goes on bare `:root` first**, then is redefined under `prefers-color-scheme` and `[data-theme]` — never defined only inside a media query. `.dot-none` is a hollow dashed ring in `--fg-dim`, visually distinct from `StatusDot`'s hollow `idle` ring.

- [ ] **Step 5: Route it**

Add `useSpacesRoute()` to `src/web/route.ts` matching `#/spaces` (mirror `useSettingsRoute`). In `App.tsx`, add the early return **beside the settings one**:

```tsx
  if (showSpaces) return <Spaces onBack={() => { location.hash = ""; }} />;
```

Add a control to `HostHeader.tsx` linking to `#/spaces`, beside the settings control.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/spaces-screen.test.tsx && make check`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify in a browser**

Run `make dev`, open `#/spaces` at a 390px viewport.
Expected: flat spaces are single rows; a space with two tabs shows sub-rows; a shell pane appears; the footer shows `as of Ns ago`. Confirm the page does not scroll horizontally.

- [ ] **Step 8: Commit**

```bash
make check-clean
git add src/web/components/Spaces.tsx src/web/components/SpaceRow.tsx src/web/route.ts src/web/components/App.tsx src/web/components/HostHeader.tsx tests/spaces-screen.test.tsx
git commit -m "feat: a Spaces screen where a flat space is one row, because most of them are"
```

---

## Task 10: Read a pane with no agent

**Files:**
- Modify: `src/server/herdr/actions.ts`, `src/server/routes.ts`
- Test: `tests/pane-read.test.ts` (create)

**Interfaces:**
- Consumes: `HerdrPaneRead` from `@shared/herdr-api`.
- Produces: `HerdrActions.readPane(paneId: string): Promise<{ lines: string[]; source: ReadSource }>`; `resolveSource(state: AgentState | null, scrollback: boolean)`.

- [ ] **Step 1: Write the failing test**

Create `tests/pane-read.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolveSource } from "@server/herdr/actions";

test("a shell always gets scrollback: it is on the normal screen and costs ~2ms", () => {
  expect(resolveSource(null, false)).toBe("recent_unwrapped");
  expect(resolveSource(null, true)).toBe("recent_unwrapped");
});

test("the agent rules are unchanged", () => {
  expect(resolveSource("idle", true)).toBe("recent_unwrapped");
  expect(resolveSource("idle", false)).toBe("visible");
  expect(resolveSource("working", true)).toBe("visible");
  expect(resolveSource("blocked", false)).toBe("visible");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/pane-read.test.ts`
Expected: FAIL — `resolveSource(null, false)` returns `"visible"`.

- [ ] **Step 3: Extend `resolveSource`**

In `src/server/herdr/actions.ts`, widen the signature to `state: AgentState | null` and add, above the existing logic:

```ts
  // A shell pane is on the NORMAL screen, so it has a real scrollback buffer
  // and `recent_unwrapped` is ~2ms for 400 lines — measured. That is the exact
  // opposite of an agent pane, which renders on the alternate screen and costs
  // ~35ms per line past the viewport. So the cheap source for a shell is the
  // expensive one for an agent, and the state is what tells them apart.
  if (state === null) return "recent_unwrapped";
```

- [ ] **Step 4: Add `readPane`**

To the `HerdrActions` interface and `createActions`:

```ts
    async readPane(paneId) {
      // `pane.read`, not `agent.read`: the latter returns `agent_not_found`
      // for a pane with no harness — measured. Note the parameter is
      // `pane_id` here and `target` there; they are not interchangeable.
      //
      // Agents deliberately stay on `agent.read` (design doc §8): it refuses
      // `recent_unwrapped` on a non-idle agent with `agent_not_idle`, a
      // herdr-side guard against scrolling a live agent's pane that paddock
      // would otherwise have to maintain alone.
      const res = await request<HerdrPaneRead>(socketPath, "pane.read", {
        pane_id: paneId, source: "recent_unwrapped", lines: HISTORY_LINES,
        format: "ansi", strip_ansi: false,
      });
      const text = res.read.text;
      return {
        lines: text === "" ? [] : text.split("\n").map((l) => l.replace(/\r$/, "")),
        source: "recent_unwrapped" as const,
      };
    },
```

- [ ] **Step 5: Add the route**

In `src/server/routes.ts`, inside the `deps.actions` block:

```ts
    /**
     * Output for a pane that has no agent.
     *
     * Separate from `/api/agents/:id/output` because the store cannot
     * validate this id — a shell pane is not in it, by design (§3). The tree
     * is the authority instead.
     */
    app.post("/api/panes/:id/output", async (c) => {
      if (!deps.readTree) return c.json({ ok: false, detail: "herdr is not connected" }, 404);
      const id = c.req.param("id");
      const tree = await deps.readTree();
      const pane = tree.spaces.flatMap((s) => s.tabs).flatMap((t) => t.panes).find((p) => p.paneId === id);
      if (!pane) return c.json({ ok: false, detail: "unknown pane" }, 404);
      if (pane.harness !== null) {
        return c.json({ ok: false, detail: "this pane has an agent; use /api/agents/:id/output" }, 409);
      }
      const { lines, source } = await deps.actions!.readPane(id);
      return c.json({ lines, source });
    });
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/pane-read.test.ts && make check`
Expected: PASS, 2 tests. Also run `bun test tests/actions.test.ts` — the widened `resolveSource` signature must not have broken existing callers.

- [ ] **Step 6b: Confirm `pane.read` is inside the drift guarantee**

Spec §5 requires the drift test to cover `pane.read`, and it already does — `pane.read` and `agent.read` return the **same envelope**, which `tests/herdr-schema-drift.test.ts` models as `HerdrPaneRead` / `HerdrPaneReadResult`.

Run: `grep -n "HerdrPaneRead" tests/herdr-schema-drift.test.ts`
Expected: matches. If it returns nothing, the envelope is NOT covered and this step becomes real work — add the same `satisfies Record<keyof HerdrPaneReadResult, true>` treatment the other payload types get, before continuing.

- [ ] **Step 7: Commit**

```bash
make check-clean
git add src/server/herdr/actions.ts src/server/routes.ts tests/pane-read.test.ts
git commit -m "feat: read a pane with no agent, where scrollback is cheap instead of ruinous"
```

---

## Task 11: Accept a pane id in the hash

**Files:**
- Modify: `src/shared/route.ts`, `src/server/notify/notifier.ts`
- Test: `tests/route-hash.test.ts` (extend, or create)

**Interfaces:**
- Consumes: nothing.
- Produces: `paneHash(paneId: string): string`; `agentIdFromHash` accepts both prefixes.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { agentIdFromHash, paneHash } from "@shared/route";

test("the new form round-trips", () => {
  expect(agentIdFromHash(paneHash("w1:p1"))).toBe("w1:p1");
  expect(paneHash("w1:p1")).toBe("#/pane/w1%3Ap1");
});

test("links already sent to Telegram keep working forever", () => {
  expect(agentIdFromHash("#/agent/w1%3Ap1")).toBe("w1:p1");
});

test("a malformed escape lands on the list rather than crashing", () => {
  expect(agentIdFromHash("#/pane/%")).toBeNull();
  expect(agentIdFromHash("#/pane/")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/route-hash.test.ts`
Expected: FAIL — `paneHash` is not exported.

- [ ] **Step 3: Implement**

In `src/shared/route.ts`, widen the regex and add `paneHash`:

```ts
/**
 * Both prefixes, and that is permanent.
 *
 * `#/agent/<id>` is what the notifier emitted for every Telegram message ever
 * sent, and those messages are still in operators' chat histories. So the old
 * form must keep parsing forever, even though nothing emits it any more.
 * Since `agentId` and `paneId` are the same string — herdr's `pane_id` — the
 * two forms address the same thing and no link ever breaks.
 */
const PANE_HASH_RE = /^#\/(?:agent|pane)\/(.+)$/;

export function paneHash(paneId: string): string {
  return `#/pane/${encodeURIComponent(paneId)}`;
}
```

Point `agentIdFromHash` at `PANE_HASH_RE`. Keep `agentHash` exported as an alias of `paneHash` so no call site breaks in this task.

- [ ] **Step 4: Move the notifier to the new form**

In `src/server/notify/notifier.ts`, replace `agentHash(...)` with `paneHash(...)` so there is one emitted form and one legacy-accepted one.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/route-hash.test.ts && bun test tests/notify-wiring.test.ts && make check`
Expected: PASS. If a notifier test asserts the literal `#/agent/`, update it to `#/pane/` — that is the intended change, not a regression.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/shared/route.ts src/server/notify/notifier.ts tests/route-hash.test.ts
git commit -m "feat: address panes in the hash, and never break a link already sent"
```

---

## Task 12: Split `AgentTerminal`, and open a shell in it

`AgentTerminal.tsx` is 1050 lines — the repo's largest file. The shell case gives the split an objective seam rather than an invented one: transcript and read loop work for any pane; prompt, keypad and reply are agent-only.

**Files:**
- Create: `src/web/components/PaneTerminal.tsx`
- Modify: `src/web/components/AgentTerminal.tsx`, `src/web/components/App.tsx`
- Test: `tests/shell-terminal.test.tsx` (create)

**Interfaces:**
- Consumes: `readPane` route (Task 10), `paneHash` (Task 11), `SpaceTree` (Task 3).
- Produces: `<PaneTerminal paneId title onBack load />`.

- [ ] **Step 1: Write the failing test**

Create `tests/shell-terminal.test.tsx`:

```tsx
import "./support/dom";
import { expect, test } from "bun:test";
import { render, settle, unmount } from "./support/render";
import { PaneTerminal } from "@web/components/PaneTerminal";

const load = async () => ({ lines: ["you@dev-box:/srv/project$ ls", "README.md"], source: "recent_unwrapped" as const });

test("a shell pane renders its transcript", async () => {
  const el = await render(<PaneTerminal paneId="w3:p1" title="bash" onBack={() => {}} load={load} />);
  await settle();
  expect(el.textContent).toContain("README.md");
  unmount();
});

test("a shell has no keypad and no prompt options — there is no agent to answer", async () => {
  const el = await render(<PaneTerminal paneId="w3:p1" title="bash" onBack={() => {}} load={load} />);
  await settle();
  expect(el.querySelector("[data-keypad]")).toBeNull();
  expect(el.querySelector("[data-prompt-option]")).toBeNull();
  unmount();
});

test("a failed read is shown, never an empty screen", async () => {
  const el = await render(<PaneTerminal paneId="w3:p1" title="bash" onBack={() => {}} load={async () => { throw new Error("unknown pane"); }} />);
  await settle();
  expect(el.textContent).toContain("unknown pane");
  unmount();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/shell-terminal.test.tsx`
Expected: FAIL — cannot resolve `@web/components/PaneTerminal`.

- [ ] **Step 3: Extract `PaneTerminal`**

Move the transcript rendering, the ANSI pass, the scroll handling and the read loop out of `AgentTerminal.tsx` into `PaneTerminal.tsx`, taking `load` as a prop. **Move, do not copy** — two transcript renderers would drift, which is the whole reason for the split.

- [ ] **Step 4: Recompose `AgentTerminal`**

`AgentTerminal` keeps the agent-only controls and renders `<PaneTerminal>` for the transcript, passing a `load` bound to `fetchOutput`. Its existing tests must pass unchanged; if one fails, the split moved behaviour and must be corrected.

- [ ] **Step 5: Route a shell pane in `App.tsx`**

Where `openAgent` is resolved, fall back to the tree when the id is not in `agents`:

```tsx
  // A shell pane is deliberately absent from `agents` (§3), so the existing
  // lookup would bounce it back to the list. The tree is the authority for
  // panes with no agent. `key` stays the pane id across the shell -> agent
  // transition, so typing `claude` swaps the controls in without remounting
  // and without losing the operator's scroll position.
  const openPane = openAgent ?? treePane(tree, openId);
```

Render `<AgentTerminal>` when the pane has a harness and `<PaneTerminal>` when it does not, both `key={openId}`.

- [ ] **Step 6: Run the whole suite**

Run: `make test`
Expected: PASS, including every pre-existing `AgentTerminal` test.

- [ ] **Step 7: Verify the transition live**

Run `make dev`. Open a shell pane from `#/spaces`, then type `claude` into it in herdr.
Expected: the transcript keeps rendering, and once herdr detects the agent the agent-only controls appear **without a navigation and without the scroll jumping**.

- [ ] **Step 8: Commit**

```bash
make check-clean
git add src/web/components/PaneTerminal.tsx src/web/components/AgentTerminal.tsx src/web/components/App.tsx tests/shell-terminal.test.tsx
git commit -m "feat: open a shell in the terminal view, splitting the transcript from the agent's controls"
```

---

## Task 13: Guard the invariant

Spec §3's invariant is what keeps this feature away from the notification path. It needs its own test, because nothing else fails if it breaks.

**Files:**
- Test: `tests/shell-panes-stay-out.test.ts` (create)

**Interfaces:**
- Consumes: `toSpaceTree` (Task 4), `toAgents` from `@server/herdr/adapter`.

- [ ] **Step 1: Write the test**

```ts
import { expect, test } from "bun:test";
import { toAgents } from "@server/herdr/adapter";
import { toSpaceTree } from "@server/herdr/tree";
import type { HerdrSessionSnapshot } from "@shared/herdr-api";
import snapshot from "./fixtures/session-snapshot.json";

const NOW = 1_700_000_000_000;
const snap = snapshot as unknown as HerdrSessionSnapshot;

test("a pane with no agent is in the tree but never in the agent list", () => {
  const inTree = toSpaceTree(snap, NOW).spaces
    .flatMap((s) => s.tabs).flatMap((t) => t.panes)
    .filter((p) => p.harness === null).map((p) => p.paneId);
  expect(inTree).toContain("w3:p1");

  const agents = toAgents(snap.agents, { hostId: "dev-box", labels: new Map(), now: NOW });
  expect(agents.map((a) => a.agentId)).not.toContain("w3:p1");
});

test("every agent in the tree is also an agent in the store's view", () => {
  const treeAgents = toSpaceTree(snap, NOW).spaces
    .flatMap((s) => s.tabs).flatMap((t) => t.panes)
    .filter((p) => p.harness !== null).map((p) => p.paneId).sort();
  const storeAgents = toAgents(snap.agents, { hostId: "dev-box", labels: new Map(), now: NOW })
    .map((a) => a.agentId).sort();
  expect(treeAgents).toEqual(storeAgents);
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/shell-panes-stay-out.test.ts`
Expected: PASS. If it fails, something has widened `Agent` into `Pane` — stop and re-read spec §3.

- [ ] **Step 3: Run the whole suite and the gates**

Run: `make check && make check-clean && make test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/shell-panes-stay-out.test.ts
git commit -m "test: shell panes stay out of the store, because that is what protects notifications"
```

---

## Done

At this point paddock shows herdr's whole session, including spaces it could never see before, and opens any pane — agent or shell — in the terminal view.

Plan 2 (`docs/plans/2026-08-25-spaces-and-tabs-write.md`) adds rename, create, spawn and close, and starts by resolving spec §13 probes 1, 3 and 5.
