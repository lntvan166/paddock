# Gotchas

Failure modes observed in a comparable system, or found while building this
one, recorded here so they are not reintroduced.

| Failure | Cause | Design response |
|---|---|---|
| Every row shows the same label | Label derived from `basename(cwd)`; agents commonly share a working directory | `name` from `agent.list` is the primary label — this is the defect the project exists to prevent |
| A field is always empty | Read from the wrong object (pane vs workspace vs agent) | Generated types make a rename a build error — for the three v1 payloads only; see the coverage limit in `docs/roadmap.md` |
| Events dropped with no error | Push script ends `curl -s … >/dev/null 2>&1; exit 0` | Log receipt at INFO; `/api/health` exposes `lastEventAt` |
| Sensitive paths in access logs | Payload sent as a GET query string | POST bodies only |
| Service worker silently disabled | Auth check gates every route including `/sw.js` | No app token; Access is the gate |
| Works on one hostname, not another | Hostname allowlist in the client | Derive the WebSocket URL from `location`, unconditionally |
| Route order load-bearing | Hand-rolled request dispatch | Hono's explicit routing |
| A repeated alert never fires again | Dedup key too coarse; a failed send consumes the attempt | Dedup on the state transition; a failed delivery does not consume it |

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

- **`agent.read` with `recent` or `recent_unwrapped` FAILS on a blocked
  agent.** herdr returns `agent_not_idle`: the agent's prompt renders on the
  terminal's alternate screen, whose history "can only be captured by
  scrolling while idle". Use `detection` (what herdr itself classified from)
  or `visible`. This bites precisely on the agents you most want to read, so
  choose the read source by agent state, not by preference.

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
