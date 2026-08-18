# Architecture

One process. No relay hop, no plugin, no polling loop.

```
              unix socket: $HOME/.config/herdr/herdr.sock
                          │
   ┌──────────────────────┴───────────────────────┐
   │                                              │
 ONE long-lived STREAM connection      ONE SHORT-LIVED connection
 events.subscribe → stays open,        PER REQUEST — herdr closes it
 pushes status/lifecycle events        after a single response
   │                                     ping (protocol check, at startup)
   │                                     agent.list (initial + 30s reconcile)
   │                                     workspace.list (labels)
   │                                              │
 ┌─┴──────────────── paddock (Bun, 127.0.0.1:8787) ┴──────────────┐
 │  herdr/socket.ts   state/store.ts    ws/hub.ts    static UI    │
 │  stream + request   Map<agentId>      snapshot +   Vite bundle │
 │  protocol check     authoritative     deltas +     (no sw.js)  │
 │  bounded waits                        heartbeat                │
 └───────────────────────────┬────────────────────────────────────┘
                             │ HTTPS + WSS
              Cloudflare Tunnel ── Access ── browser / phone
```

## Modules

| Module | Responsibility |
|---|---|
| `server/herdr/socket.ts` | Unix socket client. One-shot `request()`, long-lived `openStream()`, protocol check. Every wait is bounded (10s) — a herdr that accepts a connection and never answers must fail, not hang. Reports stream up/down via a callback, including a reopen that tore down a live socket and failed to replace it. The **only** thing that speaks the herdr wire format. |
| `server/herdr/keeper.ts` | Reconnect-with-backoff on top of that callback. Retries `Supervisor.refresh()` with jittered backoff until the stream is back; a protocol mismatch is fatal rather than retried. Idempotent, so a flapping socket cannot spawn a loop per drop. |
| `server/herdr/adapter.ts` | Normalizes herdr payloads into `shared/types.ts`. The only place field mapping lives. |
| `server/supervisor.ts` | The herdr-facing control loop. Reconciles (`workspace.list` + `agent.list`) into the store, keeps the per-pane subscription set pointed at the live panes, applies status events without a round trip, and serializes overlapping refreshes into one. Exposes `lastEventAt` for `/api/health`. |
| `server/state/store.ts` | Authoritative in-memory `Map<string, Agent>` keyed by `agentId` alone (the herdr `pane_id`). `hostId` is carried on every `Agent` record but is not part of the key — see `docs/roadmap.md` for what multi-host requires. Computes deltas. Knows nothing about transport. |
| `server/demo.ts` | Synthetic agents for `--demo`, with invented names. Ticks go through the store like everything else, so the store is authoritative in both modes. Knows nothing about herdr, and takes the store structurally so it imports nothing downstream. |
| `server/ws/hub.ts` | Browser fan-out. Full snapshot on connect, coalesced deltas after, and a 20s heartbeat so a quiet-but-live link does not read as stale. Knows nothing about herdr. |
| `server/herdr/actions.ts` | The herdr calls behind reading a pane and answering a blocked agent, and the home of the bounds on both numeric parameters (`resolveReadLines`, `resolveWaitTimeoutMs` — clamped out of range, defaulted when malformed): `readOutput`/`readDetection` (both typed with the generated `HerdrPaneRead` envelope, since the text is at `result.read.text`; source picked by `readSourceFor`, which gives scrollback to an `idle` agent and the viewport to every other state — see gotchas), `sendOptionKey`/`sendReply`, and `waitUntilUnblocked` (waits on *leaving* `blocked`, not on reaching `working`). Bound to one socket path via `createActions` so `routes.ts` takes it as an injectable `HerdrActions`, omitted entirely in `--demo`. |
| `server/herdr/prompt-parse.ts` | Turns a `detection` snapshot into `ParsedPrompt` — the last contiguous run of numbered option lines, plus the question line pinned to that run. Returns `options: null` rather than guess when the shape does not hold. The only place that knows the numbered-menu text format. |
| `server/routes.ts` | Hono routes, plus the static-file / SPA fallback handler. Read-only routes (`/api/health`, `/api/agents`) and `/ack` are always registered — `/ack` touches only the store and the hub, so gating it on herdr would break it in `--demo`. The three herdr-backed action routes (`/output`, `/prompt`, `/answer`) are added only `if (deps.actions)`, so they do not exist there. Client-supplied values are validated at this boundary before they reach a herdr parameter: `:id` against the store, `lines` through `resolveReadLines`, and `key` against the option-digit pattern. |
| `server/index.ts` | Composition root. The only place that wires stream → supervisor → store → hub, and the keeper to the stream's state changes. |
| `shared/types.ts` | The one payload contract, imported by server and UI — including `compareAgents`, the single triage comparator both sides sort with, and `carryAcknowledged`, the single rule for carrying `acknowledgedAt` across a state change. |
| `shared/herdr-api.d.ts` | **Generated** from `herdr api schema --json`. Committed. Never hand-edited. Its interface bodies are hand-written in the generator, so `tests/herdr-schema-drift.test.ts` is what actually holds them to the live schema. |
| `web/api.ts` | The client's only fetch layer. POSTs to the action routes; reads (`fetchOutput`/`fetchPrompt`) reject on a non-2xx response instead of resolving with a body whose declared shape doesn't hold, actions (`answerWithKey`/`answerWithText`/`acknowledge`) fold both transport errors and non-2xx bodies into one `ActionResult` so a refusal renders instead of throwing. |
| `web/components/AgentDetail.tsx` | The detail sheet: one agent's output, and — while `blocked` — its parsed prompt options plus a free-text reply box, fetched on open, on a state change, and on the explicit Refresh control. Split into a stateful `AgentDetail` and a hook-free `AgentDetailView`, so the markup is testable with `renderToStaticMarkup` and no DOM. Mounted with `key={openAgent.agentId}` in `App.tsx` so switching the selected agent unmounts the old instance rather than reusing its in-flight state. Attribution across *time* — one agent's successive prompts — is handled instead by tagging the typed reply and the action result with the prompt they belong to: keying on `state` would unmount the sheet on the very delta a successful answer causes. The result line sits outside the `blocked`-only section for that same reason. |
| `web/` | React + Tailwind, single screen. |

## The dependency rule

Dependency direction is strict:

```
herdr/socket → herdr/adapter → state/store → ws/hub → web/
```

Nothing upstream imports anything downstream. `store.ts` must not know about
transport; `hub.ts` must not know about herdr. `src/server/herdr/` is the only
code that knows herdr exists — all field mapping lives in `adapter.ts`, so a
protocol change touches `socket.ts`, `adapter.ts`, and the generated types,
nothing else.

`supervisor.ts` sits between `herdr/` and `state/store.ts`: it imports both,
and nothing downstream of the store. `demo.ts` stands where herdr would, so it
takes the store structurally rather than importing it. `index.ts` is the one
exception by design — a composition root imports everything precisely so no
other module has to.

## Actions transport

Reading a pane and answering a blocked agent do not ride the WebSocket at all.
Each is a plain POST route (`/api/agents/:id/output`, `/prompt`, `/answer`,
`/ack`) that calls into `HerdrActions` and returns its result — success or
`ActionResult`-shaped failure — directly in the HTTP response to the caller
that made the request. No correlation id, no round trip through the hub.

The one exception is `/ack`: it sends nothing to herdr at all. It changes
agent state (`acknowledgedAt`) in paddock's own store, so
after updating the store it also queues the resulting delta on the hub —
the same path every other state change already takes — so every other open
browser learns about the dismissal too, not just the tab that tapped it.
`/answer` does not queue anything itself: the option key or reply goes to
herdr, and the resulting state change (leaving `blocked`) arrives back to
every browser, including the one that sent it, through the normal event →
store → delta path once herdr reports it.

## Liveness

Two independent things can be "up", and the operator can tell them apart.

- **herdr → paddock.** The event stream reports up/down; a down arms
  `herdr/keeper.ts`, which retries with jittered backoff. `/api/health`
  reports the stream's own `connected`, never a cached flag, plus
  `lastEventAt` so a stream that is open but delivering nothing is visible.
- **paddock → browser.** The client treats any received message as proof of
  life and calls the data stale after 60s of silence. A quiet system sends
  nothing at all — no agent changed, so no delta — so the hub sends a
  `heartbeat` every 20s. Without it, an overnight session of idle agents
  (the primary use case) would show the staleness banner on a healthy link.
