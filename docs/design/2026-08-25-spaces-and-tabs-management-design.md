# Spaces and tabs management

**Status:** approved design, not yet implemented.
**Date:** 2026-08-25.
**Supersedes nothing.** Extends `docs/design/2026-08-17-paddock-design.md`.

paddock watches and answers agents. It cannot see the structure those agents
live in — herdr's workspaces ("spaces") and tabs — and it cannot change a
label, create a tab, start an agent, or close anything. This design adds that.

Every non-obvious decision below rests on a measurement against a live herdr
0.8.2 (protocol 20), recorded in §14 rather than asserted. Where something was
**not** measured, it is named as a probe task in §13 instead of guessed at.
That distinction is the point: an earlier version of this design was built on
the reasonable-sounding belief that an agent's `name` is derived from its
workspace label. It is not, and the difference changes what the UI is allowed
to say.

---

## 1. Scope

In:

- Reading herdr's space → tab → pane tree, including panes with no agent.
- A **Spaces screen** for browsing that tree.
- **Rename** of an agent, a tab, and a space.
- **Create** of a space and a tab.
- **Spawning** an agent into a pane (`agent.start`).
- **Close** of a tab and a space.
- **Shell panes in the terminal view** — reading a pane that has no harness.

Out, deliberately:

- **Splitting, moving, resizing or zooming panes.** herdr has `pane.split`,
  `pane.move`, `pane.swap`, `pane.resize`, `pane.zoom` and a `layout.*` family.
  Geometry is a desktop concern; a phone shows one pane at a time.
- **Worktrees.** `worktree.create/list/open/remove` exist and are a coherent
  feature of their own, with its own decisions about repo state.
- **The `tokens` map.** Both `AgentInfo` and `WorkspaceInfo` carry a `tokens`
  object paddock does not read (§14.8). Surfacing context usage is worth doing
  and is not this.
- **A slash-command palette.** Worth building; unrelated to managing structure.

---

## 2. What the measurements changed

Four findings reshaped this design. Each is detailed in §14.

**An agent's `name` is a stored override, not a derivation.** herdr writes it
once when the agent starts, from the workspace label, and it is then an
independent field. Clearing it does **not** restore a herdr-derived value — the
key disappears from `agent.list` entirely. Consequences: renaming a space never
renames its agents (§7.1), and a "reset to default" control would be a lie (§7.2).

**`pane.read` is a superset of `agent.read`.** It works on panes with and
without a harness, on every source including `detection`, returning
byte-identical content at indistinguishable speed (§14.4). `agent.read` fails
on a pane with no agent (`agent_not_found`). So a shell pane and an agent pane
are not two kinds of thing needing two renderers — they are **one pane at two
moments**, and the shell case is the agent case with the agent-only controls
absent.

**Shell panes have real scrollback; agent panes do not.** An agent renders on
the alternate screen, which retains nothing, so herdr recovers history by
physically scrolling (~35 ms/line — the measurement behind `HISTORY_LINES` in
`actions.ts`). A shell is on the normal screen with a genuine buffer: 400 lines
came back in **2 ms** (§14.5). The shell path is therefore *cheaper* than the
agent path, not harder.

**`session.snapshot` returns the whole tree in one ~15 ms call** (§14.6),
and herdr's schema already defines `SessionSnapshot`, `WorkspaceInfo`,
`TabInfo` and `PaneInfo`. So the entire feature sits **inside** the
schema-drift guarantee rather than outside it, which is what decision 2 in
`docs/decisions.md` exists to require.

---

## 3. The model: two models, meeting once

The tempting move is to widen `Agent` into `Pane` everywhere. This design
refuses it.

Widening would drag panes with no agent, no state and nothing to answer
through `state/store.ts`, the delta path, and `notify/notifier.ts`. That is
precisely the code `docs/roadmap.md` flags as having an unguarded call site,
where a mistake disables notifications while every test stays green and the UI
looks fine. A browse-and-rename feature must not be able to break notification
delivery.

Instead:

- **`AgentStore`, the delta path, the notifier and the home triage list are
  untouched.** They continue to hold agents only. A shell pane has no
  `AgentState`, nothing to approve, and nothing worth a Telegram message.
- **The Spaces screen reads its own `SpaceTree`**, on demand, and that model
  includes shell panes.
- **The terminal view is the single place the two meet.**

This is a hard invariant, not a preference, and §12 gives it a test:
**a pane with no agent must never appear in a triage section or trigger a
notification.**

---

## 4. Contract

Added to `src/shared/types.ts` — the one payload contract, per rule 3.

```ts
/** The herdr session tree, as read at a single instant. */
export interface SpaceTree {
  spaces: Space[];
  /** Server clock when the snapshot was taken. The UI renders "as of 4s ago"
   *  from this, and the phone's clock is not the server's — the same reason
   *  SettingsView carries `serverNow`. */
  readAt: number;
}

export interface Space {
  spaceId: string;              // herdr workspace_id
  label: string | null;
  tabCount: number;
  paneCount: number;
  tabs: Tab[];
}

export interface Tab {
  tabId: string;
  /** herdr returns the tab's NUMBER as a string when no label is set, so an
   *  unlabelled tab arrives as "1". Null here means exactly that: the
   *  operator has never named this tab. See §14.7. */
  label: string | null;
  panes: TreePane[];
}

export interface TreePane {
  paneId: string;
  /** The harness in this pane ("claude", "codex"), or null for a plain shell.
   *  This is the ONLY discriminator between the two cases. */
  harness: string | null;
  /** `agent.list`'s `name`. Null for a shell, and also null for an agent whose
   *  name has been cleared — herdr does not re-derive one. See §14.1. */
  name: string | null;
  /** `terminal_title_stripped`. A shell's only label. */
  title: string | null;
  cwd: string;
  /**
   * Null for a shell, and null is the point.
   *
   * A shell is not `idle`. It has no triage state at all, and inventing one
   * would put it in a section it does not belong in. The same discipline as
   * `stateSinceExact`: do not render a guess as a fact.
   */
  state: AgentState | null;
}
```

`TreePane.paneId` is the same string as `Agent.agentId` — paddock keys agents
by herdr's `pane_id` and always has. That identity is what lets a shell become
an agent without changing address (§8).

---

## 5. Read model

`GET /api/spaces` → `SpaceTree`, served from **one** `session.snapshot` call.

A GET is correct here and does not violate the "never put payloads in a GET
query string" rule: that rule is about payloads, and this request has no
parameters at all.

**`src/server/herdr/tree.ts`** is the only module that knows the snapshot's
field names — the same containment rule 2 places on `adapter.ts`. Dependency
direction stays `herdr/socket → herdr/tree → routes → web/`. `store.ts` and
`hub.ts` are not imported and not modified.

`scripts/gen-herdr-types.ts` is extended to emit `SessionSnapshot`,
`WorkspaceInfo`, `TabInfo` and `PaneInfo`, and `tests/herdr-schema-drift.test.ts`
covers them — **plus `pane.read`**, which would otherwise be a second read
method sitting outside the guarantee, which is the exact shape of the defect
that produced the `result.text` bug.

### 5.1 Invalidation

The screen refetches when: it opens, a mutation of ours succeeds, the operator
taps refresh, or a `tree-stale` frame arrives.

`tree-stale` is a new, payload-free `ServerMessage` variant. The supervisor
pushes it on **structural** events only:

| subscribe as | delivered as |
|---|---|
| `workspace.created` | `workspace_created` |
| `workspace.closed` | `workspace_closed` |
| `workspace.renamed` | `workspace_renamed` |
| `tab.created` | `tab_created` |
| `tab.closed` | `tab_closed` |
| `tab.renamed` | `tab_renamed` |

The two spellings are not decoration. `socket.ts` already documents that
subscribe names and delivered names differ, and that matching on the wrong one
fails **silently, forever**. Both are pinned as named constants beside the
existing four, and §13 makes verifying each pair a task rather than an
assumption.

**Deliberately excluded: `workspace.updated` and
`workspace.metadata_updated`.** A space's rollup `agent_status` almost
certainly moves on those, which would turn invalidation into a refetch on
every agent state change — strictly worse than having no invalidation at all.

Three events paddock **already subscribes to** — `pane_agent_detected`,
`pane_closed`, `pane_exited` — also change the tree, so they invalidate too, at
no cost. `pane_agent_detected` is what makes a shell becoming an agent update
the screen for free.

### 5.2 Why on-demand rather than in the store

Considered and rejected: replicating the tree into `state/` and pushing it on
the delta path. It is never stale, and it is the largest possible blast radius
on the one path that must not break (§3).

The precedent settles it. paddock already decided that herdr *content* is read
on demand and never streamed — that is why the terminal view has an explicit
refresh control. A Spaces screen behaving the same way is consistent with a
documented decision rather than a shortcut around one.

The cost is honest staleness, so the screen is honest about it: `readAt` is
rendered as "as of 4 s ago" beside a refresh control. This also closes the
"No pull-to-refresh" gap recorded in `docs/roadmap.md` for the first time.

---

## 6. The Spaces screen

> **SUPERSEDED 2026-08-25** by
> `docs/design/2026-08-25-spaces-two-level-redesign.md`. The screen is a
> two-level drill-down: `#/spaces` lists spaces only, `#/space/<id>` lists one
> space's tabs and is where rename, close and create live.
>
> The measurement this section argues from is correct and still worth reading —
> six of seven spaces held one tab and one pane, so a three-level browser
> really would have spent two levels rendering one child each. The conclusion
> drawn from it was wrong. It counted **children per space** and never counted
> **controls per row**: with eleven spaces each carrying a link, a `⋯` and a
> `+`, the shipped screen put 33 tap targets on one viewport while fitting all
> eleven rows without a scroll. The second level's value was never vertical
> space; it is that management affordances belong on the screen where you have
> already chosen what you are managing.
>
> Read the successor for the layout. §6.1 below still binds, minus its "no
> horizontal scroll rails" contrast — the rail is still refused, for the
> measurement in the successor's §5.2.

Route `#/spaces`, hash-routed like `#/settings`.

**Layout: one adaptive vertical outline.** Not a drill-down, and not
horizontal rails. A space whose structure is degenerate — one tab, one pane —
renders as **one row**, with no chevron, because there is nothing to expand.
Sub-rows appear only where structure is real.

This matters more than it sounds. On the development machine this was designed
against, six of seven spaces held exactly one tab and one pane (§14.7). A
three-level browser would have spent two levels rendering one child each. The
outline degrades to a flat list automatically and grows only where the operator
has actually built structure.

Collapsing stays available and **defaults to open**, for the reason `App.tsx`
already gives for `idleOpen`: a collapsed group shows a count where it could
show its contents, and revealing structure is this screen's whole job.
Collapsed state is remembered per space.

Rejected alternatives:

- **Sticky section headers**, reusing `Section.tsx`. Least new code, but costs
  two lines per space whether or not the space needs them — the flat case pays
  most for the least.
- **Collapsed-by-default accordion.** Identical to the chosen layout on a flat
  herd; on a structured one it hides exactly what the screen exists to show.

### 6.1 What this deliberately does differently from Collie

[Collie](https://colliepwa.dev) solves the same problem and was studied
directly (§14.9). Four differences are deliberate:

- **Every actionable row carries a visible `⋯`.** Collie reaches rename and
  close through an unhinted long-press. paddock's UI rules already ban
  hover-only affordances because they are invisible on touch; an unhinted
  long-press is the same defect wearing a different hat.
- **No horizontal scroll rails.** Collie stacks two — spaces, then tabs —
  costing vertical space and creating two independent scroll positions to lose
  your place in. This screen scrolls one way.
- **State is said once.** Collie pairs a coloured dot with a text badge on the
  same chip. `StatusDot` is `aria-hidden` and the state is carried as text
  beside it, because red-and-green is the classic indistinguishable pair and
  this palette uses both.
- **Spaces with no agent are visible.** paddock cannot see them at all today.

The one Collie pattern worth taking outright is arm-then-confirm for
destructive actions (§10).

The `⋯` opens a bottom sheet. This is exactly the case `CLAUDE.md` sanctions
shadcn for — focus trap, scroll lock, escape handling — and it must use
shadcn's `Sheet`, landing in `src/web/components/shadcn/`.

---

## 7. Rename

| target | herdr call | clearable |
|---|---|---|
| agent | `agent.rename {target, name}` | yes — `name: null` |
| tab | `tab.rename {tab_id, label}` | no — `label` is a required string |
| space | `workspace.rename {workspace_id, label}` | no — same |

Routes, following decision 7 (actions are POST), decision 12
(`content-type: application/json` required) and decision 17 (same-origin gate
on every write):

```
POST /api/agents/:id/name    {"name": string | null}
POST /api/tabs/:id/name      {"label": string}
POST /api/spaces/:id/name    {"label": string}
```

### 7.1 The three are independent

Measured (§14.2): an `agent.rename` override survives a later
`workspace.rename`, and `workspace.rename` never writes an agent's `name`.
So the UI may present them as three separate edits, because they are.

`pane.rename` is **not used**. It writes a `label` field that `agent.list`
does not read, so a pane rename would appear to do nothing in paddock (§14.3).
Anyone reaching for it later should read that section first.

### 7.2 No "reset to default"

Clearing an agent's name does not restore the herdr-derived one — the field
becomes absent and herdr does not re-derive it (§14.1). The agent then falls to
paddock's own `basename(cwd)` fallback in `toAgents`, which is a *different*
label, frequently a disambiguated one.

So the control is labelled for what it does:

> **Clear name** — paddock will label it from its folder.

This also settles a live question about decision 15: the cwd fallback is not
near-dead code that herdr's naming has made redundant. It is exactly what a
cleared agent lands on, and this feature is what makes clearing reachable.

### 7.3 Bounds

Label length is bounded by paddock, not the caller — the same reasoning
`MAX_READ_LINES` records: a client-supplied value reaching a herdr parameter
must be governed by paddock's policy. A label over the bound is **rejected,
not truncated**, because a silently shortened name is a wrong name.

Empty-string handling for tabs and spaces is **not** assumed; see §13.
Implemented behaviour, once measured, is recorded in §17.

### 7.4 Propagation is free

`differs()` in `state/store.ts` already compares `a.name !== b.name`, so an
agent rename rides the existing delta to every connected browser and the home
list updates itself. No new push plumbing.

---

## 8. Shell panes in the terminal view

The terminal view takes a **pane**, which may or may not have an agent.

- **Transcript:** `pane.read` for a pane with no harness; `agent.read`
  unchanged for one with a harness.

  These are byte-identical in content and speed (§14.4), so unifying on
  `pane.read` was considered and **rejected**: `agent.read` refuses
  `recent_unwrapped` on a non-idle agent (`agent_not_idle`), a herdr-side guard
  against physically scrolling a live agent's pane. Whether `pane.read`
  enforces the same was not measured, because measuring it means scrolling a
  running agent. Keeping the proven path proven costs one extra method and buys
  a safety net paddock does not have to maintain itself.

- **Source policy** extends `resolveSource` by exactly one case:

  | state | source |
  |---|---|
  | `null` (shell) | `recent_unwrapped`, always — 2 ms, real buffer |
  | `idle` | `recent_unwrapped` — unchanged |
  | anything else | `visible` — unchanged |

  The existing reasoning is about *sources*, not about which method asks, so it
  survives verbatim.

- **Controls:** the prompt options, keypad, state dot and send-as-reply are
  agent-only and are simply absent for a shell. A shell keeps plain text input,
  because a shell's whole purpose is typing into it.

**The transition needs no navigation.** Type `claude` into a shell; herdr emits
`pane.agent_detected`; paddock already subscribes to it; the supervisor already
refreshes; the agent lands in the next delta. The pane gains a state and the
agent-only controls appear beneath the transcript already on screen.

Two consequences:

- **`AgentTerminal.tsx` splits.** At 1050 lines it is the largest file in the
  repo, and the shell case gives the seam an objective location: transcript and
  read loop (any pane) separate from agent-only controls. This is a targeted
  improvement to code the feature already has to change, not a drive-by
  refactor.
- **The route keys on pane id.** `App.tsx` currently resolves
  `agents.find(a => a.agentId === openId)` and falls back to the list on a
  miss, which would bounce a shell pane straight back out. The view resolves
  from the tree when the id is not in `agents`.

  **Corrected 2026-08-25, measured false as originally written.** This section
  claimed `key={paneId}` keeps the view from remounting across the shell →
  agent transition. It does not: React remounts when the element *type*
  changes, and `AgentTerminal` is not `PaneTerminal`. A stable key is necessary
  and not sufficient. What actually holds is narrower — the transcript survives,
  because `PaneTerminal` seeds synchronously from `pane-cache` and `prunePanes`
  keeps the open pane; scroll position and revealed history do reset. Making it
  genuinely remount-free needs ONE component type at that position, which
  inverts the composition and puts at risk `App.tsx`'s documented reason for
  keying per agent (stopping a reply typed for one agent landing on another).
  That trade was considered and refused.

### 8.1 Hash migration

`#/agent/<id>` is what `notify/notifier.ts` builds Telegram deep links from,
and **those messages already exist in operators' chat histories**. So that form
must keep parsing forever.

`agentIdFromHash` accepts both `#/agent/<id>` and `#/pane/<id>` and returns a
pane id. New code — including the notifier — emits `#/pane/<id>`, so there is
one emitted form and one legacy-accepted form rather than two live ones. No
link ever breaks, because `agentId` and `paneId` are the same string.

---

## 9. Create and spawn

### 9.1 Creating

```
POST /api/spaces                    {"label"?: string, "cwd"?: string}
POST /api/spaces/:id/tabs           {"label"?: string, "cwd"?: string}
```

backed by `workspace.create` and `tab.create`.

> **Corrected 2026-08-25:** measured false — `tab.create`'s result is an
> envelope carrying `root_pane` alongside `tab`, so the new pane id is returned
> directly; see `docs/probes/2026-08-25-structural-events.md`. Do not implement
> the snapshot re-read described below. Note precisely what was wrong: §14.8 is
> accurate, `TabInfo` the *type* genuinely has no `pane_id`. It is the
> inference from that — "therefore the pane must be found by re-reading the
> snapshot" — that the probe disproves, and it is left standing below rather
> than deleted because the paragraph reads persuasively enough to pre-empt its
> own objection, and a reader who meets the reasoning without this line will
> implement the wrong thing feeling well-informed.

`tab.create` returns `TabInfo`, which carries **no `pane_id`** (§14.8). The new
pane is therefore resolved by re-reading the snapshot and matching on
`tab_id` — a documented consequence of the response shape, not a guess. This
repo has already shipped one bug from assuming a herdr response shape; it does
not get to ship a second.

### 9.2 Spawning

`agent.start` requires an existing `pane_id`, so creation and spawning are two
steps. They are also two steps in the operator's head, which is what makes the
split honest rather than merely convenient:

1. `POST /api/spaces/:id/tabs` → creates the tab, resolves its pane, returns
   `{tabId, paneId}` in roughly the cost of one snapshot. The UI navigates to
   the pane immediately — and it renders, because §8 made shells renderable.
2. `POST /api/panes/:id/agent {"kind": string, "args"?: string[]}` → issues
   `agent.start`.

`agent.start` blocks on readiness for up to 30 s by default, while
`HERDR_TIMEOUT_MS` is 10 s. It therefore takes a **per-call timeout override**,
for which `historyTimeoutMs()` is the existing precedent — `request()` already
accepts a fourth argument for exactly this.

> **Corrected 2026-08-25:** the sentence below is not what was built.
> `launch_pending` is never read. It is a real field on herdr's `AgentInfo`,
> and paddock deliberately does not model it — it sits in
> `tests/herdr-schema-drift.test.ts`'s `IGNORED_FIELDS`, so the adapter never
> carries it and nothing downstream can consult one. The
> `starting claude…` notice comes from a CLIENT-SIDE launch store
> (`src/web/launch.ts`), written by the create sheet before it navigates and
> cleared when `POST /api/panes/:id/agent` answers — so the notice tracks
> paddock's own request, not herdr's view of the pane. That matters to anyone
> reading this to implement it: a herdr-driven notice would survive a reload
> and a second tab, and this one does not. That is a known consequence of
> tracking paddock's own request rather than herdr's state, not a claim this
> section makes. The second sentence
> stands exactly as written: a 200 never hides a failed start.

While `launch_pending` is true the terminal shows `starting claude…`. Any
herdr error is surfaced **inline and verbatim**; a 200 must never hide a failed
start, or the operator is left watching a shell that silently never becomes an
agent.

So spawning is the shell flow plus one action. The `+` sheet performs both
steps on the operator's behalf; the two routes remain separately meaningful.

### 9.3 Which kinds, and which directory

**Kinds come from `server.agent_manifests`** and are never hardcoded (§14.8:
20 on the development machine). `AgentStartParams.kind` is a plain string in
protocol 20 — not an enum — so an allowlist is paddock's responsibility, and
the only defensible one is what the machine actually has installed.

**cwd defaults to the space's**, with the cwds already in use elsewhere in the
tree offered as quick picks, and free text last. The snapshot already carries
every pane's cwd, so the quick picks are free. Collie asks the operator to type
a filesystem path on a phone keyboard; that is the thing to improve on. No
directory browsing — that needs a filesystem-listing endpoint, which is a
security surface of its own and out of scope.

**Say the round trip out loud: those quick picks are the tree's own
TILDE-ISED cwds coming back.** `tree.ts` rewrites every `cwd` as `~/…` on the
way out so a username never crosses the wire, so a pick the operator taps
arrives at the create route as `~/project`, not as an absolute path — and
herdr was measured (2026-08-25, live) to neither expand nor refuse a leading
`~`: it starts the pane in the home directory and says nothing. So the tilde
paddock invented has to be undone by paddock, server-side, before the value
reaches herdr: `expandHome` in `tree.ts` is the exact inverse of `tildeise`
and sits beside it, it is the ONLY function that mints the `HostPath` brand
`CreateOpts.cwd` requires, and a tilde it cannot resolve (`~someone/…`, or
`~/…` with no `HOME`) is refused with a 400 rather than forwarded.

---

## 10. Close

```
POST /api/tabs/:id/close
POST /api/spaces/:id/close
```

POST rather than DELETE: paddock's API is a set of actions, not a REST
resource tree (decision 7).

Closing is destructive and can kill a working agent. **Arm-then-confirm**,
taken from Collie — but the confirmation states the consequence rather than
merely asking twice:

> **Close tab** — 1 working agent will be killed.

The count comes from the tree already on screen. paddock does not refuse the
close; killing a stuck agent is a legitimate thing to want. It refuses to let
it happen *silently*, which is the same principle as rendering `+` on a
guessed elapsed time.

Whether herdr permits closing the last remaining space is **not assumed** (§13).

---

## 11. Errors

Every herdr error is surfaced verbatim through the existing
`ActionResult {ok, detail}`. No `2>/dev/null`, no empty catch, no unconditional
success — the hard rules in `CLAUDE.md` apply unchanged, and a management
screen that quietly fails to rename something is worse than one that has no
rename at all.

A failed mutation leaves the tree untouched and refetches, so the screen shows
what herdr actually holds rather than what the operator asked for. No
optimistic updates: this screen's value is being accurate about someone else's
state.

---

## 12. Testing

- **`tree.ts`** against a captured `session.snapshot` fixture. The fixture uses
  **invented names only** (`api-refactor`, `flaky-test-fix`, `docs-cleanup`,
  `schema-migration`), per `CLAUDE.md`. A real snapshot must never be committed:
  it carries workspace labels, agent names and absolute cwd paths.
- **Per-route tests** for each write: validation, label bounds, same-origin
  rejection, missing `content-type`, and unknown-id handling.
- **Drift test** extended to `SessionSnapshot`, `WorkspaceInfo`, `TabInfo`,
  `PaneInfo`, and `pane.read`.
- **Component tests** for the Spaces screen (degenerate space renders one row;
  structured space renders sub-rows; collapse persists) and for the terminal
  view in shell mode (no keypad, no prompt, plain input present).
- **The invariant from §3, explicitly:** a pane with no agent never appears in
  a triage section and never reaches the notifier. This is the test protecting
  notification delivery from this feature.

---

## 13. Open questions — probes, not assumptions

Each is a task in the implementation plan, resolved by measurement **before**
the code that depends on it is written.

1. **Does an empty `label` clear a tab or space name?** `tab.rename` and
   `workspace.rename` take a required string. Until measured, the UI rejects
   an empty label rather than sending one.
2. **Does `pane.read` enforce `agent_not_idle`?** Not required by this design
   (§8 keeps agents on `agent.read`), but it decides whether unifying later is
   safe. Measure on a throwaway pane, never on a working agent.
3. **Does herdr permit closing the last space?** And what does it return if
   not (§10).
4. **Verify each subscribe/deliver event-name pair in §5.1** against a live
   socket. Matching the wrong spelling fails silently and forever.
5. **`tab.create`'s `focus` parameter.** It defaults to `false`. Confirm that
   a tab created from a phone does not steal focus on the desktop, which would
   make paddock disruptive to someone sitting at the machine.

---

## 14. Measurements

All against herdr 0.8.2, protocol 20. Names and paths are redacted; the shapes
and timings are verbatim.

**14.1 `agent.list`'s `name` is a stored override.** Renaming an agent changed
`name` while leaving `workspace.label` and the pane's `label` untouched.
Clearing it (`name: null`) removed the key from the `agent.list` row entirely;
herdr did **not** substitute a derived value, and a subsequent workspace rename
did not restore one.

**14.2 The override wins.** With an override set, renaming the containing
workspace left the agent's `name` unchanged. Space rename and agent rename are
independent.

**14.3 `pane.label` and `agent.list`'s `name` are different fields.** One pane
in the sample carried a `label` that differed from its agent's `name`, and
`agent.list` reported the `name`. `pane.list` rows carry no `name` at all,
which is the standing reason `docs/gotchas.md` requires `agent.list` for
labelling, and it still holds at 0.8.2.

**14.4 `pane.read` versus `agent.read`, same pane.** Byte-identical, timings
indistinguishable. `agent.read` was run twice first as a self-variance
baseline; it matched itself every time, so the panes were stable and the
cross-method match is meaningful.

| pane state | source | identical | `agent.read` | `pane.read` |
|---|---|---|---|---|
| idle | `visible` (ansi) | yes, 4893 B | 0.4 ms | 0.4 ms |
| idle | `detection` (text, stripped) | yes, 3565 B | 0.9 ms | 0.8 ms |
| idle | `recent_unwrapped` | yes, 4893 B | 0.4 ms | 0.4 ms |
| working | `visible` (ansi) | yes, 5441 B | 0.3 ms | 1.0 ms |
| working | `detection` (text, stripped) | yes, 4134 B | 0.8 ms | 0.8 ms |

`agent.read` on a pane with no harness fails with `agent_not_found`.
`pane.read` takes `pane_id`; `agent.read` takes `target`.

Caveat: `recent_unwrapped` returned the same bytes as `visible` on the agent
pane, because an agent pane has nothing past the viewport. Equivalence under
deep scrollback is therefore **unproven for agent panes**, and unprovable on
one — which is itself the reason §8 keeps them on `agent.read`.

**14.5 Shell panes have a real scrollback buffer.** On a pane with no harness,
`pane.list` reported `scroll.max_offset_from_bottom: 1301`:

| source | lines asked | time | lines returned |
|---|---|---|---|
| `visible` | 120 | 8 ms | 54 |
| `recent_unwrapped` | 120 | 2 ms | 108 |
| `recent_unwrapped` | 400 | 2 ms | 367 |

Against the documented agent-pane figures in `actions.ts` (300 lines → 10.7 s,
past the transport ceiling), the asymmetry is total, and explained: agents
render on the alternate screen, shells do not.

**14.6 `session.snapshot` returns everything in one call**, in ~15 ms:
`workspaces`, `tabs`, `panes`, `agents`, `layouts`, plus `focused_workspace_id`
/ `focused_tab_id` / `focused_pane_id`, `version` and `protocol`.

**14.7 The sample tree was nearly flat.** Seven spaces, eight tabs, eight
panes; one space had two tabs, every other had one tab and one pane; one pane
had no agent, making its space invisible to paddock entirely. Every agent's
`name` was the slug of its workspace label, with herdr's own `-2` suffix
disambiguating two agents in one space. Unlabelled tabs report their number as
their label (`"1"`, `"2"`).

Counts observed to change mid-session, which is the concrete argument for §5.2's
honest "as of" rather than an implied-live screen.

**14.8 Schema surface paddock does not yet declare.** `workspace.list` returns
`active_tab_id`, `agent_status`, `pane_count`, `tab_count` and `focused`
beyond the three fields `HerdrWorkspaceRaw` declares. `AgentInfo` additionally
carries `launch_pending`, `interactive_ready`, `display_agent`,
`screen_detection_skipped`, `state_labels`, `title` and `tokens`.
`WorkspaceInfo` also carries `tokens` and `worktree`. `TabInfo` carries no
`pane_id`. `server.agent_manifests` listed 20 installed agent kinds.

**14.9 Collie** was driven at 390 px with Playwright and its bundle read.
Home is state sections plus a collapsible Spaces section with a filter box.
A space view stacks a spaces rail over a tabs rail. Rename and close exist for
tabs and panes, reached by long-press or tap-on-active with no visible
affordance, and use arm-then-confirm. There is no space rename and no space
close. "New space" opens a sheet with optional free-text cwd and label; "New
tab" takes one tap with no sheet and lands directly in a new shell terminal —
which Collie can do because it reads panes with no agent.

---

## 15. Phasing

Each phase ships something usable on its own.

1. Contract, `tree.ts`, `GET /api/spaces`, generator and drift test. No UI.
2. Spaces screen, read-only: outline, refresh, `tree-stale`.
3. Shell panes in the terminal view; `AgentTerminal` split; hash migration.
4. Rename — agent, tab, space.
5. Create space and tab; spawn.
6. Close, with arm-then-confirm.

Phases 1–2 are worth shipping alone: they make a space with no agent visible
for the first time. Phase 3 is the largest and the one carrying refactor risk.

---

## 16. Round two — what the first review of the shipped screen changed

Phases 1–3 shipped and were reviewed against a live herd. Six things came
back. Two were defects in this document's own reasoning, and they are the more
interesting ones.

### 16.1 The alias line rebuilt the redundancy §14.7 exists to record

§14.7 measured that an agent's `name` is the **slug** of its workspace label.
§6's merged row then showed the space label with the pane's identity beneath it
"only when it differs" — and the implementation compared the two strings for
**exact equality**. `"shipper block action" !== "shipper-block-action"`, so
every merged row printed its own title twice, once de-spaced.

The comparison must be **slug-normalised**, not literal. And when the two
genuinely diverge, the pane's name belongs on the **pane row**, not as a
subtitle on the space: the space row's job is to identify the space.

The lesson worth keeping: a measurement recorded in §14 is not applied just
because it is written down. This one was measured, cited, and then not used by
the code three sections away.

### 16.2 Structure that does not encode structure

A tab's label rendered as a bare uppercase heading between two pane rows, in a
space whose children carried no visual containment. It read as a section header
for the whole list rather than as "the tab this pane sits in" — an operator
reported it as nonsense, correctly.

Two corrections, both about encoding rather than decoration:

- **A space's children are bracketed** — a left rule plus indent, closed at the
  bottom — so the space is visibly a container and you can see where it ends.
- **A tab label is a caption on the pane it labels**, below the pane's name in
  the smallest step of the type scale, not a heading above a group. An unnamed
  tab renders nothing, as before.

### 16.3 A shell pane was read-only

§8 gave the shell case a transcript and said it "keeps plain text input,
because a shell's whole purpose is typing into it". No input route was ever
built, so it shipped read-only.

`pane.send_text {pane_id, text}` and `pane.send_keys {pane_id, keys}` exist and
are the mirror of the agent path's `agent.prompt` / `agent.send_keys`. The
keypad and reply box are reused; the key allowlist stays closed, for the reason
`NavKey` records.

**xterm.js was considered and refused.** It buys real emulation — cursor
addressing, resize, full-screen programs. It costs roughly 80 KB gzipped on top
of a 102 KB bundle, in a project that rejected a 76 KB webfont on the grounds
that it would be the largest payload on a slow link (decision 6), and that
ships one chunk deliberately (decision 5). Typing `claude` or `ls` into a shell
needs neither. Revisit only with a reason that names what emulation is for.

### 16.4 Back went to the wrong place, in the wrong clothes

Two separate defects behind one report. A **shell** pane returned to
`#/spaces` correctly, while an **agent** pane always returned to the dashboard,
discarding where the operator came from. And the Spaces screen's back control
was an unclassed `<button>Back</button>` — the only back control in the app not
using the shared `term-back` treatment with its `‹` chevron.

A pane returns to the surface it was opened from. The control is the shared one.

> **Correction, 2026-08-25.** "A **shell** pane returned to `#/spaces`
> correctly" is false, and it was false when this section was written. The
> shell branch **hard-coded** `#/spaces` regardless of where the pane was
> opened from — which is why a cold deep link (a notification tap, a pasted
> link, a reload) returned the operator to a screen they had never visited.
> That is a different defect from the agent branch's, not the correct reference
> point this section holds it up as.
>
> Both branches now go through one origin-aware rule (`backTargetFor`), keyed
> on the real `hashchange`'s `oldURL`: no recorded origin, no Spaces. The
> sentence above is left in place deliberately — a future reader who trusted it
> would re-derive exactly the same wrong instruction, which is the failure mode
> §9.1 exists to record.

### 16.5 A control marooned by its container

The Spaces entry point sat at the exact horizontal centre of the header,
because a `justify-between` row with three children puts the middle one there.
It belongs grouped with the settings control, so the title owns one end and the
controls read as one cluster.

### 16.6 A shell's label is not its terminal title

The shell row showed `terminal_title_stripped`, which for a pane sitting at a
prompt is the prompt itself — `user@host:~`. That is a poor label, and it puts
the operator's hostname on a screen they may hand to someone or screenshot.

A pane with no agent is labelled by its **cwd**, falling back to the literal
word `shell`. The terminal title is still visible in the pane's own output,
where it belongs.

### 16.7 Where the create controls go, when they arrive

Studied from Collie again: its create control is a quiet icon button living
**inside the section header it creates into** — `+` in the Spaces header for a
new space, `+` in the tabs rail for a new tab. Position carries the scope, so
the button needs no label to say what it makes. No floating action button.

paddock adopts the placement and corrects the size: Collie's is 36 px, below
the 44 px tap target used elsewhere here.

This ships with §7/§9/§10, never before them. The first attempt rendered the
row actions ahead of the sheet that would fill them, and a permanently
`disabled` control announcing "Actions for X" is a mislabelled button — worse
than none. A create control appears in the same change that makes it work.

---

## 17. §13's probes, measured (2026-08-25)

Three of §13's five probes were still open when management work began. Two are
now measured; the third cannot be measured on a working herd and the design
changes to account for that.

**Probe 5 — `tab.create {focus: false}` does not steal focus.** Measured: the
session's `focused_pane_id` and `focused_workspace_id` were unchanged across a
create, and unchanged again after the throwaway tab was closed. So creating
from a phone cannot yank the desktop out from under someone sitting at it,
which is what made this worth measuring rather than assuming.

**Probe 5, extended 2026-08-25 — `workspace.create {focus: false}` does not
steal focus either.** The original probe measured `tab.create` only, and a
comment in `herdr/actions.ts` briefly cited it as covering both. Rather than
soften the comment, the sibling call was measured the same way: a throwaway
space was created with `focus: false`, `focused_pane_id` and
`focused_workspace_id` were unchanged, and both were unchanged again after the
cleanup close. Both create calls are now covered by measurement rather than by
inference from a sibling endpoint.

**Probe 1 — an empty label is ACCEPTED, and it is not a clear.** `tab.rename`
with `label: ""` succeeds and the tab's label becomes the empty string — herdr
does not treat it as "unset" and does not restore the number. paddock happens
to render that as unnamed, because `tree.ts`'s `tabLabel` normalises a falsy
label to `null`, but that is a coincidence of paddock's own normalisation and
not a herdr behaviour to rely on. What herdr's own TUI shows for an
empty-string tab label was not measured and cannot be from here.

**Consequence — there is no "clear" for a tab or a space name.** §7's table was
right to mark them unclearable, for a better reason than it knew: herdr models
no unset state for them, so the only thing an empty submission does is store an
empty string, which is worse than the number it replaces. So:

- **Tab and space rename require a non-empty label.** paddock refuses an empty
  one client-side and server-side, rather than passing it through.
- **Clear exists only where herdr models it** — `agent.rename` with
  `name: null`, which genuinely removes the field (§14.1). That control keeps
  the honest label §7.2 specifies, because clearing an agent's name drops it to
  paddock's `basename(cwd)` fallback rather than restoring a herdr-derived one.

**Implemented (Task 2):** all three routes refuse an empty **or
whitespace-only** label with 400, never forwarding it. Whitespace-only was
never measured either, and it is predictable to go wrong the same way an
empty tab label would: `tree.ts`'s `tabLabel` trims and normalises it to
`null` (rendered as unnamed) while herdr would be storing the literal
whitespace. `null` on `POST /api/agents/:id/name` remains the **only** clear
among the three; `agent.rename {name: ""}` is unmeasured and so is refused
rather than forwarded, on the same reasoning — no UI path submits `""` or
`" "` intentionally, since `null` is already the clear control's payload, so
refusing both forecloses an ambiguous input rather than a real capability.

**Probe 3 — whether the last space may be closed is UNMEASURED, deliberately.**
Establishing the condition means reducing a working herd to one space, and the
only herd available is an operator's live session. So `workspace.close` is
designed to **surface herdr's own refusal verbatim** rather than predict it:
paddock does not pre-emptively disable the control on a count of one, because
that would encode a guess about herdr's policy as a fact. If herdr allows it,
the operator gets what they asked for; if it refuses, they get the reason.
