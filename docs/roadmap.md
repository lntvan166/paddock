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
- ~~**Web Push, the next increment.**~~ *Retired, then built — see
  `docs/decisions.md` decision 23 and
  `docs/design/2026-08-25-web-push-design.md`.* v2 shipped Telegram instead,
  and that reasoning was not wrong: push needs a service worker, a VAPID
  keypair, a permission prompt and a subscription store, where Telegram needs
  a bot token and an HTTPS POST and works on any device already running
  Telegram. **Telegram stays.** What reopened this was the counter-argument
  recorded in the entry below — a Telegram tap cannot open the iOS PWA and only
  push can — and the notifier now fans out to both, neither able to suppress
  the other.

  Two things this entry claimed that turned out otherwise, kept here because
  they are the parts a future reader would repeat:

  - **The missing PWA icons were NOT a blocker.** They were already resolved —
    "Known v1 gaps" below has said so since — and this entry simply never got
    updated. Safari's requirement is real and stands: push reaches a PWA added
    to the Home Screen, never a page merely open in a tab, which is why
    `PushSection` asks for the install before it offers anything else.
  - **The Access constraint is narrower than recorded.** `docs/gotchas.md`
    notes that an expired Access session turns a service-worker *fetch* into an
    HTML login page rather than an error. paddock's worker performs no fetch at
    all — deliberately, and a test asserts the absence — so the hazard cannot
    reach the notification. It reaches the *tap*, which lands on an Access
    login, which is correct.
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

  **Narrower since the journal route shipped:** for an agent whose
  `hasJournal` is true, "Show earlier" now IS an explicit second request —
  `POST /api/agents/:id/history`, reading the harness's own session log
  rather than the reconstructed viewport buffer. `hasJournal` is only a
  hint, though: if the server's per-request answer for that pane ever comes
  back `source: "reconstruction"` (no session ref, a missing or unreadable
  file), the pane falls back to exactly the mechanism this entry describes,
  permanently, for the rest of that pane's life — see
  `docs/decisions.md` decision 18. This entry's description stands unchanged
  for every agent without a journal, which remains most of them in v2, and
  for any journal-hinted agent that has fallen back.

- **Stuck-agent detection**, but NOT on the signal this entry used to name.
  It said "`working` for more than N minutes with no output change", and the
  operator's own usage refutes the first half: a three-hour agent is ordinary
  here, so a timer would fire on every healthy one. Elapsed time is not the
  signal; a liveness one is.

  What paddock has for free, for every agent, is what `agent.list` already
  carries — `state`, `stateSince`, and `task` from `terminal_title_stripped`.
  Output is fetched ON DEMAND only (`POST /api/agents/:id/output`, driven by the
  UI), so the server holds no output for an agent nobody has open: detecting
  "output stopped changing" server-side would mean polling `agent.read` for
  every agent forever, which is new continuous herdr traffic in a project whose
  README sells adaptive polling. `store.ts` already compares `a.task !== b.task`
  to decide whether to emit a delta, so a `taskSince` mirroring `stateSince`
  would be small — but whether that line MOVES while a healthy agent works is
  unmeasured, and `docs/gotchas.md` records nothing about it. Measure that
  before building anything on it; `pane.output_matched` remains unexamined too.

  Deliberately not built: the operator has not hit the failure it would catch,
  and a detector for an unobserved failure resting on an unmeasured heartbeat is
  two guesses stacked.
- **Preact swap** if first-load size disappoints (~45 KB → ~4 KB gzipped,
  same API).
- ~~**Per-agent deep links**~~ (`/#/agent/<name>`) so a notification opens the
  right one. *Done, since v0.2.0.* `agentHash`/`agentIdFromHash` produce and
  parse `#/agent/<id>` and have done since the terminal view first shipped;
  they now live in `src/shared/route.ts` rather than `src/web/route.ts` (which
  re-exports them), because `server/notify/notifier.ts` needs the same format
  to build a Telegram message's deep link and the dependency rule forbids
  server code importing from `web/`.
- ~~**A Telegram tap cannot open the iOS PWA, and only Web Push can.**~~
  *Acted on — this is the argument that reopened the entry above. See
  `docs/decisions.md` decision 23.* The finding itself is unchanged and worth
  keeping:
  Investigated in `docs/design/2026-08-19-notifications-and-settings-design.md`
  §9. iOS opens `https://` links in Safari even when the URL is inside an
  installed web app's scope: there are no `url_handlers`, no protocol handlers
  in Safari, and Universal Links need a native app. Telegram's own `openLink`
  on iOS forces the external browser, making it worse rather than better.

  There is exactly one documented exception: a **Web Push notification from
  the installed PWA opens the PWA** (iOS 16.4+). Two consequences. Safari
  keeps a storage container separate from the Home Screen app, so a Telegram
  tap can mean re-doing a Cloudflare Access login already held in the PWA.
  And the Web Push entry above was retired on the reasoning that Telegram
  "works today on any device" — still true, and this is the evidence on the
  other side of that trade, because push is the only mechanism that lands a
  tap *inside* the app on iOS. What shipped instead is an inline "Open in
  paddock" keyboard button, which is a better tap target and still lands in
  Safari.

- **Spawning an agent from paddock.** Feasible, measured against herdr
  protocol 19, and deliberately unbuilt — see
  `docs/design/2026-08-19-notifications-and-settings-design.md` §10 for the
  full findings. In short: `tab.create` takes
  `{workspace_id?, cwd?, label?, env?, focus}` and `agent.start` takes
  `{name, kind, pane_id, args?, timeout_ms?}` with `kind` a fixed enum
  including `claude`, `codex`, `gemini`, `pi`. Three constraints for whoever
  picks it up. `agent.start` blocks on readiness for up to 30s by default
  while `socket.ts` sets `HERDR_TIMEOUT_MS = 10_000`, so it needs a per-call
  timeout override. `tab.create`'s result shape is not in
  `src/shared/herdr-api.d.ts`, and this repo has already shipped a bug from
  assuming one (`result.text` versus `result.read.text`), so it needs
  `scripts/gen-herdr-types.ts` extended rather than a hand-written literal.
  And it would be paddock's first **creating** action — every action today
  drives an agent that already exists — which deserves its own decisions
  about permitted kinds and where `cwd` may point.

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

- ~~**`--demo` cannot demonstrate the approve path.**~~ *Resolved 2026-08-27,
  and the resolution keeps the distinction this entry was really about.* Demo
  mode used to leave `HerdrActions` unset, so `/output`, `/prompt` and
  `/answer` were never registered and 404'd — honest, and it meant there were
  no screenshots of reading output or answering a prompt.

  `src/server/demo-actions.ts` now serves synthetic READS, so the terminal and
  both Spaces screens render and can be screenshotted. Every WRITE still
  refuses, with a message that reaches the operator through the route's
  existing 502 path — `/answer` does not answer. So the approve path is
  *shown*, never *simulated*, which is the line this entry was drawing: a demo
  that appeared to send a keystroke and did not would be worse than one that
  404s.

  `/ack` remains the one action that genuinely works with no herdr at all, for
  the reason it always did — it touches only paddock's own store and the hub.

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

- ~~**`MAX_READ_LINES` (2000) is not a usable request against an idle
  agent.**~~ *Resolved, by routing around the ceiling rather than raising it.*
  Scrollback lives on the alternate screen, so herdr recovers it by scrolling
  the pane: measured on herdr 0.8.0, `recent_unwrapped` costs ~35 ms per line
  past the viewport — 120 lines took 3.1 s, 300 lines 10.7 s (past
  `HERDR_TIMEOUT_MS`, so `POST /output` with `lines: 300` fails outright), and
  500/1000/2000 lines each took ~15.8 s and returned *less* than `visible`
  returns in 2 ms. The clamp bounded the response size, which was its
  purpose, but not the wall time, and the ceiling was far above what herdr
  could actually serve — no transport timeout or lower ceiling was going to
  make asking herdr for it a good idea, because the bytes past the viewport
  were never retained at all (`docs/gotchas.md`'s alternate-screen entry).
  So this was never fixed by tuning the clamp: `POST /api/agents/:id/history`
  reads a journal-capable harness's own session log instead, and
  `MAX_READ_LINES` still governs exactly what it always did — the
  `visible`/`recent_unwrapped` ceiling for a plain shell pane, which has no
  journal to fall back to and is unaffected by this work.

- ~~**Nothing guards `index.ts`'s call site for the delta fan-out.**~~
  *Resolved.* The two wirings were differently shaped —
  `onDelta: fanOut(hub, notifier)` for herdr and `onDelta: (d) => hub.queue(d)`
  for `--demo` — so an edit that made the first look like the second passed
  every test: the browser fan-out keeps working, nothing user-visible breaks,
  and the notifier never sees another delta.

  Both modes now call one function, `deltaSink` in `server/index-wiring.ts`,
  and the demo says so by passing `null` rather than by omitting a
  destination. The bypass is an argument a reader can see, it is REQUIRED so a
  caller cannot forget the decision, and `tests/notify-wiring.test.ts` pins
  both behaviours — a notifier reaches both destinations, a null still reaches
  the hub — rather than forbidding a shape the demo legitimately wants.
  `fanOut` was retired rather than kept alongside it: two functions doing one
  job is how one of them learns the demo bypass and the other does not.

  Worth recording why this stopped being theoretical. The same shape — a
  decision living in `index.ts`, the one file with no test harness — silently
  disabled the stale-tab bar on every installed paddock for months, because
  `currentBuildId` read `dist/index.html` off disk while the binary served the
  embedded copy. See `build-id.ts`'s `indexHtmlFor`. This entry described the
  hazard; that one is the hazard having already happened somewhere else.

- **Three component tests emit React `act()` warnings that a green
  `make test` doesn't surface.** `tests/settings-view.test.tsx`,
  `tests/prefs-applied.test.tsx`, and `tests/settings-save-bar.test.tsx` (new
  on this branch, for the sticky save bar) each render `<Settings>` and print
  `Warning: An update to Settings inside a test was not wrapped in act(...)`.
  Measured against a full `make test` run: 9, 3, and 20 occurrences
  respectively. Not a regression in the two pre-existing files: at the commit
  this branch forked from, those same two files together already produced 16
  (13 from `settings-view`, 3 from `prefs-applied`) — this branch's own edits
  to `settings-view.test.tsx` in fact lowered that to 9.
  `settings-save-bar.test.tsx` is new, and inherits the same pattern rather
  than avoiding it.

  `tests/support/dom.ts` already sets `IS_REACT_ACT_ENVIRONMENT`, so a missing
  global is not the cause. `tests/support/render.tsx`'s `render()` wraps only
  the synchronous `root.render(node)` call in `act()`, and `settle()` flushes
  exactly one queued microtask per call, inside `act()`. A stubbed `fetch`
  response takes more microtask turns than that to fully resolve — the mock's
  own async function, then `Response.json()`'s parse — so a click followed by
  a fixed one or two `settle()` calls does not always drain the chain before
  the test's last `act()` closes; the trailing `setState` fires after, against
  whatever is still mounted. `settings-save-bar.test.tsx` drives the most
  clicks per test (save, mute, unmute, the test-message button) and produces
  the most warnings; `prefs-applied.test.tsx` barely touches `<Settings>` and
  produces the fewest.

  Not chased down here: the warnings do not fail the suite, and fixing test
  harness timing is out of scope for a docs task. Closing it means replacing
  the fixed-count `settle()` with one that loops flushing microtasks until the
  mocked `fetch` calls are provably settled, rather than guessing a number of
  calls — a change to `tests/support/render.tsx` that every file using
  `stubFetch` would inherit, not a per-file fix.

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

- ~~**`index.ts` exits on any herdr connection failure at startup, not only a
  protocol mismatch.**~~ *Resolved 2026-08-27 by `server/herdr/await-start.ts`.*
  `connectWithWait` wraps `checkProtocol()` plus `supervisor.start()` and
  retries with the keeper's own `backoffWithJitter` for a bounded budget —
  `PADDOCK_HERDR_WAIT_MS`, default 60s, `0` for the old immediate refusal.

  **The retry classification is the decision, not the loop.** Waited on: a
  MISSING socket, and an errno failure against a socket that IS there (herdr
  bound it but is not serving yet, or a stale socket is about to be replaced).
  Never waited on, because time cannot fix any of them: a
  `ProtocolMismatchError` (the keeper's existing rule), a path that is not a
  socket, a path that cannot be examined, and any failure paddock cannot
  diagnose — no errno against a healthy socket, which is a paddock bug or a
  herdr error that already reads as a sentence, and burying it for a minute
  before reporting "herdr never appeared" would describe the wrong problem.
  The `agent.list` shape verdict stays fatal too: that is a LIVE herdr giving
  a real answer.

  **Bounded rather than infinite, deliberately.** The old refusal is good
  advice from a process about to exit — `herdrUnreachableMessage` names the
  path and says to start herdr. Retrying forever would turn a mistyped
  `PADDOCK_HERDR_SOCKET` into a process that hangs with no output. So the wait
  says once that it is waiting (`herdrWaitingMessage`, which deliberately does
  NOT repeat "run paddock again" — an operator who follows that mid-wait kills
  a paddock seconds from coming up), and on expiry prints how long it waited
  over how many attempts before the unchanged refusal.

  **What this does NOT fix:** a herdr that takes longer than the budget, or
  one that dies later and never returns. Docker was already covered —
  `docker-compose.yml` sets `restart: unless-stopped` — and the bare binary
  ships no unit file, so a shipped systemd unit remains the honest answer for
  that and is complementary to this, not replaced by it.

  Two things worth knowing for whoever touches it next. The retry is safe
  because `supervisor.start()` is `reconcile()` then `resubscribe()` then
  `setInterval`: a throw from either await leaves no healing timer behind, and
  `resubscribe()` records its subscription key only after a successful open.
  And `tests/cli.test.ts` plus `tests/startup-errors.test.ts` now set
  `PADDOCK_HERDR_WAIT_MS: "0"` in the env their spawns inherit — `runVerb`'s
  "fails fast (ENOENT), not hang" comment depends on it, and without it the
  `start` case's detached child outlives the `spawnSync` timeout that kills
  only its parent, which is the stray-paddock hazard the entry below warns of.

  The original entry, for the reasoning: The startup block wraps
  `checkProtocol()` and
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

- **Nothing has exercised `agent.start` against a live herdr.** Every other
  write this branch added — `workspace.create`, `tab.create`, the tab and space
  renames, the two closes — was driven against a real herd. The creates, the
  tab/space renames and the closes are written up in
  `docs/probes/2026-08-25-structural-events.md`; the AGENT rename's live
  measurement is separate, in the design doc's §14.2, and that probe never
  covered it. `agent.start` was not exercised at all, and
  `server.agent_manifests` only as a schema read. So the spawn path is built
  from the schema plus fakes, which is exactly the combination that produced
  this branch's one measured-false assumption: `tab.create` "returns a bare
  `TabInfo`, therefore the new pane must be found by re-reading the snapshot" —
  read correctly off the type, wrong about the envelope, and persuasive enough
  in writing to pre-empt its own objection (see §9.1's dated correction). The
  same reasoning is load-bearing here and has had no contact with a running
  herdr.

  Named precisely, what remains unproven:

  - That the `{name, kind, pane_id, args?, timeout_ms?}` body shape is
    **accepted at all** — field names, nesting, and whether `args` and
    `timeout_ms` are optional in practice rather than merely `?` in the schema.
  - That `timeout_ms: 30000` is accepted. The bound paddock respects
    (`> 3000 && ≤ 300000`) is read from the schema's documentation, not
    measured; `tests/create-routes.test.ts` asserts paddock stays inside it,
    which proves paddock's arithmetic and nothing about herdr's.
  - That herdr accepts a **slug** as `name` — its charset (paddock's `slug`
    emits `[a-z0-9-]`) and its length (paddock bounds it at `MAX_LABEL_LEN`,
    herdr at nothing known) are still unmeasured.

    **The collision half is now measured, from use rather than from a probe.**
    An operator cleared an agent's name and renamed it back to a name another
    agent held; herdr REFUSED, and `agent.rename` is where it surfaced:

        herdr agent.rename failed [agent_name_taken]: agent name obsidian is
        already used; candidates: terminal_id=… pane_id=… workspace_id=…
        cwd=<absolute path> status=Idle

    So of "refuses, renames, or accepts a duplicate" the answer is REFUSES,
    with a machine-readable code. Two consequences already acted on: the route
    translates `agent_name_taken` into a sentence an operator can act on, and
    it stops relaying that message verbatim — it carries a terminal id, a pane
    id and the agent's absolute working directory, and `detail` is rendered
    in the UI. Every
    other herdr failure is still relayed word for word, because a message
    paddock does not recognise is one it must not paraphrase.

    Note this says nothing about `agent.start`, which is what this section is
    about: a rename collides against agents that already exist, where a spawn
    might collide earlier or differently. Still unproven there.
  - That the ~30 s block **resolves** rather than surfacing a false "the agent
    did not start". `HERDR_TIMEOUT_MS` is 10 s and this call overrides it
    per-call; if that override does not take effect the way the schema implies,
    every successful spawn reports as a failure after ten seconds, which is the
    single worst outcome on this path — the operator is told a thing failed
    that in fact worked.
  - That the success path **promotes the pane from shell to agent in the UI**
    and clears the launch notice. That transition crosses the whole stack
    (herdr event → adapter → store → hub → the pane screen's own state), and
    every test of it drives a fixture.

  **Why it was not measured:** spawning a coding agent spends the operator's
  harness quota, on their machine, and that was not authorised. This is a real
  reason, not a deferral of convenience — but it does mean the gap is a
  standing one rather than one that closes itself, so it is written here rather
  than left implicit in a test file's fixtures.

  **What the first live spawn should verify, in order:** send the body exactly
  as `actions.ts` builds it and record the raw request and the raw result, the
  way the structural-events probe does — the envelope, not just the happy
  field; then a slug `name` that collides with an existing agent; then the
  elapsed time to resolution against the 30 s override; then that the pane's
  row in `#/spaces` changes from shell to agent and `LaunchNotice` clears
  without a reload. One spawn answers the first three; the fourth needs only
  that the operator watch the phone while it happens.

- ~~**The schema-drift guarantee does not cover the four write-call
  envelopes added for spaces/tabs management.**~~ *Resolved.* `HerdrTabCreated`
  (`tab.create`), `HerdrWorkspaceCreated` (`workspace.create`),
  `HerdrAgentStarted` (`agent.start`) and `HerdrAgentManifests`
  (`server.agent_manifests`) all turned out to be reachable the same way
  `pane_read` already was: as anonymous members of
  `success_response.$defs.ResponseResult`'s `oneOf`, discriminated by
  `properties.type.const`, even though none of the four is a named
  top-level `$def`. An earlier version of this entry said there was
  "nothing named to compare against" for these three — that was checked
  only against `$defs` directly and never against `ResponseResult`'s
  `oneOf`, and was wrong; a reviewer caught it in the same round that also
  caught this entry's stale `AgentManifestInfo` field count (see below).
  `tests/herdr-schema-drift.test.ts` now runs `expectNoDrift` for all four
  against the live schema, matching the treatment every other payload type
  in that file already gets, with each ignore list named individually:
  `HerdrAgentStarted` ignores `argv` (a required array of the launch
  command's arguments, upstream), and `HerdrAgentManifests` ignores
  `last_check_unix` and `last_result` (herdr's own background
  update-check bookkeeping, not per-manifest data). Neither `argv` nor
  those two fields was captured by
  `docs/probes/2026-08-25-structural-events.md` — that probe only ever
  drove workspace/tab create-rename-close traffic, never `agent.start` or
  `server.agent_manifests` — so both are cited to this live schema
  directly rather than, incorrectly, to that probe. `HerdrAgentManifest`
  — the payload type of one element of `manifests[]` — was already fully
  guarded from the start, against the named `AgentManifestInfo` `$def`,
  with its own ignore list (9 fields: `active_version`,
  `cached_remote_version`, `local_override_shadowing_remote`,
  `remote_last_checked_unix`, `remote_update_error`, `remote_update_result`,
  `source`, `source_kind`, `warning`).
