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
   │                                     agent.list (initial + 30s reconcile)
   │                                     workspace.list, agent.read/prompt/…
   │                                              │
 ┌─┴──────────────── paddock (Bun, 127.0.0.1:8787) ┴──────────────┐
 │  herdr/socket.ts   state/store.ts    ws/hub.ts    static UI    │
 │  stream + request   Map<agentId>      snapshot +   Vite bundle │
 │  protocol check     authoritative     deltas       (no sw.js)  │
 └───────────────────────────┬────────────────────────────────────┘
                             │ HTTPS + WSS
              Cloudflare Tunnel ── Access ── browser / phone
```

## Modules

| Module | Responsibility |
|---|---|
| `server/herdr/socket.ts` | Unix socket client. One-shot `request()`, long-lived `openStream()`, protocol check. Reports stream up/down via a callback; reconnect-with-backoff on top of that callback is not yet wired. The **only** thing that speaks the herdr wire format. |
| `server/herdr/adapter.ts` | Normalizes herdr payloads into `shared/types.ts`. The only place field mapping lives. |
| `server/state/store.ts` | Authoritative in-memory `Map<string, Agent>` keyed by `agentId` alone (the herdr `pane_id`). `hostId` is carried on every `Agent` record but is not part of the key — see `docs/roadmap.md` for what multi-host requires. Computes deltas. Knows nothing about transport. |
| `server/ws/hub.ts` | Browser fan-out. Full snapshot on connect, deltas after. Knows nothing about herdr. |
| `server/routes.ts` | Hono routes, plus the static-file / SPA fallback handler. |
| `shared/types.ts` | The one payload contract, imported by server and UI. |
| `shared/herdr-api.d.ts` | **Generated** from `herdr api schema --json`. Committed. Never hand-edited. |
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
