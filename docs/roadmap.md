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
- ~~**Web Push, the next increment.**~~ *Superseded, not built.* v2 shipped
  Telegram notifications instead of Web Push — see
  `docs/design/2026-08-18-settings-and-telegram-design.md` for the reasoning.
  In short: Web Push needs a service worker, a VAPID keypair, a permission
  prompt, and a subscription store, all behind a flag so a broken subscription
  can never break the dashboard; Telegram needs a bot token and an HTTPS POST
  and works today on any device already running Telegram. The iOS constraint
  stays on record here for whoever revisits push, because it does not go away
  on its own: Safari delivers push only to a PWA that has been added to the
  Home Screen — never to a page merely open in a tab — so onboarding would
  have to say so plainly, which is also what would make the missing PWA icons
  (see "Known v1 gaps" below) load-bearing rather than cosmetic. Also on
  record for that revisit: `docs/gotchas.md`'s "Deployment and Access" notes
  that an expired Access session turns a service-worker fetch into an HTML
  login page, not an error, which constrains what a push payload can assume
  before a single line of it is written. Telegram sidesteps that constraint
  entirely — Access gates paddock's own hostname, never `api.telegram.org`.
- ~~**History on demand in the terminal view.**~~ *Resolved, but not as this
  entry described.* `POST /output` still accepts `{scrollback: true}` and the
  server side is still tested (`tests/actions.test.ts`,
  `tests/action-routes.test.ts`), but the request this entry describes —
  sent from the UI to fetch history on demand — is deliberately never made:
  `src/web/api.ts` defaults `scrollback` to `false` and no caller overrides
  it. What shipped instead is `src/web/history.ts`, which reconstructs a
  transcript from the viewport snapshots the terminal is already polling for:
  a window of lines from the top of each new snapshot is matched against the
  previous one, and only the lines that offset proves scrolled off the top
  are committed to history. That makes it a VIEWER, not a recorder — an agent
  nobody had open still has no history, and a scroll bigger than half the
  visible screen between polls is recorded as a gap rather than guessed at
  (see that file's header comment for the measurement behind the approach).
  There is no explicit "show history" control and no hidden second request;
  see `README.md`'s "What it does not do".

- **Stuck-agent detection.** `working` for more than N minutes with no output
  change is worth surfacing. `pane.output_matched` may serve.
- **Preact swap** if first-load size disappoints (~45 KB → ~4 KB gzipped,
  same API).
- ~~**Per-agent deep links**~~ (`/#/agent/<name>`) so a notification opens the
  right one. *Done, since v0.2.0.* `agentHash`/`agentIdFromHash` produce and
  parse `#/agent/<id>` and have done since the terminal view first shipped;
  they now live in `src/shared/route.ts` rather than `src/web/route.ts` (which
  re-exports them), because `server/notify/notifier.ts` needs the same format
  to build a Telegram message's deep link and the dependency rule forbids
  server code importing from `web/`.

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

- ~~**No DOM test environment.**~~ *Partly resolved.* `tests/support/dom.ts`
  registers happy-dom for component tests, and `tests/terminal-render.test.tsx`
  covers the terminal's effects and wiring — the layer three defects reached
  the browser through in a single cycle. Mutation-checked: breaking the Enter
  preview, the option-button guard, the error surface or the keypad's
  always-present rule each fails a test.

  **Still not covered:** `App.tsx` — routing, cache pruning and the
  stale-build bar have no render test, and neither does the refresh loop's
  timing, which needs fake timers. The DOM is imported per-file rather than
  preloaded, because a global preload gives server tests a DOM they must not
  have.

- ~~**PWA manifest has no icons.**~~ *Resolved.* `public/` now carries 192,
  512 and maskable icons plus an `apple-touch-icon`, and `index.html` links a
  favicon. This was load-bearing rather than cosmetic: Safari delivers Web
  Push only to a PWA added to the Home Screen, so a generic install prompt was
  a weaker nudge toward the one action that makes notifications possible on
  iOS at all.

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

- **Nothing guards `index.ts`'s call site for the delta fan-out.**
  `fanOut()` in `server/notify/notifier.ts` is covered
  (`tests/notify-wiring.test.ts`) and breaking its body turns that test red,
  but `index.ts` wires it in with one line —
  `onDelta: fanOut(hub, notifier)` — that no test touches. A future edit to
  `index.ts` that bypassed `fanOut` entirely and went back to
  `onDelta: (d) => hub.queue(d)` would pass every test in the suite while
  silently disabling notifications: the browser fan-out still works, so
  nothing user-visible breaks, and the notifier simply never sees another
  delta again. Closing this means moving that composition out of `index.ts`
  into a side-effect-free module a test can import directly, without booting
  `Bun.serve` and the herdr socket the way exercising `index.ts` itself
  would require. Note that the `--demo` branch one `if` away is a legitimate
  instance of exactly that bypass — it wires `onDelta: (d) => hub.queue(d)`
  deliberately, so a demo run cannot fire real Telegram messages about
  synthetic agents — so whatever closes this gap has to distinguish the two
  call sites rather than forbid the shape.

## Known v3 gaps

- **No signature on release binaries — checksums only.** `install.sh` and
  `paddock update` both refuse to write a binary whose SHA-256 does not match
  `SHA256SUMS`, and that file is published on the same GitHub release as the
  binaries it describes. Be precise about what that buys: it defends against
  a corrupted download and a broken TLS path, and **not** against a
  compromised release or a compromised GitHub account — anyone who can
  replace the binary can replace its checksum file in the same breath. Real
  protection needs a signature from a key that does not live on GitHub, and
  that is deliberately not built here: key management (generation, rotation,
  where the private key is held, how a compromise is detected and revoked) is
  its own project, and a signing key sitting in CI secrets so a workflow can
  sign on every tag is exactly the setup that would leak it — a key reachable
  by CI is no more protected than the artifact it signs. This matters more
  for paddock than for most command-line tools: paddock can send keystrokes
  and free text to coding agents and answer their permission prompts, so a
  tampered update is not merely a bad dashboard, it is a remote hand on every
  agent paddock can reach.

- **`index.ts` exits on any herdr connection failure at startup, not only a
  protocol mismatch.** The startup block wraps `checkProtocol()` and
  `supervisor.start()` in one `try`/`catch` and calls `process.exit(1)` for
  either a `ProtocolMismatchError` or anything else the two throw — so a
  herdr that simply is not up yet (socket refused, socket absent) kills
  paddock exactly the same way an incompatible herdr version would. That is
  inconsistent with the liveness and retry model `docs/architecture.md`
  describes: `herdr/keeper.ts`'s jittered-backoff reconnect only arms once
  `supervisor.start()` has already succeeded once, so it never gets a chance
  to run here. A paddock started before herdr — an ordering that `systemd`,
  Docker Compose, or a plain reboot cannot promise — dies instead of waiting
  for it. Fixing this means distinguishing "herdr is not reachable yet"
  (retry) from "herdr answered with an incompatible protocol" (fatal, as
  today); found while working on this branch and deliberately left unfixed
  rather than folded into an unrelated change.

- **The state file's `port` and `startedAt` are not shape-checked.**
  `checkState` validates `pid` as a number and `args` as a string and stops
  there, so a file whose `port` is a string, or whose `startedAt` is missing,
  passes the guard and reaches `runStatus` — which prints `port undefined` and
  `up NaNm` rather than refusing. Deliberately not urgent: every decision that
  can signal a process rests on `pid` and `args`, and those two ARE validated,
  so the worst outcome here is a nonsense line of output, not a stranger's
  process being killed. Closing it means deciding what a partially-valid state
  file *is* — a `mismatch`, an `unreadable`, or a sixth variant — which is a
  policy question the fix wave that found it deliberately did not answer in
  passing.

- **Nothing asserts `writeState`'s `chmod(tmp, 0o600)`.** The mode test reads
  the mode of the finished file, which `open(tmp, "w", 0o600)` already
  provides whenever it creates the file — so deleting the explicit `chmod`
  leaves the suite green. The `chmod` is not redundant: `open`'s mode
  argument applies **only on creation**, measured — a pre-existing path
  reopened with `"w"` keeps its old mode (0666 stays 0666). So the line
  defends the case where a `paddock.state.json.tmp` was left behind with
  looser permissions by an earlier crash, and a test for it has to pre-create
  that tmp path rather than call `writeState` on a clean directory.

- **Two foreground paddocks sharing one config dir clobber each other's
  state.** `PADDOCK_PORT` makes two simultaneous instances possible and
  `PADDOCK_CONFIG_DIR` is what keeps them apart, but nothing enforces that the
  operator actually varied the second one: the state file is written
  unconditionally after a successful bind, so instance B on a different port
  overwrites A's file, and A becomes untrackable — `stop` will only ever find
  B. The design calls per-instance isolation "free", which it is, and this is
  the footnote: free, and unenforced. Closing it means deciding what B should
  do when it binds a port and finds a *live, matching* state file for a
  different pid — refuse to start, or record both — and neither is obviously
  right for a tool whose whole posture is refusing to guess.

- **`removeState` failures escape the lifecycle commands unguarded.**
  `index.ts`'s exit handler wraps its `removeState` in a `.catch`, but every
  `await removeState(o.dir)` in `commands.ts` is bare. `rm(..., { force: true })`
  swallows ENOENT and nothing else, so a config dir that has become
  unwritable turns a `stop` that genuinely worked — SIGTERM sent, process
  gone — into an unhandled rejection and a stack trace, after the useful work
  is already done. The failure is worth reporting; what it must not do is
  replace the outcome the operator asked about.

- **`tests/cli.test.ts` can leave a detached paddock behind.** Its
  `runVerb("start")` case spawns a real `paddock start`, and `spawnSync`'s
  timeout kills only that parent — the detached child is in its own session
  now, so it would survive a process-group kill too. Today nothing is left
  behind, but only because the bogus `PADDOCK_HERDR_SOCKET` those tests use
  makes the child fail fast; the test asserts nothing about the child and
  cleans nothing up, so a change that let it live would start leaving a stray
  paddock behind after every `make test`. Closing it means reading the state
  file the child writes and killing that pid in a `finally`, the way
  `tests/lifecycle-detach.test.ts` does.
