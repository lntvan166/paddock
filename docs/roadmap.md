# Roadmap

Not built in v1. Recorded here so a gap is a documented decision, not a
surprise.

## Backlog

- **Multi-host.** Several machines push to one tunnel-owning hub. Machine
  visibility scoped by Cloudflare Access identity — Access forwards the
  authenticated user, so per-user filtering is achievable. Seams already in
  place: `hostId` on every record, and reserved `paddock agent` / `paddock hub`
  verbs that exit with a pointer here rather than doing anything silently
  wrong. **Not yet in place:** `server/state/store.ts` keys its `Map` by
  `agentId` alone (the herdr `pane_id`), not `${hostId}:${agentId}`. That is
  correct for one host, but two hosts can hand out colliding `pane_id`s, so
  multi-host requires re-keying the store before it can hold more than one
  host's agents at once.
- **Adopt a linter.** `make check` currently runs only `bunx tsc --noEmit`;
  there is no linter configured. Add one deliberately, as its own task, rather
  than folding it into an unrelated change.
- **Web Push, the next increment.** VAPID keypair, service worker,
  subscription store, behind a flag so a broken subscription can never break
  the dashboard. On iOS, Safari delivers push only to a PWA that has been
  added to the Home Screen — never to a page merely open in a tab — so
  onboarding must say so plainly. That requirement is also what makes the
  missing PWA icons (see "known gaps" below) load-bearing rather than
  cosmetic: an install prompt with a generic icon is a weaker nudge to add to
  the Home Screen, and the Home Screen add is the only way iOS delivers push
  at all.
- **Stuck-agent detection.** `working` for more than N minutes with no output
  change is worth surfacing. `pane.output_matched` may serve.
- **Preact swap** if first-load size disappoints (~45 KB → ~4 KB gzipped,
  same API).
- **Per-agent deep links** (`/#/agent/<name>`) so a notification opens the
  right one.

## Known v1 gaps

- ~~**`done` is sticky (spec §14 question 4).**~~ *Resolved.* herdr derives
  `done` from idle-plus-*unseen*, where "seen" means the tab was focused in
  the herdr desktop UI, so reading over the socket never clears it at the
  source. v2 tracks a paddock-local `acknowledgedAt` on `Agent` instead (see
  `docs/decisions.md`): dismissing a card sets it, `carryAcknowledged` keeps
  it while the agent stays `done` and clears it the moment the agent isn't,
  and `sectionFor` routes an acknowledged `done` agent to **Idle** instead of
  **Needs you**. herdr's own `done` flag is untouched — paddock just stops
  surfacing it.

- **No pull-to-refresh (spec §7.6).** "Pull-to-refresh forces a reconcile" was
  never implemented, and was missing from the implementation plan's own
  coverage table too, so it fell between tasks rather than being declined.
  Nothing user-initiated forces a reconcile: the healing 30s timer, herdr's
  own push, and a reconnect are the only paths. Note that a reconnect already
  delivers a fresh snapshot, so the gap is the affordance and the sense of
  control, not correctness — which is why it is a gap and not a defect.

- ~~**No agent detail sheet / side panel (spec §6).**~~ *Done.* v2 ships
  `web/components/AgentDetail.tsx`: tapping a card or row opens it over the
  agent's output plus, while `blocked`, its parsed prompt options and a
  free-text reply — see `docs/architecture.md`. The approve path is now built
  too: tap-to-answer a blocked agent's real prompt options
  (`agent.send_keys` / `agent.prompt`) via the same sheet. Spec §5's explicit
  refresh control ships with it, so an idle or working agent's transcript is
  not frozen at the moment the sheet opened; output is still never streamed.

- **No motion.** Spec §6 calls for a cross-fade on the state dot and an
  animated section move; neither ships. A partial implementation would signal
  change inconsistently, and animating a section move properly needs FLIP or
  View Transitions, which v1 never scoped.

- **No React render test for `App.tsx`, and none for `AgentDetail`'s stateful
  half.** The repo has no DOM test environment, so section-order rendering
  (which agent lands in which section) is guarded at the data layer only, not
  by a rendered-output test. `App.tsx`'s `key={openAgent.agentId}` — the fix
  that stops one agent's in-flight action landing on another's sheet — was
  reviewed but never tested, and the same is true of the effect inside
  `AgentDetail` that bumps `promptSeq`, releases `busy`, and refetches on a
  state change. What *is* covered: `AgentDetailView` is hook-free, so
  `tests/detail-render.test.tsx` renders it with `renderToStaticMarkup` (no
  DOM, no new dependency) and asserts the placement rules — the result line
  outside the `blocked`-only section, feedback and typed reply hidden once
  their prompt is superseded. Nothing simulates a click or an effect; closing
  that needs a DOM environment, which is its own task.

- ~~**Task 2 was never run.**~~ *Done.* Probed against a real Claude Code
  permission prompt: the option list **is** parseable, options are numbered
  with `❯` marking the selection, and answering by option digit works end to
  end. Tap-to-answer is confirmed feasible. See
  `docs/design/2026-08-17-paddock-plan2-design.md` §2 for the findings and the
  two constraints they impose.

- **PWA manifest has no icons.** Installable, but unbranded — the install
  prompt shows a generic icon.

- **`--demo` cannot demonstrate the approve path.** Demo mode has no herdr to
  act on, so `index.ts` leaves `HerdrActions` unset and `/output`, `/prompt`
  and `/answer` are never registered: they 404 there, honestly, rather than
  synthesising an answer from a fake agent. `/ack` *is* registered in demo mode
  — it touches only paddock's own store and the hub, and spec §7 sends nothing
  to herdr for it — so dismissing a finished card is the one v2 action that
  works with no herdr at all. Since README screenshots come from `--demo`,
  there are no screenshots of reading output or answering a prompt.

- **No service worker ships in v1.** The "no auth token so `/sw.js` still
  works" reasoning in `docs/decisions.md` is therefore documented but
  untested against a real service worker.

## Known v2 gaps

- **The schema-drift guarantee does not cover v2's herdr calls.** `CLAUDE.md`
  and `docs/gotchas.md` both state that a herdr field rename becomes a build
  error. That holds for v1's three payloads only — `AgentInfo`,
  `WorkspaceInfo`, and the `pane.agent_status_changed` event — which are the
  three `src/shared/herdr-api.d.ts` declares and the three
  `tests/herdr-schema-drift.test.ts` checks against the installed herdr.

  **Not covered:** `agent.read`, `agent.send_keys`, `agent.prompt` and
  `agent.wait` in `src/server/herdr/actions.ts`. Their params are hand-written
  object literals and their responses are ad-hoc casts (`request<{ text?:
  string }>`), so neither the generator nor the drift test sees them. A rename
  of the read response's `text` would compile, run, and produce an empty output
  pane with `options: null` — a silent degradation of exactly the kind the
  drift test exists to prevent, since `options: null` is a legitimate outcome
  the UI is built to accept.

  Closing this means extending `scripts/gen-herdr-types.ts` to the request
  params and response shapes of those four methods and adding them to the drift
  test — a task-sized piece of work the v2 plan never scoped, deliberately
  recorded here rather than half-done. **Until then, treat a herdr protocol
  bump as requiring a manual re-read of `actions.ts` against the live schema.**
