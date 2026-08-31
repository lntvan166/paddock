# Gotchas

Failure modes observed in a comparable system, or found while building this
one, recorded here so they are not reintroduced.

| Failure | Cause | Design response |
|---|---|---|
| A spotlight lands on the previous screen's layout | The hash was set and the anchor measured in the SAME tick — the browser sibling of the `send-keys a b c` entry below. It looks right on a development machine and wrong on a phone | `awaitAnchor` resolves only once the element is in the document; the rect is read after that. Never measure across a repaint |
| A spotlight lands on a control that is off-screen | Waiting for the repaint is not enough when the thing also has to be SCROLLED to. The tour locked the page at the hero, where the phone is barely peeking, and lit controls at y=1220 in a 900px window | Scroll the phone into view before locking, scroll the anchor into view inside the frame, and wait a frame for both before measuring |
| A guided step skips the next one entirely | The escape hatch clicked the anchor — firing the same listener a real tap does, which advances — and then called `showMe()` as well. 01 jumped to 03 | Advance BY ANCHOR, which is idempotent: once the click has advanced, the stale anchor no longer matches the current step and is ignored |
| An overlay renders with no colours at all, and nothing fails | Its tokens were defined in a stylesheet the page does not load. An undefined custom property inside a `box-shadow` or `outline` invalidates the whole declaration — so the scrim and the spotlight were simply absent while the tour "ran" | Tokens live beside their only consumer. `tests/tour-contrast.test.ts` asserts every `var(--tour-*)` used is also defined |
| An external link traps an installed PWA with no way back | `"display": "standalone"` runs chromeless, and a same-window cross-origin navigation used to render INSIDE the app shell — no browser chrome, no back button, force-quit to escape | `target="_blank" rel="noopener noreferrer"`. `tests/external-links.test.ts` asserts it on every external `href` in `src/web/`, because the attribute is invisible and load-bearing |
| The whole page scrolls sideways on a phone | `max-width: 100%` on an `inline-block` that also has `overflow-x: auto` does not cap it — the install one-liner pushed the body 8px past the viewport | The scroll container is the PARENT. Wide content scrolls inside its own box; the page body never does |
| A build silently publishes with half its content missing | Two vite builds pointed at overlapping output directories; `emptyOutDir` let the second delete the first, and the deploy went green with no demo in it | Assemble by moving, in a script that THROWS when an input is absent |
| Add to Home Screen installs the wrong page | `manifest.webmanifest` sets `"start_url": "."`, which resolves against the MANIFEST's location. An app under `/app/` whose manifest sat at the site root installed the landing page | Each build keeps its own `public/`, so the manifest ships beside the app it describes |
| Every row shows the same label | Label derived from `basename(cwd)`; agents commonly share a working directory | `name` from `agent.list` is the primary label. `basename(cwd)` is the fallback for an unnamed agent, and ONLY with the disambiguation `toAgents` adds — this is the defect the project exists to prevent |
| A field is always empty | Read from the wrong object (pane vs workspace vs agent) | Generated types make a rename a build error — the v1 payloads, the `agent.read` envelope, the four structural write envelopes, and (since protocol 20) the request params and response envelopes of `agent.send_keys`, `agent.prompt`, `agent.wait` and `agent.read`. `actions.ts` asserts each request body with `satisfies`, so a drift fails where the request is built, not only in a test |
| Events dropped with no error | Push script ends `curl -s … >/dev/null 2>&1; exit 0` | Log receipt at INFO; `/api/health` exposes `lastEventAt` |
| Sensitive paths in access logs | Payload sent as a GET query string | POST bodies only |
| A subprocess's log lines flash and vanish | Child output and a once-a-second `ESC[H ESC[J` repaint share stdout | Buffer the child's lines while the display owns the screen, print the tail on every failure path — never silence them |
| The screen claims a tunnel is up while it is dying | `^C` signals the whole process group, so the child begins shutdown before the draw timer is cleared | Clear the block in teardown; a stale frame asserting the opposite is worse than no frame |
| `stop` says "not running" while the port stays held, for ever | ONE state file per config dir, but paddock is per-PORT: a second instance (`PADDOCK_PORT=…`, a `--demo`, `paddock tunnel`) overwrote the first's record on start, and the first to EXIT deleted the file outright — so the instance holding the dashboard's port became permanently untrackable, and `stop && start` walked into "port already in use" | First instance wins: `recordState` refuses to write over a *running* record for a different pid, and servers clear their record with `removeOwnState`, which deletes only their own. `status`/`stop` probe the port when no record exists and name what is serving, because "not running" was a lie told about a live process |
| `paddock update` looks complete but the dashboard stays on the old version | Replacing the binary does not restart the process running it — `/proc/<pid>/exe` reads "… (deleted)" and it serves the old build until bounced | `update` reports the pid, port and version still running and the exact restart command. Told, NOT done: restarting would drop every connected phone mid-session to finish a command run for the binary's sake |
| A shutdown the operator ASKED for is reported as the tunnel failing | Same process group: the child dies at the same moment the teardown runs, and the race watching `child.exited` cannot tell a requested death from a crash — so `^C` printed `cloudflared exited 143 — the URL is gone` plus a tail that, on a tunnel up for half an hour, was its SUCCESSFUL startup prechecks | Gate that branch on `stopping`. Quieting a diagnosis is only safe where there is nothing to diagnose: the live shutdown lines, the closing report, and a failed kill's warning and non-zero exit all remain |
| The URL is the fourth line printed | Boot diagnostics log as they happen, and the port is not bound until after them | Collect boot facts, emit one summary line, then the banner (`boot-log.ts`) |
| Service worker silently disabled | Auth check gates every route including `/sw.js` | No app token; Access is the gate — its cookie rides a same-origin fetch, a bearer token has nothing to ride |
| Works on one hostname, not another | Hostname allowlist in the client | Derive the WebSocket URL from `location`, unconditionally |
| Route order load-bearing | Hand-rolled request dispatch | Hono's explicit routing |
| A repeated alert never fires again | Dedup key too coarse; a failed send consumes the attempt | Dedup on the state transition; a failed delivery does not consume it |
| A second boolean preference reads back as `false` the moment it is set | `writePref` serialised booleans by testing the pref's NAME (`k === "wrap"`), so any other boolean stored as `"true"` and was read by `=== "1"` | Keyed on the VALUE's type, matching what the nullable branch already did |
| A working setup refuses to start after a herdr upgrade | `checkProtocol` compared the protocol with `!==`, so ANY drift was fatal — herdr 0.8.0 → 0.8.2 moved 19 → 20 and changed nothing paddock reads | Directional: an older herdr refuses, a newer one is accepted and reported. A version integer was never the contract, so the fields paddock reads are verified against live `agent.list` data instead (`src/server/herdr/shape.ts`) |
| A contract check that fires on ordinary data | Verifying OPTIONAL fields — `name` is `?:` and a pane that was never named legitimately lacks it | Check only fields that are REQUIRED in `HerdrAgentRaw`, where absence has one explanation. A check that cries wolf on normal data trains you to ignore it |
| A test passes locally and fails in CI with "Attempted to assign to readonly property" | Bun runs every test file in ONE process, and `tests/support/dom.ts` makes globals readonly — so whether `globalThis.window = …` works depends on which file ran first. Adding test files changes that order | Fake a global with `Object.defineProperty`, restore its real descriptor, and put the setup INSIDE the `try` so a partial fake still unwinds |
| One test fails and takes an unrelated test in another file with it | Globals faked before the `try`, so a throw skipped the restore and the next DOM file rendered against a two-property `window` | Setup inside the `try`; the restore is what must be unconditional |
| `make test` fails about one run in twenty, looking like a timer flake | A test picked its port by arithmetic on `performance.now()` within a range that contains a real listener — paddock's own default port, on the machine of anyone running paddock | `tests/support/port.ts` asks the OS for a free port; a range that "looks unused" is a guess about someone else's machine |
| `brew info paddock` reports a version that is not the bytes on disk | The Homebrew prefix is USER-owned, so `paddock update`'s `rename(2)` over a keg SUCCEEDS. The existing "installed by a package manager" hint only fires when rename FAILS, so nothing was said — and the next `brew upgrade` reverted the operator's update without either side mentioning it | `update` resolves `realpath(selfPath)` and refuses when a `/Cellar/` segment is present, naming `brew upgrade paddock`. Refused BEFORE the download, and matched as a path SEGMENT so `~/Cellars/…` is not a false positive. `--check` still reports, because it writes nothing — and names the brew command, not `paddock update` |
| A pairing code typed correctly is reported as wrong, and five tries rotate it | `normalise()` DROPPED `I`, `L`, `O` and `U` rather than decoding them, so an `O` typed for `0` produced a seven-character input; `sameCode` found a length mismatch and reported `wrong code`, spending one of five attempts — on exactly the confusion the Crockford alphabet was chosen to prevent | `normalise()` decodes `I`/`L` → `1` and `O` → `0` per Crockford. `U` stays dropped: it is excluded to avoid an accidental obscenity, not for visual confusion, and means no digit. The mapping is server-side and authoritative; the pairing page mirrors it only for what it displays as you type |
| A notification never arrives, and the service worker looks fine | An expired Cloudflare Access session turns a service-worker `fetch` into an HTML login page rather than an error, so a worker that fetches gets HTML where it expected JSON and fails in a way that looks like a bug in the worker | paddock's worker registers NO `fetch` handler at all, so the hazard cannot reach it. A `push` event renders from the payload it was handed and never calls back — which narrows this to the TAP, where landing on an Access login is correct behaviour. `tests/sw.test.ts` asserts the absence, because adding caching later would silently reintroduce it |
| Suppressing push on the pane you walked away from stays silent about it | herdr's `focused` is not "a human is watching" — it means "the selected pane in its tab," and it survives a closed lid, a locked screen, and a terminal buried four windows deep. Suppressing on it silences exactly the agent you most need to hear about | Presence is a signal paddock owns: a `viewing` frame the client sends while its pane is actually foregrounded (`document.visibilityState`), not a herdr field describing which pane last had focus. See `state/presence.ts` and decision 24 |

## herdr protocol specifics

- **Use `agent.list`, never `pane.list`.** Only `agent.list` returns the
  `name` field — the operator-assigned agent name. `PaneInfo` has no `name`
  field (it has `label`).

- **Never label an agent from `basename(cwd)` WITHOUT disambiguating.** Agents
  commonly share a working directory, so every row would render identically.
  This is the defect the project exists to prevent — and it is the identical
  rendering that is forbidden, not the use of `cwd`.

  `toAgents` in `adapter.ts` is the only place allowed to reach for `cwd`, and
  it earns that by promising uniqueness: `project`, then `project p1`, then
  `project w1:p1`, climbing a rung whenever the one below is ambiguous. Take
  the suffixing away and the flat ban comes back with it. See decision 15.

- **herdr closes a socket connection after ONE response.** A second request
  on the same connection gets `EPIPE`. Only `events.subscribe` keeps its
  connection open, as an event stream, and no further request may be sent on
  that connection.

- **`agent.read` returns the text at `result.read.text`, not `result.text`.**
  The envelope is `{ "type": "pane_read", "read": { pane_id, workspace_id,
  tab_id, source, format, revision, truncated, text } }`. Reading
  `result.text` yields `undefined`, and `?? ""` then turns it into an empty
  pane and a `parsePrompt("")` that returns `options: null` — so the output
  pane was blank for every agent and tap-to-answer silently fell back to the
  free-text box, with no error anywhere. `HerdrPaneRead` in
  `shared/herdr-api.d.ts` now models the envelope and both `request<>` calls
  in `server/herdr/actions.ts` are typed with it, so the same mistake is a
  compile error; `tests/herdr-schema-drift.test.ts` pins it to the installed
  herdr's `PaneReadResult`.

- **A test fake that is more permissive than herdr certifies the bug.** The
  above shipped because `tests/actions.test.ts` answered `agent.read` with
  `{ text }` — a shape herdr has never sent. Every test passed against the
  invented shape while production read nothing. Fakes must be built from
  `herdr api schema --json` or from a live probe, and something must also run
  against the real socket (`tests/actions-live.test.ts`, which skips with a
  reason when there is no herdr).

- **`agent.read` from scrollback needs the agent to be IDLE — the gate is not
  `blocked`.** A coding agent renders on the terminal's alternate screen,
  which keeps no scrollback buffer, so herdr recovers anything past the
  viewport by physically scrolling the pane. Measured on herdr 0.8.0 against
  a *working* agent whose pane is 64 rows: `recent_unwrapped` at `lines=63`
  succeeds, at `lines=64` it fails with `agent_not_idle` ("its alternate-screen
  history can only be captured by scrolling while idle"). So the real boundary
  is `requested lines > viewport rows`, which paddock cannot evaluate — no
  payload it reads carries the pane's row count, and `DEFAULT_READ_LINES` is
  120, roughly double a typical viewport. `readSourceFor` therefore gives
  `recent_unwrapped` to `idle` alone and `visible` to `working`, `blocked` and
  `done`: `visible` never scrolls, never fails, and answers in ~2 ms.
  (`done` is the conservative choice, not a measured one — herdr derives it
  from idle-plus-unseen, but `pane.report_agent` cannot report `done`, so it
  could not be staged on a live socket.) `detection` is not gated at all and
  works in every state.

- **A first paint must not wait on a scrollback read.** `readSourceFor` answers
  "the richest source this state permits", which is NOT the same question as
  "what should the first read ask for". Using it for both meant opening an
  `idle` agent with real scrollback paid a full pane-scroll (~35 ms per line
  past the viewport) before anything was drawn at all. `resolveSource` now
  splits the two: every read defaults to `visible` (flat ~2 ms, never fails),
  and `POST /output` takes an opt-IN `{ scrollback: true }` that the UI sends
  as a SECOND request once something is already on screen. Opt-in, not opt-out
  — a default that is occasionally slow is a default that is slow on exactly
  the agents with the most history.

- **Never render a blank pane while a read is in flight.** `PaneTerminal`
  seeds its state from a module-level `screenCache` keyed by pane id, so
  re-opening a pane paints the last screen immediately and the fetch only
  replaces it. Measured with CDP at 390×844: a cold deep link went from 13 ms
  with one blank frame to **0 ms with none**. Over a local socket that gap is
  a single frame; over a phone on a ~250 ms link it is the entire impression
  of slowness, and a blank pane is also indistinguishable from "this agent
  produced no output". The comparison system does the same thing — its
  `openTerminal` switches view synchronously from already-cached state and
  leaves the previous content in place until new content arrives.

- **herdr cannot tell you that a pane's output changed, so paddock must poll.**
  Probed directly rather than inferred. There are 27 subscribable event types
  and none of them is an output-changed notification: `pane_output_changed`
  exists only in the `EventKind` *response* enum, not in `Subscription`. The
  closest candidate, `pane.output_matched`, is **edge-triggered and one-shot**
  — subscribing with a match-anything regex (`.`) produced ZERO events across
  five output bursts, and a substring that appeared three times produced
  exactly one event, on the transition to matching. It answers "did this text
  start appearing", not "did the screen change".

  This is why the refresh loop exists and why moving output onto the WebSocket
  would not remove it: something has to poll herdr either way, and the only
  question is whether the browser or the server does it. See the byte
  measurements below.

- **`idle` means READY FOR INPUT, not silent.** A pane changes whenever anyone
  types at the desk, so an idle agent's screen is not safe to stop reading.
  This was got wrong once, with a real cost: the terminal view suppressed its
  refresh entirely while showing an idle agent's scrollback, on the reasoning
  that such an agent "by definition is not producing output". The pane then
  froze, and a frozen pane is indistinguishable from a quiet one.

- **Moving the API onto the WebSocket saves ~1%; the payload is where the
  bytes are.** Measured rather than argued, because the intuition points the
  wrong way. One `/output` response: 10,805 B of body against 111 B of HTTP
  headers, so the entire saving available from dropping HTTP framing is about
  1% — bought at the price of request/response correlation IDs, reconnect-safe
  error handling, and status codes, which is why spec §4 rejected it. What did
  work, on the same payload: `gzip` takes it to 2,435 B (terminal output is
  extremely repetitive), and digest revalidation takes a steady-state poll to
  **38 B**, because consecutive 3s polls differ by 3 lines out of 63.

  The comparison system's socket was also measured directly rather than
  assumed: over 20s it pushed only `agents` (the FULL list, every 2s) and one
  `agent_update`, and **no terminal content at all** — pane content is
  request/response there too. Its status channel costs 2.3 MB/hour; paddock's
  delta-based one costs 0.34 MB/hour for the same information. The WebSocket
  paddock already has is the more efficient of the two.

- **A WebSocket read is not a free read.** It is worth stating plainly because
  the opposite looks true from a browser's Network tab: a comparable dashboard
  appears to open a terminal with no request at all, and in fact sends
  `{type:'read_pane'}` over its socket and shells out to `herdr pane read`.
  Moving paddock's `POST /output` onto its WebSocket would relabel the same
  round trip, not remove it. Measured end to end, paddock's read is ~0 ms
  locally; the latency worth attacking was the blank frame and the scrollback
  default above, neither of which is a transport problem.

- **Scrollback reads cost real wall time, and stop paying past ~300 lines.**
  Same probe, idle agent: `recent_unwrapped` is instant up to the viewport,
  then costs roughly 35 ms per extra line — 120 lines took 3.1 s, 300 lines
  10.7 s (past `HERDR_TIMEOUT_MS`, so `POST /output` with `lines: 300` fails),
  and 500/1000/2000 lines each took ~15.8 s and came back with *less* than
  `visible` returns in 2 ms. `visible` is flat at ~2 ms for any line count.
  `MAX_READ_LINES` (2000) is therefore not a usable request against an idle
  agent; see `docs/roadmap.md`.

- **The option cursor WRAPS, so nav keys can silently select a persistent
  grant.** Measured against a live Claude Code permission prompt: `↓` moves
  `1 → 2 → 3` and then wraps back to `1`. The middle option is routinely
  "Yes, and don't ask again for: <command> *" — a standing policy change, not
  a one-off approval. On a phone, one extra tap of `↓` moves the selection
  somewhere the operator did not intend, and the ONLY indication of where the
  cursor now sits is the `❯` inside the terminal text. Observed for real: a
  run that pressed `↓` twice from option 2 wrapped to option 1 and committed
  "Yes" — the right answer by luck, not by design. This is the strongest
  argument for rendering the parsed option buttons ALONGSIDE the keypad: a
  button carries its own label, so committing it cannot be off by one. The
  keypad remains the fallback for prompts the parser cannot read.

- **Declining an option settles the agent on `done`, not `idle` or `working`.**
  Confirmed end to end against a live prompt: selecting "No" moved the agent
  `blocked → done`. This is why `waitUntilUnblocked` waits on
  `["working", "idle", "done"]` — the original `--until working` would have
  reported a false failure on this exact path, and so would a wait that had
  been "corrected" to `["working", "idle"]`.

- **A blocked agent's prompt options are numbered and parseable.** The
  `detection` snapshot carries `1.` / `2.` / `3.` with `❯` on the current
  selection, and `agent.send_keys` with the option digit selects it. But
  **option labels are dynamic** — one real option was "Yes, and always allow
  access to tmp/ from this project", a persistent policy change rather than an
  approval. Never collapse options into a generic Approve; render the agent's
  exact label.

- **`pane.agent_status_changed` subscriptions require a `pane_id`** — there
  is no global form. So the pane set must be reconciled *before* subscribing;
  subscribing first names no panes and silently delivers nothing.

- **Waiting on `--until working` after answering a blocked agent reports a
  false failure whenever the option declines.** Declining settles the agent
  on `idle`, not `working` — confirmed during the probe, where answering
  "Yes" also settled on `idle` once the command finished. Wait on *leaving*
  `blocked` instead: `agent.wait({ until: ["working", "idle", "done"] })`
  (`waitUntilUnblocked` in `server/herdr/actions.ts`).

- **A herdr-side `timeout_ms` must be paired with a larger client-side
  transport ceiling.** `request()` in `server/herdr/socket.ts` defaults its
  own guard to `HERDR_TIMEOUT_MS` (10s) unless a fourth argument overrides it.
  Telling herdr it may take up to 15s to answer `agent.wait`, without raising
  that transport ceiling past 15s, makes the client terminate the socket at
  10s and report a false failure on an action that was still succeeding
  inside herdr. `waitUntilUnblocked` passes `timeoutMs + WAIT_TRANSPORT_MARGIN_MS`
  explicitly for this reason.

- **A prompt parser must scope option matching to the last contiguous run,
  and must not carry a question across runs.** Scanning the whole buffer in
  `server/herdr/prompt-parse.ts` would let a stray numbered line elsewhere in
  scrollback splice onto the real menu just because the numbering happens to
  continue; not resetting the pinned question when a run closes would let a
  resolved prompt's caption attach itself to the live menu's buttons. Both
  produce a plausible wrong answer, not a visible error.

- **Delivered event names differ from subscribe names.** The three
  `SubscriptionEventKind` types stay dotted (`pane.agent_status_changed`);
  everything else is delivered underscored (`pane.closed` arrives as
  `pane_closed`). Matching on the subscribe name for the underscored ones
  silently never fires.

- **A coding agent's pane has no scrollback to read, at any price.** It runs
  on the terminal's alternate screen, which keeps nothing behind the
  viewport: every such pane reports `scroll.max_offset_from_bottom: 0`.
  Measured against herdr 0.8.0, asking anyway costs ~35 ms per line past the
  viewport — 300 lines 10.7 s (past `HERDR_TIMEOUT_MS`), and 500/1000/2000
  lines each ~15.8 s while returning LESS than `visible` returns in 2 ms. The
  bytes were never retained; there is no cheaper way to ask herdr for them,
  and no larger timeout recovers content that was not kept. This is why
  history comes from the harness's own log instead — see
  `src/server/journal/`.

- **The `detection` read source strips every escape, unconditionally.**
  Measured: a detection read of a live question dialog contains ZERO escape
  sequences even when colour is asked for, while the same screen from `visible`
  has 37 escape-bearing lines. Anything that needs colour — a question dialog's
  current tab is marked ONLY by an ANSI background — must read `visible`. No
  `strip_ansi` flag can recover it, so the SOURCE is the thing to change.

- **`agent.send_keys` takes ONE character per key.** `send_keys ["chào"]` is
  refused with `invalid_key: unsupported key chào`. Text therefore travels as an
  array of single characters, split by CODE POINT (`Array.from`) — a byte or
  UTF-16 split corrupts anything non-Latin. Single non-ASCII characters ARE
  accepted (`à`, `ế`, `日` each measured), so a character route must not be
  ASCII-only.

- **In a question dialog the same key means different things on different rows.**
  A digit TOGGLES a checkbox in multi-select and PICKS AND ADVANCES in
  single-select — but on the FREE-TEXT row a digit is neither: it is typed as
  text. Measured on a phone, tapping an option with the cursor left on that row
  turned `4. [✔] 2` into `4. [✔] 21` and never moved the option. `space` inserts
  there and toggles everywhere else. Typing there ticks the checkbox as a side
  effect. And `enter` on an EMPTY free-text row declines the entire dialog.
  Never send a key to one of these screens without knowing which row the cursor
  is on; `src/server/herdr/ask-dialog.ts` exists to answer that.

- **Nothing reports a TUI text row's CARET, and it is not where you assume.**
  Measured: it sits wherever the last insertion ended, and at position 0 when
  the cursor has just arrived on the row — not at the end of the text. So
  `backspace`, which deletes BEHIND the caret, erased nothing and the new text
  went in FRONT of the old: typing `Trái nho khô` over `Trái cây` produced
  `Trái nho khôTrái cây`. Drive the caret to a known position first — `right`
  as many times as the row is long reaches the end from anywhere, and `right`
  past the end is inert (twenty of them changed neither the text nor the current
  tab).

- **Probe a TUI one key at a time, never in a batch.** `send-keys a b c d` sends
  four keys with no pause, and a TUI repaints asynchronously — so keys that
  depend on where an earlier key left the cursor are measured against the wrong
  frame. This produced a WRONG measured "fact" that reached a design doc, a
  decision and shipped code: "a single-select free-text row ignores characters".
  It does not; the characters had simply overtaken the cursor. Send one key,
  read, then send the next.

- **Nothing in a question dialog unblocks the agent until "Submit answers".**
  So `/answer`, which calls `waitUntilUnblocked` after sending, is the wrong
  route for a dialog digit: every tap would wait out the full 15s budget and
  then report failure for a toggle that had already worked. `/dialog-key` sends,
  settles and re-reads instead.

## Build and tooling

- **Bun's runtime module resolver does not try `.d.ts` on extensionless
  imports.** `@shared/herdr-api` needs an explicit literal `paths` entry in
  `tsconfig.json` ahead of the wildcard entry, or the import fails to
  resolve. (Found in Task 3.)

- **`bun <entry>.ts` at runtime also needs `tsconfig.json` present** to
  resolve the `@server/*` / `@shared/*` path aliases at all — not just for
  type-checking. A container image that copies `src/`, `dist/`, and
  `package.json` but not `tsconfig.json` fails at startup with
  `Cannot find module '@server/routes'`. Confirmed by running the compiled
  final Docker stage's contents outside Docker with `tsconfig.json` removed.

- **A test that sets `process.env.TZ` changes the clock for the whole suite,
  permanently.** Measured: Bun applies the FIRST assignment and caches the
  zone, after which neither `delete process.env.TZ` nor setting it back to
  `UTC` has any effect — and Bun runs every test file in ONE process. So
  `tests/journal-text.test.ts`, which pins Asia/Tokyo to prove journal stamps
  are local rather than UTC, leaves +09:00 in force for every file that runs
  after it, `finally` block or not. Found when a new test in that same file
  rendered `13:05Z` as `22:05`. No test may assert a local time it did not pin
  itself; assert the SHAPE of a stamp (`/^agent · \d\d:\d\d$/`), or use an
  entry with no timestamp. Assigning `undefined` to an env var is separately
  wrong — it stores the string `"undefined"`.

## Client

- **`localStorage` throws rather than returning `null`** in Safari private
  mode and under enterprise storage policies. Guard any access made during
  render.

- **An HTTP error body that is valid JSON parses cleanly as a success
  shape.** The action routes in `server/routes.ts` return
  `{ ok: false, detail }` on a 404 or 502 — valid JSON, but not the shape a
  read caller declared. `web/api.ts`'s read paths (`fetchOutput`/
  `fetchPrompt`) check `res.ok` before parsing and reject on non-2xx instead,
  specifically so a caller cannot receive a value whose declared type is a
  lie. Check status before parsing on any read path that shares a body shape
  with its error case.

- **A per-entity React component needs `key={entityId}` when it holds
  in-flight async state.** `AgentDetail` keeps the action result, the typed
  reply and `busy` per selected agent; without `key={openAgent.agentId}` in
  `App.tsx`, switching the selection would reuse the same component instance,
  and a late response (e.g. a 409 that resolves after the operator already
  switched agents) would land attributed to the wrong one.

- **A key fixes identity, not time — and must not be widened to cover it.**
  The same agent hits prompt A, is answered, works, then hits prompt B: with
  identity alone, A's "Sent." and A's typed reply are still on screen under
  B's question. The tempting fix — adding `agent.state` to the key — is wrong
  here, because a successful answer's defining outcome IS a state change, so
  it would unmount the sheet on the very delta the answer caused. `AgentDetail`
  tags the reply and the result with a `promptSeq` instead and renders them
  only while that prompt is still the one on screen, which also covers an
  answer that resolves after the next prompt has already loaded — something no
  reset can, since a reset cannot un-write a later `setState`.

- **Feedback nested inside a conditional section dies with the section.** The
  "Sent." confirmation used to live inside `AgentDetail`'s
  `agent.state === "blocked"` block. Since a successful answer moves the agent
  out of `blocked`, the confirmation unmounted the moment the delta arrived —
  at best a ~100 ms flash, and nothing at all when the delta beat the HTTP
  response. Render an action's outcome outside anything the action itself
  changes.

- **Validate a client-supplied number before it reaches a herdr parameter.**
  `POST /output`'s `{lines}` was cast, never checked: `1e9` asked herdr for a
  billion lines and buffered them here, and `"60"` put a string into a numeric
  param. `resolveReadLines` / `resolveWaitTimeoutMs` in
  `server/herdr/actions.ts` clamp out-of-range values and fall back to the
  default for malformed ones — and `{key}` is constrained to an option digit,
  since spec §6 provides no general-purpose key-send endpoint and a control
  sequence is a larger capability than the free text already allowed.

- **Never anchor a revealed window to the END of a growing array.**
  "Show earlier" held a COUNT of revealed scrollback lines and rendered
  `settled.slice(settled.length - count)`. `settled` grows every time a line
  scrolls off the live screen, so each newly settled line pushed one line off
  the TOP of what was on screen: the scroll position was preserved perfectly
  and pointed at different text than it had a second earlier. Reported from a
  phone as "it jumps, I lose my place" — worst while an agent works, which is
  the only time anyone reads back through its output. `PaneTerminal` holds the
  START index instead, so newly settled lines arrive between the revealed block
  and the live screen and displace nothing. A count anchored to a moving end is
  not a position.

- **Do not carry terminal style across the history/live boundary.**
  `parseAnsi` carries SGR state across lines deliberately — a TUI opens a
  colour on one row and closes it three rows later. But revealed history is an
  ARBITRARY SLICE, so whatever style its last line left open bled into the live
  screen: measured, an unclosed `SGR 31` rendered an untouched live line
  `#cd3131` that unrevealed rendered unstyled. The live screen changed colour
  according to how much history had been revealed. Parse the two blocks
  separately; the live screen must render the same whether or not anything is
  revealed.

## Deployment and Access

- **Access gates `/sw.js` as well, and that is survivable — an application
  token would not be.** Measured against a live deployment: requested without
  a session, `/`, `/api/health`, `/api/agents`, `/ws` and `/sw.js` every one
  returned `302` to the Access login. The service worker still registers,
  because registration is a same-origin fetch that carries the
  `CF_Authorization` cookie the browser already holds. This is the whole
  reason the rule in `CLAUDE.md` is "no application token" rather than "do not
  gate `/sw.js`": a bearer token has nothing to ride on a browser-initiated
  worker fetch, so it fails where a cookie succeeds. On paper the two look
  like the same gate. In a browser they behave oppositely.

- **An expired Access session turns a service-worker fetch into an HTML login
  page, not an error.** The redirect is a `302` to the identity provider, so
  a worker that wakes and fetches JSON gets markup with a `200` at the end of
  the redirect chain — a parse failure at best, and silence at worst. This
  constrains Web Push before it is written: the notification payload must
  carry the agent name and state itself, rather than waking the worker to go
  and ask. The failure would otherwise appear exactly when the operator has
  been away long enough for the session to lapse, which is precisely when the
  notification was worth sending. A longer Access session duration lowers the
  frequency and removes nothing.

- **A proxy that rewrites `Host` breaks every write, and the browser reports
  nothing useful.** Since decision 17, a state-changing request must carry an
  `Origin` matching the request's `Host`. `cloudflared`'s ordinary HTTP ingress
  forwards the browser's `Host` unchanged, which is what `docs/deploy-cloudflare.md`
  describes and what makes the check hold — but a proxy configured to override
  it (cloudflared's own `httpHostHeader`, or an nginx `proxy_set_header Host`
  pointing at `localhost`) makes `Host` disagree with `Origin` on every request,
  and paddock refuses all of them with a `403`. From the phone this reads as
  replies silently failing while the dashboard still updates, because reads are
  deliberately ungated. **The tell is on the host's stderr:** paddock logs
  `refused a cross-origin write` once per distinct `origin -> host` pair, naming
  both, precisely so this is diagnosable in seconds rather than guessed at. The
  fix is to forward `Host` unchanged; adding the rewritten value to
  `settings.publicUrl` would NOT help, because the mismatch is between the two
  headers and not with any allowlist.

- **A `publicUrl` naming a hostname you do not actually reach paddock on
  refuses every write.** The other half of the entry above, and the opposite
  fix. Once `settings.publicUrl` is set, its host becomes an allowlist (that is
  what buys DNS-rebinding cover), so a stale value, a typo, or a SECOND
  legitimate hostname for the same paddock is refused with a `403` even though
  `Origin` and `Host` agree. Loopback is always exempt, so it fails from the
  phone while the desk keeps working — which reads as "the tunnel broke". The
  stderr line distinguishes it from a rewriting proxy: `this host is not the
  public URL saved in settings`. Fix by correcting `publicUrl` to the hostname
  in the browser's address bar, or by clearing it — clearing costs only the
  rebinding cover and the Telegram deep link, never the reply path.

- **A verification request must come from a context holding no Access
  session.** An already-authenticated browser renders the dashboard whether or
  not the policy is correct, so it cannot tell a working gate from a missing
  one. See `docs/deploy-cloudflare.md` for the check and the expected result.

## Quick tunnels

- **`Secure` cookies never arrive over `http://127.0.0.1:8788`.** The pairing
  cookie is `Secure`, so browsing the gated port directly can never pair — the
  port looks broken while behaving correctly. The pairing page detects a
  plaintext origin (from `x-forwarded-proto`, falling back to the request
  URL's own protocol when that header is absent) and shows a warning. Use the
  tunnel URL instead.

- **A `Host`-header exemption is not a gate.** `cloudflared` connects over
  loopback like any local client, so a tunnel request is indistinguishable
  from a desk request at the socket, and the only differing header is one the
  remote client sets. `Host: localhost` through the tunnel would take the
  exempt path. This is why the gate lives on a second listener.

- **Two paddocks against one herdr notify twice.** Each has its own
  `Notifier`, so every blocked agent buzzes the phone once per process.
  `paddock tunnel` refuses to start while another paddock is already running
  for this reason, not because of the port — the port conflict, if there is
  one, is a separate and later failure.

## A top-level script's wiring is only testable by running it

`paddock tunnel --publish-running` crashed on every invocation with
`ReferenceError: Cannot access 'onShutdown' before initialization`: its block
sits at the top of `index.ts` and assigned a `let` declared several hundred
lines below it. Nothing caught it — `tsc` does not flag a temporal dead zone
read, and every test called `runTunnel` directly rather than executing
`index.ts`. It was claimed verified on the strength of a manual run that must
have used a binary built before the block moved.

Behind it sat a second defect the crash had been hiding: that path had no signal
handler, so a `^C` would have left `cloudflared` running with a public URL and
nothing behind it.

**A command whose wiring lives at a module's top level needs at least one test
that spawns it as a process.** `tests/publish-running-process.test.ts` is that
test. Its load-bearing assertion is that the cloudflared child is dead after the
parent is signalled — asserted separately from the state file's removal, because
the shutdown handler removes that itself, so a tidy config dir is not evidence
the child was reaped.
