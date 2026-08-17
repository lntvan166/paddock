# Roadmap

Not built in v1. Recorded here so a gap is a documented decision, not a
surprise.

## Backlog

- **Multi-host.** Several machines push to one tunnel-owning hub. Machine
  visibility scoped by Cloudflare Access identity — Access forwards the
  authenticated user, so per-user filtering is achievable. Seams already in
  place: `hostId` on every record, and reserved `paddock agent` / `paddock hub`
  verbs that exit with a pointer here rather than doing anything silently
  wrong.
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

- **No motion.** Spec §6 calls for a cross-fade on the state dot and an
  animated section move; neither ships. A partial implementation would signal
  change inconsistently, and animating a section move properly needs FLIP or
  View Transitions, which v1 never scoped.

- **No React render test for `App.tsx`.** The repo has no DOM test
  environment, so section-order rendering (which agent lands in which
  section) is guarded at the data layer only, not by a rendered-output test.

- **Task 2 was never run.** The blocked-agent detection probe (spec §14
  question 1) requires a real blocked agent to verify that the `detection`
  snapshot contains a parseable prompt-option list. Until it runs, whether
  tap-to-answer is feasible at all remains unvalidated, and the v2 approve
  path above is unconfirmed rather than merely unbuilt.

- **PWA manifest has no icons.** Installable, but unbranded — the install
  prompt shows a generic icon.

- **No service worker ships in v1.** The "no auth token so `/sw.js` still
  works" reasoning in `docs/decisions.md` is therefore documented but
  untested against a real service worker.
