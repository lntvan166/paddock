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
- **History on demand in the terminal view.** `POST /output` already takes
  `{scrollback: true}` and the server side is tested, but nothing in the UI
  sends it. It used to be sent automatically for `idle` agents on open, and
  that was removed: the refresh loop reads `visible`, the two sources return
  different content, so the digest could never match — and suppressing the
  poll to stop the pane oscillating left it FROZEN. The reasoning given for
  that suppression ("an idle agent by definition is not producing output") was
  wrong: `idle` means ready for input, and a pane changes the moment anyone
  types at the desk. Bringing history back means an explicit control plus a
  visible "showing history / back to live" mode, so the operator always knows
  whether the screen tracks reality — not a hidden second request.

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

- **The schema-drift guarantee covers v2's READ call only.** `CLAUDE.md` and
  `docs/gotchas.md` both state that a herdr field rename becomes a build
  error. That holds for v1's three payloads — `AgentInfo`, `WorkspaceInfo`,
  and the `pane.agent_status_changed` event — plus the `agent.read` response
  envelope (`HerdrPaneRead` / `HerdrPaneReadResult`), which
  `src/shared/herdr-api.d.ts` declares and `tests/herdr-schema-drift.test.ts`
  checks against the installed herdr.

  The read call was added because the gap this entry used to describe stopped
  being hypothetical: `actions.ts` read `result.text` from `agent.read` for
  the whole of v2, herdr sends the text at `result.read.text`, and the
  predicted failure — an empty output pane and `options: null` degrading
  tap-to-answer to the free-text box — is exactly what shipped, found by
  running against a live herdr rather than by a test.

  **Still not covered:** `agent.send_keys`, `agent.prompt` and `agent.wait`,
  and the request *params* of all four methods, which remain hand-written
  object literals. Their responses are known (`{ type: "ok" }`,
  `{ type: "agent_prompted", agent }`, `{ type: "agent_info", agent }` —
  measured against herdr 0.8.0 and reflected in `tests/actions.test.ts`'s
  fakes) but are not typed, and none of the three is read for a value, so a
  drift there fails loudly at the socket rather than silently. That is why
  the read path was closed first.

  Closing the rest means extending `scripts/gen-herdr-types.ts` to the request
  params and remaining response shapes and adding them to the drift test — a
  task-sized piece of work the v2 plan never scoped, deliberately recorded
  here rather than half-done. **Until then, treat a herdr protocol bump as
  requiring a manual re-read of `actions.ts` against the live schema.**

- **`MAX_READ_LINES` (2000) is not a usable request against an idle agent.**
  Scrollback lives on the alternate screen, so herdr recovers it by scrolling
  the pane: measured on herdr 0.8.0, `recent_unwrapped` costs ~35 ms per line
  past the viewport — 120 lines took 3.1 s, 300 lines 10.7 s (past
  `HERDR_TIMEOUT_MS`, so `POST /output` with `lines: 300` fails outright), and
  500/1000/2000 lines each took ~15.8 s and returned *less* than `visible`
  returns in 2 ms. The clamp bounds the response size, which was its purpose,
  but not the wall time, and the ceiling is far above what herdr can actually
  serve. Fixing it properly means either a much lower scrollback ceiling or a
  transport timeout that scales with the request; both are policy decisions
  the read-source fix deliberately did not make on its own.
