# Gotchas

Failure modes observed in a comparable system, or found while building this
one, recorded here so they are not reintroduced.

| Failure | Cause | Design response |
|---|---|---|
| Every row shows the same label | Label derived from `basename(cwd)`; agents commonly share a working directory | `name` from `agent.list` is the primary label — this is the defect the project exists to prevent |
| A field is always empty | Read from the wrong object (pane vs workspace vs agent) | Generated types make a rename a build error — for the three v1 payloads and the `agent.read` envelope only; see the coverage limit in `docs/roadmap.md` |
| Events dropped with no error | Push script ends `curl -s … >/dev/null 2>&1; exit 0` | Log receipt at INFO; `/api/health` exposes `lastEventAt` |
| Sensitive paths in access logs | Payload sent as a GET query string | POST bodies only |
| Service worker silently disabled | Auth check gates every route including `/sw.js` | No app token; Access is the gate — its cookie rides a same-origin fetch, a bearer token has nothing to ride |
| Works on one hostname, not another | Hostname allowlist in the client | Derive the WebSocket URL from `location`, unconditionally |
| Route order load-bearing | Hand-rolled request dispatch | Hono's explicit routing |
| A repeated alert never fires again | Dedup key too coarse; a failed send consumes the attempt | Dedup on the state transition; a failed delivery does not consume it |
| A second boolean preference reads back as `false` the moment it is set | `writePref` serialised booleans by testing the pref's NAME (`k === "wrap"`), so any other boolean stored as `"true"` and was read by `=== "1"` | Keyed on the VALUE's type, matching what the nullable branch already did |
| A test passes locally and fails in CI with "Attempted to assign to readonly property" | Bun runs every test file in ONE process, and `tests/support/dom.ts` makes globals readonly — so whether `globalThis.window = …` works depends on which file ran first. Adding test files changes that order | Fake a global with `Object.defineProperty`, restore its real descriptor, and put the setup INSIDE the `try` so a partial fake still unwinds |
| One test fails and takes an unrelated test in another file with it | Globals faked before the `try`, so a throw skipped the restore and the next DOM file rendered against a two-property `window` | Setup inside the `try`; the restore is what must be unconditional |
| `make test` fails about one run in twenty, looking like a timer flake | A test picked its port by arithmetic on `performance.now()` within a range that contains a real listener — paddock's own default port, on the machine of anyone running paddock | `tests/support/port.ts` asks the OS for a free port; a range that "looks unused" is a guess about someone else's machine |

## herdr protocol specifics

- **Use `agent.list`, never `pane.list`.** Only `agent.list` returns the
  `name` field — the operator-assigned agent name. `PaneInfo` has no `name`
  field (it has `label`).

- **Never label an agent from `basename(cwd)`.** Agents commonly share a
  working directory, so every row would render identically. This is the
  defect the project exists to prevent.

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

- **Never render a blank pane while a read is in flight.** `AgentTerminal`
  seeds its state from a module-level `screenCache` keyed by agent id, so
  re-opening an agent paints the last screen immediately and the fetch only
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
