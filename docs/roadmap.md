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
- **Web Push.** VAPID keypair, service worker, subscription store, behind a
  flag so a broken subscription can never break the dashboard. On iOS, Safari
  delivers push only to a PWA added to the Home Screen — onboarding must say
  so plainly.
- **Stuck-agent detection.** `working` for more than N minutes with no output
  change is worth surfacing. `pane.output_matched` may serve.
- **Preact swap** if first-load size disappoints (~45 KB → ~4 KB gzipped,
  same API).
- **Per-agent deep links** (`/#/agent/<name>`) so a notification opens the
  right one.
- **The approve path** (tap-to-answer a blocked agent's real prompt options,
  `agent.send_keys` / `agent.prompt`). v1 is read-only by design; see "known
  gaps" below for why this is unconfirmed rather than merely deferred.

## Known v1 gaps

- **`done` is sticky (spec §14 question 4).** herdr derives `done` from
  idle-plus-*unseen*, where "seen" means the tab was focused in the herdr
  desktop UI; reading over the socket does not clear it. So an agent answered
  from the phone stays `done` and remains in **Needs you** until the operator
  returns to the desk. Options are to accept it, or to track a paddock-local
  "acknowledged" flag that dismisses the card without lying to herdr.
  Unresolved by design — decide before building any acknowledge affordance.

- **No pull-to-refresh (spec §7.6).** "Pull-to-refresh forces a reconcile" was
  never implemented, and was missing from the implementation plan's own
  coverage table too, so it fell between tasks rather than being declined.
  Nothing user-initiated forces a reconcile: the healing 30s timer, herdr's
  own push, and a reconnect are the only paths. Note that a reconnect already
  delivers a fresh snapshot, so the gap is the affordance and the sense of
  control, not correctness — which is why it is a gap and not a defect.

- **No agent detail sheet / side panel (spec §6).** The component tree calls
  for `<AgentDetail/>` — a sheet below 640px, a side panel above — showing one
  agent's full task line, workspace, cwd and elapsed time. The plan deferred
  it and never carried the deferral anywhere visible; recorded here now.
  v1 shows everything it has on the list itself, so nothing is unreachable,
  but a long task line is truncated with no way to read the rest.

- **No motion.** Spec §6 calls for a cross-fade on the state dot and an
  animated section move; neither ships. A partial implementation would signal
  change inconsistently, and animating a section move properly needs FLIP or
  View Transitions, which v1 never scoped.

- **No React render test for `App.tsx`.** The repo has no DOM test
  environment, so section-order rendering (which agent lands in which
  section) is guarded at the data layer only, not by a rendered-output test.

- ~~**Task 2 was never run.**~~ *Done.* Probed against a real Claude Code
  permission prompt: the option list **is** parseable, options are numbered
  with `❯` marking the selection, and answering by option digit works end to
  end. Tap-to-answer is confirmed feasible. See
  `docs/design/2026-08-17-paddock-plan2-design.md` §2 for the findings and the
  two constraints they impose.

- **PWA manifest has no icons.** Installable, but unbranded — the install
  prompt shows a generic icon.

- **No service worker ships in v1.** The "no auth token so `/sw.js` still
  works" reasoning in `docs/decisions.md` is therefore documented but
  untested against a real service worker.
