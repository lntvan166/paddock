# Manage Spaces and Tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** paddock can rename, create, close and spawn into herdr's spaces and tabs — not just watch them.

**Architecture:** No new subsystems. Eight write routes join the existing action-route shape in `routes.ts`, all validating against the on-demand tree the read half already serves. The UI adds two controls and two sheets. `AgentStore`, the delta path and the notifier are **not touched** — the §3 invariant that protects notification delivery holds unchanged.

**Tech Stack:** Bun, TypeScript, Hono, React 19, `bun:test`, happy-dom, shadcn `Sheet`.

**Spec:** `docs/design/2026-08-25-spaces-and-tabs-management-design.md` — **read §7 (rename), §9 (create + spawn), §10 (close), §16.7 (where the controls go) and §17 (the measured probes) before Task 1.** §9.1 carries a correction that removes a step it originally prescribed.

**Branch:** `feat/spaces-manage`, stacked on `feat/spaces-and-tabs` (PR #14, open). Management needs the tree, so it cannot branch from `main` until #14 merges. Target this branch's PR at `feat/spaces-and-tabs`, or retarget to `main` after #14 lands.

**On the depth of Tasks 7–8.** Tasks 1–5 carry the code to write. Tasks 7–8
are specified against §9 and §16.7 rather than pre-coded, deliberately: the
create sheet's shape depends on what Task 5's actions sheet establishes for
sheet layout, error surfacing and refetch-after-mutation, and pre-writing it
now would either duplicate those decisions or contradict them. Whoever reaches
Task 7 should expect to make presentation choices, and should read Task 5's
committed result first.

**A natural stop point:** Tasks 1–6 deliver rename and close, which ship usefully on their own. Tasks 7–8 add create and spawn. If scope needs cutting, cut there, not mid-task.

## Global Constraints

- **This repository is public.** No real hostnames, absolute home paths, usernames, or real agent/workspace names in committed content. **The scanner bans the literal substring `/home/`** — use `/base/operator` or `/srv/project` as stand-ins. Invented names only: `dev-box`, `api-refactor`, `flaky-test-fix`, `docs-cleanup`, `schema-migration`.
- **Run `make check-clean` before every commit, and never pipe it** — piping returns the pipe's exit status, so a failure slips past a `&&`.
- **`src/shared/herdr-api.d.ts` is generated.** Its interface bodies are literal text inside `scripts/gen-herdr-types.ts`; edit the script, then `make types`. Never hand-edit the output.
- **Never swallow errors.** Deliberate outcomes (400/404/409) must stay distinguishable from failures (502). Return them from *inside* the `try` so the catch cannot relabel them.
- **No device detection, no `isMobile`, no user-agent parsing.** Capability signals only.
- **Never define a colour only inside a media query.** Tokens on bare `:root`, redefined under `prefers-color-scheme: dark` AND `:root[data-theme="dark"]`.
- **No hover-only affordances.** Respect `prefers-reduced-motion` and `env(safe-area-inset-bottom)`.
- **Type on the `--t-*` scale.** No `OFF_SCALE` exemption for prose.
- **A brief's constraint on tests:** you may change exactly the assertions that pin behaviour this plan deliberately changes, and you must say which and why. Every other pre-existing assertion passes unmodified. **Never edit a fixture to keep an assertion green** — if that is the only way, the assertion was pinning the old behaviour.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/gen-herdr-types.ts` | **Modify.** Emit the create/start result envelopes and the manifest shape. |
| `src/shared/types.ts` | **Modify.** Payloads for the eight writes; `HarnessKind` list shape. |
| `src/server/herdr/actions.ts` | **Modify.** Eight herdr calls. |
| `src/server/routes.ts` | **Modify.** Eight routes, all tree-validated. |
| `src/web/api.ts` | **Modify.** Eight clients. |
| `src/web/components/RowActions.tsx` | **Create.** The `⋯` sheet: rename, close. |
| `src/web/components/CreateSheet.tsx` | **Create.** New space / new tab, harness-or-shell. |
| `src/web/components/SpaceRow.tsx` | **Modify.** Restore `⋯`; add the per-space `+`. |
| `src/web/components/Spaces.tsx` | **Modify.** Header `+`; refetch after a mutation. |
| `docs/architecture.md` | **Modify.** The eight new routes. |

---

## Task 1: Declare the herdr shapes these writes return

The create calls return **envelopes**, not bare records — §9.1's correction. Getting this wrong is the `result.text` bug again.

**Files:** Modify `scripts/gen-herdr-types.ts`; regenerate `src/shared/herdr-api.d.ts`; modify `tests/herdr-schema-drift.test.ts`.

**Interfaces produced:** `HerdrTabCreated`, `HerdrWorkspaceCreated`, `HerdrAgentStarted`, `HerdrAgentManifests` from `@shared/herdr-api`.

- [ ] **Step 1: Write the failing drift tests**

Follow the file's existing pattern exactly — a `satisfies Record<keyof X, true>` flag block plus `expectNoDrift` with an explicit ignore list. **Do not use one-directional `toContain`**; that was a defect corrected on the previous branch, and the whole point of the ignore list is that a new upstream field arrives as a decision rather than a silent column.

Derive each ignore list from the **live** schema (`herdr api schema --json`), not from memory.

- [ ] **Step 2: Run to verify it fails**

Run: `make check`
Expected: FAIL — the types are not exported. Note `bun test` will NOT show red for a type-only failure; Bun strips types without checking. `make check` is the gate.

- [ ] **Step 3: Add the interfaces to the generator template**

Insert into the `out` template in `scripts/gen-herdr-types.ts`, before the `HerdrRequest` block:

```ts
/** \`tab.create\` result. An ENVELOPE: the new tab AND its first pane.
 *
 * §9.1 originally said \`tab.create\` returns a bare \`TabInfo\` with no
 * \`pane_id\`, and prescribed re-reading the snapshot to find the new pane.
 * Measured false — the pane arrives here as \`root_pane\`. \`TabInfo\` the TYPE
 * genuinely has no pane id; reading a \`\$defs\` entry as the whole response is
 * the same mistake that produced the \`result.text\` bug.
 */
export interface HerdrTabCreated {
  type: "tab_created";
  tab: HerdrTabInfo;
  root_pane: HerdrPaneInfo;
}

/** \`workspace.create\` result. Same envelope shape, one level up. */
export interface HerdrWorkspaceCreated {
  type: "workspace_created";
  workspace: HerdrWorkspaceInfo;
  tab: HerdrTabInfo;
  root_pane: HerdrPaneInfo;
}

/** \`agent.start\` result. */
export interface HerdrAgentStarted {
  type: "agent_started";
  agent: HerdrAgentRaw;
}

/** \`server.agent_manifests\` result — the harnesses THIS machine has.
 *
 * The kind allowlist is derived from this at runtime and never hardcoded:
 * \`AgentStartParams.kind\` is a plain string in protocol 20, so the only
 * defensible allowlist is what is actually installed (§9.3).
 */
export interface HerdrAgentManifest { agent: string }
export interface HerdrAgentManifests {
  type: "agent_manifest_status";
  manifests: HerdrAgentManifest[];
}
```

- [ ] **Step 4: Regenerate and verify**

Run: `make types && make check && bun test tests/herdr-schema-drift.test.ts`
Expected: PASS. Confirm `git diff src/shared/herdr-api.d.ts` shows only the new interfaces — a hand-edit would show as a `.d.ts` change with no generator change.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add scripts/gen-herdr-types.ts src/shared/herdr-api.d.ts tests/herdr-schema-drift.test.ts
git commit -m "types: the create calls return envelopes, which §9.1 got wrong"
```

---

## Task 2: Rename an agent, a tab and a space

**Files:** Modify `src/server/herdr/actions.ts`, `src/server/routes.ts`. Test: `tests/rename-routes.test.ts` (create).

**Interfaces produced:** `HerdrActions.renameAgent(target, name: string | null)`, `renameTab(tabId, label)`, `renameSpace(spaceId, label)`; routes `POST /api/agents/:id/name`, `/api/tabs/:id/name`, `/api/spaces/:id/name`.

- [ ] **Step 1: Write the failing tests**

Build with injected fakes in the style of `tests/pane-input.test.ts`. Cover, for each of the three:
- a valid label reaches the action verbatim;
- a label over the ceiling is **refused 400, not truncated** (a silently shortened name is a wrong name);
- an unknown id 404s;
- a herdr throw becomes `{ok:false, detail}` 502.

Plus the three asymmetries §17 measured:
- `POST /api/agents/:id/name` with `{"name": null}` **succeeds** and forwards `null` — this is the one real clear;
- `POST /api/tabs/:id/name` with `{"label": ""}` is **refused 400** and never forwarded;
- same for `/api/spaces/:id/name`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/rename-routes.test.ts` → FAIL, routes not registered.

- [ ] **Step 3: Implement the actions**

```ts
    async renameAgent(target, name) {
      // `name: null` genuinely removes the field — measured (§14.1). herdr does
      // NOT re-derive one, so the agent falls to paddock's basename(cwd)
      // fallback. That is why the UI must not call this "reset to default".
      await request(socketPath, "agent.rename", { target, name });
    },

    async renameTab(tabId, label) {
      // `label` is a required string, and an empty one is ACCEPTED and stored
      // as "" rather than unset (§17). So there is no clear here, and the route
      // refuses an empty label rather than passing it through.
      await request(socketPath, "tab.rename", { tab_id: tabId, label });
    },

    async renameSpace(spaceId, label) {
      await request(socketPath, "workspace.rename", { workspace_id: spaceId, label });
    },
```

- [ ] **Step 4: Implement the routes**

All three registered inside the `deps.actions` block. Validate ids against `deps.readTree` the way `/api/panes/:id/output` does, with the deliberate outcomes returned from **inside** the `try`. Add a `MAX_LABEL_LEN` (64) beside `MAX_TEXT_LEN` and refuse, not truncate.

The agent route validates against `deps.store` (an agent IS in the store); the tab and space routes validate against the tree. Say so in a comment — the two authorities are not interchangeable, and that split is §3's invariant.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/rename-routes.test.ts && bun test tests/action-routes.test.ts && make check`
Expected: PASS. The widened `HerdrActions` breaks hand-rolled mocks — add stubs, change no assertion.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/server/herdr/actions.ts src/server/routes.ts tests/rename-routes.test.ts tests/action-routes.test.ts
git commit -m "feat: rename an agent, a tab and a space, and refuse the empty label herdr would store"
```

---

## Task 3: Close a tab and a space

**Files:** Modify `src/server/herdr/actions.ts`, `src/server/routes.ts`. Test: `tests/close-routes.test.ts` (create).

**Interfaces produced:** `closeTab(tabId)`, `closeSpace(spaceId)`; routes `POST /api/tabs/:id/close`, `POST /api/spaces/:id/close`.

- [ ] **Step 1: Write the failing tests**

Cover: a valid close reaches the action; an unknown id 404s; a herdr **refusal** surfaces as 502 with herdr's message in `detail` (this is the path §17's unmeasured probe 3 depends on — paddock must relay the refusal, not predict it); and the response reports what was closed so the UI can say it.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/close-routes.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
    async closeTab(tabId) {
      await request(socketPath, "tab.close", { tab_id: tabId });
    },

    async closeSpace(spaceId) {
      // Whether herdr permits closing the LAST space is deliberately
      // unmeasured (§17 probe 3): establishing that condition means reducing a
      // working herd to one space. So paddock does not pre-emptively disable
      // this on a count of one — that would encode a guess about herdr's
      // policy as a fact. herdr's refusal is relayed verbatim instead.
      await request(socketPath, "workspace.close", { workspace_id: spaceId });
    },
```

Routes as in Task 2. **POST, not DELETE** — paddock's API is a set of actions, not a REST resource tree (decision 7).

- [ ] **Step 4: Run the tests and commit**

```bash
bun test tests/close-routes.test.ts && make check && make check-clean
git add src/server/herdr/actions.ts src/server/routes.ts tests/close-routes.test.ts
git commit -m "feat: close a tab or a space, relaying herdr's refusal rather than guessing it"
```

---

## Task 4: The client for rename and close

**Files:** Modify `src/web/api.ts`. Test: extend `tests/web-api.test.ts`.

- [ ] **Step 1: Write the failing tests**

Each of the five clients POSTs to the correctly-encoded path with the right body, and **rejects** on non-2xx carrying the server's `detail`. Include the `{name: null}` case for the agent clear.

- [ ] **Step 2: Run to verify they fail; Step 3: implement**

Reuse the existing `Fetch`, `request`, `detailFrom`, `readJson` and the `paneUrl`-style encoding helpers. Do not write parallel helpers.

- [ ] **Step 4: Run and commit**

```bash
bun test tests/web-api.test.ts && make check && make check-clean
git add src/web/api.ts tests/web-api.test.ts
git commit -m "feat: clients for rename and close"
```

---

## Task 5: The row actions sheet

**Files:** Create `src/web/components/RowActions.tsx`. Modify `src/web/components/SpaceRow.tsx`, `src/web/styles.css`. Test: `tests/row-actions.test.tsx` (create).

This is where the `⋯` returns. **Read the note at the top of `SpaceRow.tsx`** — it was written for you by the change that removed the inert version, and it carries two requirements: the control must be **visible** (never an unhinted long-press, which is the touch equivalent of a hover-only affordance), and it must carry the row's **full visible label** in its accessible name.

- [ ] **Step 1: Write the failing tests**

- The `⋯` is present and **enabled** on a space row and on a pane row.
- Its accessible name contains what the row visibly shows (use `paneLabel`/the space label — do not rebuild the expression; §16.6's rule has one home in `pane-label.ts`).
- Opening it offers Rename and Close.
- Rename submits the typed label and calls the injected sender.
- **An empty label cannot be submitted** for a tab or space (§17).
- The agent sheet offers a clear, and its label says what clearing does — **not** "reset to default", because clearing drops the agent to paddock's `basename(cwd)` fallback rather than restoring a herdr name (§7.2).
- **Close is arm-then-confirm and states the consequence**: not a bare "Tap again", but the count of what dies — e.g. "Close tab — 1 working agent will be killed." Derive the count from the tree already on screen.
- A failed mutation is **surfaced**, and the tree is refetched so the screen shows what herdr holds rather than what was asked for.

- [ ] **Step 2: Run to verify they fail; Step 3: implement**

Use shadcn's `Sheet` — this is exactly the case `CLAUDE.md` sanctions it for (focus trap, scroll lock, escape handling), and it lands in `src/web/components/shadcn/`. Senders are injected so tests need no network.

**No optimistic updates.** This screen's value is being accurate about someone else's state; on success, refetch.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/row-actions.test.tsx && bun test tests/spaces-screen.test.tsx && make test`
Expected: PASS. `spaces-screen`'s existing tests must still pass — **except** the one asserting no row announces an action that does not exist yet, which this task makes false. **Flip it and say so**; that is the sanctioned case.

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/web/components/RowActions.tsx src/web/components/SpaceRow.tsx src/web/components/shadcn src/web/styles.css tests/row-actions.test.tsx tests/spaces-screen.test.tsx
git commit -m "feat: the row actions sheet, and the visible control its predecessor promised"
```

---

## Task 6: Verify rename and close against a live herdr

Not code. The first five tasks are shippable and this is what proves it.

- [ ] **Step 1: Build and run**

`make build`, then start on a **spare** `PADDOCK_PORT` — 8787 is the operator's own instance; do not touch it. Kill only your own.

- [ ] **Step 2: Exercise it, on throwaway objects only**

Create a throwaway space and tab **via the herdr socket** with `focus: false` (§17 measured that this does not steal focus). Then, through the UI: rename the tab; rename the space; rename an agent and clear its name; close the tab; close the space. Confirm each result by reading the tree back.

**Touch nothing the operator is using.** Close only ids you created. Do not rename any pre-existing space, tab or agent. Do not transcribe real names into your report.

- [ ] **Step 3: Report what you saw**

Including: what the close confirmation actually said, and whether a rename appeared on the dashboard as well as in Spaces (an agent rename rides the existing delta — `differs()` compares `name` — so it should).

- [ ] **Step 4: Commit nothing, report only**

---

## Task 7: Create a space and a tab, and spawn into it

**Files:** Modify `src/server/herdr/actions.ts`, `src/server/routes.ts`, `src/web/api.ts`. Test: `tests/create-routes.test.ts` (create).

**Interfaces produced:** `createSpace(opts)`, `createTab(spaceId, opts)`, `startAgent(paneId, kind, name)`, `harnessKinds()`; routes `POST /api/spaces`, `POST /api/spaces/:id/tabs`, `POST /api/panes/:id/agent`, `GET /api/harnesses`.

- [ ] **Step 1: Write the failing tests**

- Create returns the new ids **from the envelope** (`root_pane.pane_id`), with **no second snapshot read** — §9.1's correction, and a test that asserts the snapshot was fetched once is what keeps it corrected.
- `focus: false` is always sent (§17: it does not steal focus, and paddock must not start doing so).
- A `kind` **not** in `server.agent_manifests` is refused 400 and never forwarded — the allowlist is derived at runtime, never hardcoded (§9.3).
- `agent.start` gets a **per-call timeout override**: it blocks on readiness up to 30s while `HERDR_TIMEOUT_MS` is 10s, so without one this fails every time. `historyTimeoutMs()` is the existing precedent for passing a fourth argument to `request`. Note `timeout_ms` must be `> 3000` and `<= 300000`.
- A herdr failure at any step surfaces 502 with the message; a failure **after** the tab exists reports that distinctly — a half-created thing must not read as either success or nothing.

- [ ] **Step 2: Run to verify they fail; Step 3: implement; Step 4: run**

- [ ] **Step 5: Commit**

```bash
make check-clean
git add src/server/herdr/actions.ts src/server/routes.ts src/web/api.ts tests/create-routes.test.ts
git commit -m "feat: create a space or tab and start an agent in it, reading the pane from the envelope"
```

---

## Task 8: The create controls and sheet

**Files:** Create `src/web/components/CreateSheet.tsx`. Modify `Spaces.tsx`, `SpaceRow.tsx`, `styles.css`. Test: `tests/create-sheet.test.tsx` (create).

- [ ] **Step 1: Write the failing tests**

- A `+` sits **in the Spaces header** (creates a space) and one **per space row** (creates a tab in that space) — §16.7: position carries the scope, so the control needs no label to say what it makes. Size them to the **44px** tap target used elsewhere, not Collie's 36.
- The sheet offers the installed harnesses **from `GET /api/harnesses`** and a **plain shell** option (both are wanted; a plain shell is genuinely usable now that shells can be typed into).
- `cwd` defaults to the space's, with the cwds already in the tree offered as quick picks, and free text last. **No directory browsing** — that is a filesystem-listing endpoint and its own security surface.
- On success the UI navigates to the new pane and shows `starting <kind>…` while `launch_pending` is true; **a herdr error is surfaced inline and verbatim**, never a 200 hiding a failed start.
- The `+` is **absent** when the tree is unavailable, for the same capability reason the Spaces control is (a control that always errors is worse than none).

- [ ] **Step 2–4: implement and run**

- [ ] **Step 5: Verify live, on throwaway objects only**

Create a space and a tab through the UI. **Do not spawn an agent** unless the operator has authorised spending their harness quota — starting `claude` costs real tokens. If unauthorised, verify the shell branch and report the spawn path as test-covered rather than claiming it.

- [ ] **Step 6: Commit**

```bash
make check-clean
git add src/web/components/CreateSheet.tsx src/web/components/Spaces.tsx src/web/components/SpaceRow.tsx src/web/styles.css tests/create-sheet.test.tsx
git commit -m "feat: create a space or a tab from the phone, from the header that scopes it"
```

---

## Task 9: Guard the invariant, and update the map

**Files:** Test `tests/manage-invariant.test.ts` (create). Modify `docs/architecture.md`.

- [ ] **Step 1: Write the guard test**

Eight write routes now exist and **none of them may touch `AgentStore`, the delta path or the notifier** — that containment is what keeps a management feature from being able to break notification delivery (§3). Assert it in the way the previous branch's guard does: prove the thing that would break it is impossible, and **prove the test can fail** by breaking the invariant locally and watching it go red before restoring.

A guard test that cannot fail is worse than no test. The previous branch shipped one and it was caught only because someone deleted the guard line and the suite stayed green.

- [ ] **Step 2: Update `docs/architecture.md`**

Add the eight routes to the table. It was brought current on the previous branch; keep it that way rather than letting it drift again — `CLAUDE.md` sends every session there for the architecture rules.

- [ ] **Step 3: Run the gates and commit**

```bash
make check && make check-clean && make test
git add tests/manage-invariant.test.ts docs/architecture.md
git commit -m "test: the management routes stay out of the store, because that is what protects notifications"
```

---

## Done

paddock can then manage the session it watches. What remains unbuilt and deliberately so: pane geometry (`pane.split`/`move`/`resize` — a desktop concern), worktrees (`worktree.*` — its own feature with its own repo-state decisions), and the `tokens` map both `AgentInfo` and `WorkspaceInfo` carry that paddock still does not read.
