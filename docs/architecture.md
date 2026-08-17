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
| `server/routes.ts` | Hono routes, plus the static-file / SPA fallback handler. |
| `server/index.ts` | Composition root. The only place that wires stream → supervisor → store → hub, and the keeper to the stream's state changes. |
| `shared/types.ts` | The one payload contract, imported by server and UI — including `compareAgents`, the single triage comparator both sides sort with. |
| `shared/herdr-api.d.ts` | **Generated** from `herdr api schema --json`. Committed. Never hand-edited. Its interface bodies are hand-written in the generator, so `tests/herdr-schema-drift.test.ts` is what actually holds them to the live schema. |
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
