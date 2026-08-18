# paddock — design

**Status:** approved design, not yet implemented
**Date:** 2026-08-17

A mobile-first web dashboard for watching and answering
[herdr](https://github.com/herdrdev/herdr) coding agents from a phone.

---

## 1. Goal and non-goals

You run several coding agents in herdr panes on one machine. When you are away from
the desk you want to know, at a glance: **which agent needs me?** And when one is
blocked on a permission prompt, you want to answer it without opening a terminal.

paddock is a single local process that reads herdr over its unix socket and serves
one screen. Remote access is delegated entirely to Cloudflare Tunnel + Access —
paddock itself binds to loopback and has no authentication of its own.

### In scope

- Live status for every agent: name, current task, state, elapsed time
- Triage ordering — what needs you first, not alphabetical
- Read a pane's recent output on demand
- Answer a blocked agent: tap a real prompt option, or send a short reply
- Light and dark, installable as a PWA

### Non-goals

- **Not a terminal.** No arbitrary command entry, no shell. SSH already does that
  better, and a web terminal on a phone keyboard is miserable.
- **Not multi-user.** One operator. Access handles who that is.
- **Not multi-host in v1.** See §13.
- **Not a hosted service.** Local build, local run, private tunnel.

### Prior art and attribution

The idea comes from [herdr-remote](https://github.com/dcolinmorgan/herdr-remote)
by dcolinmorgan — pushing herdr agent status to a phone for monitoring and
one-tap approval. paddock borrows that concept and none of its implementation:
different transport, different stack, different UI. The README credits it.

---

## 2. Architecture

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
 │  stream + request   Map<host:agent>   snapshot +   Vite bundle │
 │  protocol check     authoritative     deltas       + sw.js     │
 └───────────────────────────┬────────────────────────────────────┘
                             │ HTTPS + WSS
              Cloudflare Tunnel ── Access ── browser / phone
```

**The connection model is not negotiable — it is what herdr does.** Verified
against herdr 0.8.0: the server writes one response and closes the connection.
Two requests on one connection yield one response and a broken pipe; pipelining
two requests in a single write yields the same. `events.subscribe` is the sole
exception — it converts that connection into a long-lived event stream, and no
further request may be sent on it. So paddock keeps one stream connection open
and opens a fresh connection for every request. There is no request
multiplexing and no `id`→promise map, because a connection never carries more
than one response.

### Modules

| Module | Responsibility |
|---|---|
| `server/herdr/socket.ts` | Unix socket client. One-shot `request()`, long-lived `openStream()`, protocol check, reconnect. The **only** thing that speaks the herdr wire format. |
| `server/herdr/adapter.ts` | Normalizes herdr payloads into `shared/types.ts`. The only place field mapping lives. |
| `server/herdr/actions.ts` | `agent.read`, `agent.prompt`, `agent.send_keys`, `agent.wait`. |
| `server/state/store.ts` | Authoritative in-memory `Map<string, Agent>` keyed `${hostId}:${agentId}`. Computes deltas. Knows nothing about transport. |
| `server/ws/hub.ts` | Browser fan-out. Full snapshot on connect, deltas after. Knows nothing about herdr. |
| `server/routes.ts` | Hono routes. |
| `shared/types.ts` | The one payload contract, imported by server and UI. |
| `shared/herdr-api.d.ts` | **Generated** from `herdr api schema --json`. Committed. |
| `web/` | React + Tailwind, single screen. |

The dependency direction is strict: `socket → adapter → store → hub → UI`. Nothing
upstream imports anything downstream. A herdr protocol change touches
`socket.ts`, `adapter.ts`, and the generated types — nothing else.

---

## 3. herdr integration

### Transport: unix socket, not the CLI

herdr exposes a socket API at `$HOME/.config/herdr/herdr.sock` with **90 methods**
and a published JSON Schema (`herdr api schema --json`, protocol 19,
schema_version 1). paddock holds one long-lived event stream plus a fresh
connection per request — see §2.

| Need | Method |
|---|---|
| Initial state, 30s reconcile | `agent.list` |
| Workspace labels | `workspace.list` (joined during reconcile) |
| Live status changes | `events.subscribe` → `pane.agent_status_changed` (**per pane**) |
| A new agent appeared | `events.subscribe` → `pane.agent_detected` (global) |
| An agent went away | `events.subscribe` → `pane.closed`, `pane.exited` (global) |
| Read pane output | `agent.read` |
| Send a reply | `agent.prompt` |
| Answer a TUI prompt | `agent.send_keys` |
| Confirm an action landed | `agent.wait` |
| Host-side desktop notification | `notification.show` |

**Why not the CLI or a plugin.** The plugin-hook approach forks a process on every
status change and requires the user to install a plugin. Speaking the socket
directly has lower latency, no per-event process spawn, and no install step.
(It does *not* buy a single shared connection for events and actions — herdr
closes a connection after each response, see §2.)

**Why push primary, poll secondary.** `events.subscribe` delivers changes in
milliseconds. The 30s `agent.list` reconcile exists *only* to heal missed events —
not as the primary mechanism. This is the inverse of a polling design.

### Subscriptions are per-pane, and delivery names differ from subscription names

Two facts here are easy to get wrong and both were verified against a live
herdr 0.8.0 rather than read off the schema.

**1. `pane.agent_status_changed` requires a `pane_id`.** There is no global
form. Subscribing without one is rejected outright:

```
{"error":{"code":"invalid_request","message":"missing field `pane_id`"}}
```

So paddock cannot subscribe once and receive every agent's status. It must
bootstrap from `agent.list` and name every pane it cares about. One
`events.subscribe` call carries the whole set — per-pane and global entries
together — so this costs one call, not one per pane.

To keep that set current, paddock also subscribes to the **global**
`pane.agent_detected` (a new agent appeared) and `pane.closed` / `pane.exited`
(one went away). Those take no `pane_id`. When either fires, the pane set has
changed: paddock re-opens the stream with the new set and reconciles.

`pane.closed` is a bonus the original design lacked — a vanished agent
disappears immediately instead of lingering until the next 30s reconcile.

**2. The delivered `event` name is not always the name you subscribed with.**
There are two channels. The three *subscription* kinds keep their dotted names;
everything else is delivered with underscores:

| Subscribe with | Arrives as |
|---|---|
| `pane.agent_status_changed` | `pane.agent_status_changed` (dotted) |
| `pane.output_matched` | `pane.output_matched` (dotted) |
| `pane.scroll_changed` | `pane.scroll_changed` (dotted) |
| `pane.agent_detected` | `pane_agent_detected` (**underscored**) |
| `pane.closed` | `pane_closed` (**underscored**) |
| every other subscribable type | underscored equivalent |

A `switch` on the subscribed name silently never matches for the underscored
majority — no error, just a dashboard that never learns about new or closed
agents. The adapter must map both forms explicitly.

For the record, **27 event types are subscribable**, not the three dotted ones.
The three-item list is `SubscriptionEventKind`; the subscribable set is
`Subscription`, and conflating them is what hid `pane.closed`.

### Use `agent.list`, never `pane.list`

Only `agent.list` returns the **`name`** field — the operator-assigned agent name.
`pane.list` omits it. This single distinction is the difference between a useful
dashboard and one where every row is identical.

### Generated types are the anti-drift measure

`make types` runs `herdr api schema --json` through a generator into
`src/shared/herdr-api.d.ts`, which is committed.

This is the highest-value decision in the design. Hand-transcribed payload contracts
drift silently: a field gets renamed upstream, the consumer keeps reading the old
key, and the failure surfaces as wrong content on screen rather than an error. With
generated types it is a **build error**.

paddock also asserts `protocol === 19` on connect and fails with a readable message
naming the expected and actual versions. A protocol bump should stop the process,
not produce subtly wrong data.

### Agent states

Five values, from the schema's `AgentStatus` enum:

| State | Meaning | Section |
|---|---|---|
| `blocked` | Waiting for operator input | **Needs you** |
| `done` | Finished | **Needs you** |
| `working` | Actively running | Working |
| `idle` | Attached, not working | Idle |
| `unknown` | Not a recognised agent | **Filtered out** |

Panes with `agent_status: unknown` **or no `agent` field** are excluded entirely —
that is how ordinary shell panes appear, and they are not agents.

---

## 4. Data model

`src/shared/types.ts` is the single contract. Server and UI both import it.

```ts
export type AgentState = 'blocked' | 'done' | 'working' | 'idle';

export interface Agent {
  hostId: string;        // always set, even single-host — see §13
  agentId: string;       // herdr pane_id, stable per pane
  name: string;          // operator-assigned name — the PRIMARY label
  task: string;          // terminal_title_stripped — the live task line
  state: AgentState;
  workspaceId: string;
  workspaceLabel: string | null;
  cwd: string;
  stateSince: number;    // epoch ms — drives elapsed time
  updatedAt: number;
}

export type ServerMessage =
  | { type: 'snapshot'; hostId: string; agents: Agent[]; serverTime: number }
  | { type: 'delta'; upserted: Agent[]; removedIds: string[]; serverTime: number }
  | { type: 'output'; agentId: string; lines: string[]; source: string }
  | { type: 'prompt'; agentId: string; text: string; options: PromptOption[] | null }
  | { type: 'actionResult'; agentId: string; ok: boolean; detail?: string };

export interface PromptOption {
  label: string;         // the option's REAL text, as rendered by the agent
  key: string;           // key to send via agent.send_keys
}
```

Three notes:

- **`name` is the primary label, `task` the subtitle.** Never `basename(cwd)` —
  agents sharing a working directory would all render identically.
- **`stateSince`, not a formatted string.** The server sends epoch ms; the client
  formats. Elapsed time then stays correct without server chatter.
- **`hostId` from day one.** Cheap now, avoids a migration later. See §13.

---

## 5. The approve path

**"Approve" is not "send `y`".** Agent permission prompts are TUI selectors —
numbered options with arrow-key navigation. Sending `y` types a literal character
into a list. Worse, a wrong keystroke may select a *different* option, such as
"no, and here's what to do instead", which is worse than doing nothing.

paddock never guesses:

1. On transition to `blocked`, call `agent.read` with `source: 'detection'` — the
   snapshot herdr itself used to classify the agent as blocked.
2. Parse the option list. Emit `PromptOption[]` carrying each option's **real
   label** and the key that selects it.
3. The UI renders one button per real option, labelled with that text. There is no
   generic "Approve" button unless the agent actually offered one.
4. Tapping sends `agent.send_keys` with the mapped key.
5. Confirm with `agent.wait` — waiting on the agent **leaving `blocked`**
   (`--until working --until idle --until done`), not on it reaching `working`.
   An option that declines sends the agent to `idle`, so a `working`-only wait
   would report a false failure on every rejection. Bounded by a timeout. Report success
   or an explicit failure.
6. **If parsing fails, degrade honestly:** show the raw output and a free-text reply
   box backed by `agent.prompt`. Never synthesise a default action.

Step 6 is the important half. An unrecognised prompt shape must look like "here is
the output, type your answer" — never a confidently mislabelled button.

`agent.prompt` accepts arbitrary text, so the *scope* boundary is enforced at the
API layer: a reply is accepted only for an agent currently in `blocked`, and there
is no general-purpose send endpoint.

---

## 6. UI

### Layout: triage groups, dense rows

Ordering is by **what needs attention**, not by name:

```
dev-box                        1 blocked · 2 working · 3 idle

⚠ NEEDS YOU · 1
┌────────────────────────────────────────┐
│ ● schema-migration              2m     │
│   Apply migration to staging           │
│   ┌──────────────────────────────────┐ │
│   │ Run migration on staging? (1/2)  │ │
│   └──────────────────────────────────┘ │
│   [ Yes ]  [ No ]          [ Output ]  │
└────────────────────────────────────────┘

WORKING · 2
● api-refactor      Extract auth middleware        now
● perf-audit        Profile the request path       now

IDLE · 3                                            ▾
( docs-cleanup ) ( flaky-test-fix ) ( lint-config )
```

- **Needs you** — full card. Amber for `blocked`, green for `done`. Task text wraps.
- **Working** — dense rows with separators, right-aligned elapsed time, task text
  truncated to one line.
- **Idle** — collapsed to chips; expands into the same dense rows.
- Section order is **fixed**. An agent changing state visibly moves, but the
  operator always knows where to look.
- Within **Needs you**, most-recently-changed first.

### Visual style

Near-black ground, hairline borders, one accent colour, tight letter-spacing —
restrained enough that colour carries only meaning.

| Token | Dark | Purpose |
|---|---|---|
| `--bg` | `#08090a` | page |
| `--border` | `#1f2126` | hairlines |
| `--fg` | `#f7f8f8` | primary text |
| `--fg-dim` | `#8a8f98` | task text |
| `--accent` | `#5e6ad2` | working |
| `--warn` | `#e0a838` | blocked |
| `--ok` | `#3fb950` | done |

Colours are defined as tokens on bare `:root` (light values), redefined under
`@media (prefers-color-scheme: dark)` guarded with `:root:not([data-theme="light"])`,
and again under `:root[data-theme="dark"]` so a manual toggle wins in both
directions. **No colour has its only definition inside a media query.**

Light mode is required, not optional — this gets used outdoors.

### Motion

Status changes cross-fade the state dot and animate the row's section move. No
spinners, no skeleton shimmer. On a glance-dashboard, movement should mean
"something changed" and nothing else. Respects `prefers-reduced-motion`.

### Responsive: capability, never device

Device detection is the bug, not the solution. Three concerns, three mechanisms:

| Concern | Mechanism |
|---|---|
| Layout | CSS width media queries — one breakpoint at 640px |
| Tap targets, hover affordances | `@media (pointer: coarse)` / `(hover: hover)` |
| Install / notification prompts | capability + install state |

There is **no `isMobile` flag and no user-agent parsing anywhere.**

The "Add to Home Screen" prompt appears only when all of: the browser signalled
installability (`beforeinstallprompt`, or iOS Safari detected by feature, not UA),
`display-mode` is `browser` rather than `standalone`, and the prompt was not
dismissed. Nobody is offered a button for a capability they do not have.

Below 640px: single column, detail opens as a bottom sheet. Above: centred
max-width column, detail opens as a side panel beside the list.

Action buttons respect `env(safe-area-inset-bottom)` so they never sit under a
phone's home-indicator gesture area.

### Component tree

```
<App>
  <ConnectionBanner/>            only rendered when degraded
  <HostHeader/>
  <Section kind="needs-you">  <BlockedCard/> <DoneCard/>
  <Section kind="working">    <AgentRow/>
  <Section kind="idle" collapsible>  <AgentChip/> | <AgentRow/>
  <AgentDetail/>                sheet <640px, side panel above
</App>
```

State lives in one Zustand store. (`useReducer` + context is the zero-dependency
alternative if the dependency is unwanted.)

---

## 7. Connection lifecycle

This receives more attention than usual because the target network is a
high-latency mobile link — roughly 250 ms RTT with heavy jitter. Sockets *will*
drop and intermediate NAT *will* reap idle ones.

1. On connect, the server sends a **full snapshot**; deltas afterwards.
2. On reconnect, always re-request the full snapshot. Never assume deltas resumed.
   Snapshot application is idempotent replacement.
3. Reconnect with exponential backoff **plus jitter**, capped ~15 s.
4. **Staleness is shown, never hidden.** If the socket is down, or no message has
   arrived in 60 s, the UI dims and the banner reads
   `Reconnecting · last updated 3m ago`. A dashboard that presents old data
   confidently is worse than one that admits it is stale.
5. Page Visibility API: suspend reconnect attempts while hidden; on becoming
   visible, reconnect and refresh immediately, so unlocking the phone shows current
   data rather than an hour-old screen.
6. Pull-to-refresh forces a reconcile.

---

## 8. Repository layout

```
paddock/
├── README.md                  credits herdr-remote for the idea
├── CLAUDE.md                  public-repo rules (§10)
├── LICENSE                    MIT
├── Makefile
├── Dockerfile  docker-compose.yml
├── package.json  bun.lock  tsconfig.json
├── vite.config.ts  tailwind.config.ts
├── .env.example
├── .gitignore                 includes .private-denylist
├── docs/
│   ├── design/                this document
│   ├── architecture.md        module map, dependency direction
│   ├── herdr-socket-api.md    protocol 19, methods used, what was verified
│   ├── decisions.md           ADR-style, including "no app token" and why
│   ├── deploy-cloudflare.md   tunnel hostname + Access application
│   ├── gotchas.md             failure modes and their causes
│   └── roadmap.md             backlog (§13)
├── scripts/
│   ├── gen-herdr-types.ts     schema → shared/herdr-api.d.ts
│   └── check-private.sh       public-repo scanner (§10)
└── src/
    ├── server/  index.ts routes.ts state/store.ts ws/hub.ts
    │            herdr/{socket,adapter,actions}.ts
    ├── shared/  types.ts herdr-api.d.ts
    └── web/     main.tsx store.ts components/ styles.css
```

---

## 9. Running it

### Commands

```
make dev        vite HMR + server reload, no Docker — the iteration loop
make types      regenerate src/shared/herdr-api.d.ts from the herdr schema
make check      tsc --noEmit + lint
make check-clean  public-repo scanner — must pass before every commit
make build      bundle UI, compile binary
make up         docker compose up -d --build
make down / make logs / make restart
```

`make dev` runs outside Docker deliberately: HMR through a bind-mounted container is
a reliable source of "why isn't my change showing". Docker is for *running*.

### CLI shape

```
paddock serve                     implemented
paddock serve --demo              synthetic agents, no herdr required
paddock agent --upstream <url>    NOT IMPLEMENTED — see docs/roadmap.md
paddock hub                       NOT IMPLEMENTED — see docs/roadmap.md
```

The two unimplemented modes exist in the argument parser and exit with a message
pointing at the roadmap. This reserves the shape so adding a second machine later
is adding a mode, not restructuring the process model.

### Docker

```yaml
services:
  paddock:
    build: .
    user: "${UID}:${GID}"                                   # 2
    ports: ["127.0.0.1:8787:8787"]                          # 3
    volumes:
      - ${HOME}/.config/herdr/herdr.sock:/herdr.sock:rw     # 1
    environment: [ "PADDOCK_HERDR_SOCKET=/herdr.sock" ]
    restart: unless-stopped                                  # 4
```

1. **The herdr socket is bind-mounted.** This is what makes containerising viable —
   paddock cannot reach the host socket otherwise.
2. **Run as the host UID/GID.** The socket is protected by filesystem permissions;
   root or a mismatched UID gets `EACCES`. The Makefile exports `UID`/`GID` because
   Compose does not provide them.
3. **`127.0.0.1:8787:8787`, never `8787:8787`.** The short form publishes on every
   interface, exposing the dashboard to the local network. A tunnel container using
   host networking still reaches host loopback.
4. Survives reboot alongside the tunnel.

A `systemd --user` unit is a reasonable alternative — no socket mount, no UID
juggling, lingering for free. Documented in `docs/` as the alternative; Docker is
the primary path.

### Security model

- paddock binds **loopback only** and has **no authentication of its own**.
- Cloudflare Access is the sole gate, in front of the tunnel hostname.
- **No application-level shared token.** A token that gates all routes also 401s
  `/sw.js`, which silently disables the service worker and therefore push
  notifications. Access provides identity, policy, and audit logging that a shared
  secret in a URL does not. Recorded in `docs/decisions.md` so it is not
  reintroduced as a "hardening" improvement.
- The WebSocket URL is derived from `location` unconditionally. No hostname
  allowlist, no special-casing.

---

## 10. Public-repo hygiene

**This repository is public.** Nothing specific to the developer or their employer
may be committed.

### Never commit

| Category | Instead |
|---|---|
| Real hostnames, domains, tunnel IDs | `paddock.example.com` |
| Cloud org / team / tenant names | `example-team` |
| Absolute home paths | `$HOME`, `~`, `/path/to/…` |
| Usernames, machine names, emails | `dev-box`, `operator` |
| Employer service names, ticket codes, internal terms | invented equivalents |
| **Real agent / workspace names** | `api-refactor`, `flaky-test-fix` |
| Credentials, bot handles, chat IDs | `.env.example` placeholders |
| LAN/hotspot IPs, device names | omit |

The last two content rows are the ones that actually leak. Review catches a
hardcoded hostname; nobody notices that a demo fixture is named after an employer's
internal tickets.

### Enforcement

`make check-clean` runs `scripts/check-private.sh`, wired into a pre-commit hook and
CI. Its pattern list is deliberately split:

- **Committed patterns — generic only:** home-directory paths, email addresses,
  RFC1918 addresses, `BEGIN .*PRIVATE KEY`, JWT-shaped strings.
- **`.private-denylist` — specific strings, gitignored.** Read if present.

A denylist containing the real strings would leak exactly what it protects, so those
never enter the repository or its history.

**Patterns must require a following path segment.** A naive home-path pattern also
matches this document and `CLAUDE.md`, which legitimately *describe* the patterns —
so the scanner would fail on its own documentation. Match a prefix followed by at
least one identifier character instead, e.g. `(/home|/Users)/[A-Za-z0-9._-]+`. This
was found by running the scan against this spec, and the same reasoning applies to
every other pattern: match the shape of a real value, not the name of the category.

### Demo mode does double duty

`paddock serve --demo` runs against synthetic agents with invented names. It is the
**only** mode used for screenshots, README images, and tests, so published media is
structurally incapable of leaking real data. It also lets someone evaluate paddock
without herdr installed.

### CLAUDE.md

The repository's `CLAUDE.md` carries these rules for future sessions, ending with:

> Run `make check-clean` before every commit. If it fails, fix the content — do not
> add the string to the ignore list.

That instruction matters: the failure mode of a scanner is someone silencing it
rather than fixing the leak.

---

## 11. Performance decisions

The workload is tiny — a handful of agents, one operator, one browser. There is no
hot path. Runtime performance is therefore **not** a design constraint, and the only
user-visible performance lever is first-page load over a slow mobile link.

Ordered by real effect:

1. **No webfont.** Use the system font stack, and a system monospace stack where
   needed. (herdr-remote ships a ~982 KB Nerd Font — several times the size of
   everything else combined. This is the single largest available saving.)
2. **Event-driven, not polling** — near-zero idle CPU, millisecond updates.
3. **One JS chunk, no code-splitting.** Counterintuitive but correct here: splitting
   trades bytes for extra round trips, and at ~250 ms RTT a round trip costs more
   than the bytes it saves. One screen, one chunk.
4. **Coalesce broadcast bursts (~100 ms).** An agent flipping
   `working → idle → working` must not emit three frames or thrash the UI.
5. **Deltas after the initial snapshot.**
6. **Never stream pane output.** Fetch on demand when a detail view opens, bounded
   by a line count. Continuously streaming several terminals over this link is the
   one way to make paddock genuinely slow.
7. **Immutable caching on content-hashed assets**, plus service-worker precache, so
   repeat opens are instant regardless of link quality.

---

## 12. Failure modes deliberately designed out

Each of these was observed in a comparable system. They are recorded here, and in
`docs/gotchas.md`, so they are not reintroduced.

| Failure | Cause | Design response |
|---|---|---|
| Every row shows the same label | Label derived from `basename(cwd)`; agents share a directory | `name` from `agent.list` is the primary label |
| A field is always empty | Read from the wrong object (pane vs workspace vs agent) | Generated types make it a build error |
| Events dropped with no error | Push script ends `curl -s … >/dev/null 2>&1; exit 0` | Log receipt at INFO; `/api/health` exposes `lastEventAt` |
| Sensitive paths in access logs | Payload sent as a GET query string | POST bodies only |
| Service worker silently disabled | Auth check gates every route including `/sw.js` | No app token; Access is the gate |
| Works on one hostname, not another | Hostname allowlist in the client | Derive WS URL from `location`, unconditionally |
| Route order load-bearing | Hand-rolled request dispatch | Hono's explicit routing |
| A repeated alert never fires again | Dedup key too coarse; a failed send consumes the attempt | Dedup on the state transition; a failed delivery does not consume it |

---

## 13. Roadmap / backlog

Not built in v1. Tracked in `docs/roadmap.md`.

- **Multi-host.** Several machines push to one tunnel-owning hub. Machine
  visibility scoped by Cloudflare Access identity — Access forwards the
  authenticated user, so per-user filtering is achievable. Seams already in place:
  `hostId` on every record, and reserved `paddock agent` / `paddock hub` verbs.
- **Web Push.** VAPID keypair, service worker, subscription store, behind a flag so
  a broken subscription can never break the dashboard. On iOS, Safari delivers push
  only to a PWA added to the Home Screen — the onboarding must say so plainly.
- **Stuck-agent detection.** `working` for more than N minutes with no output change
  is worth surfacing. `pane.output_matched` may serve.
- **Preact swap** if first-load size disappoints (~45 KB → ~4 KB gzipped, same API).
- **Per-agent deep links** (`/#/agent/<name>`) so a notification opens the right one.

---

## 14. Open questions

1. **Prompt-option parsing coverage.** *Answered: parseable.* Probed against a
   real Claude Code permission prompt. The `detection` snapshot contains the
   option list as text, options are **numbered** (`1.` `2.` `3.`) with `❯`
   marking the current selection, and the question line is separable. Answering
   via `agent.send_keys` with the option digit was verified end to end. Two
   findings shape the v2 design: option labels are dynamic and context-specific
   (one was "Yes, and always allow access to tmp/ from this project" — a
   persistent policy change, not an approval), which vindicates rendering real
   labels rather than a generic Approve; and `recent` / `recent_unwrapped`
   return `agent_not_idle` while an agent is blocked, because it renders on the
   alternate screen, so reading output must select its source by agent state.
   See `docs/design/2026-08-17-paddock-plan2-design.md` §2.
2. **`stateSince` availability.** *Answered: no timestamp.* Neither `agent.list`
   nor the status event carries one, so paddock stamps first-observation time.
   Slightly wrong across a paddock restart. Accepted.
3. **Socket reconnect semantics.** *Partly answered.* `events.subscribe` must be
   re-issued per connection, and re-issuing is the normal path anyway because the
   pane set changes (§3). Observed: on subscribe, herdr replayed `pane_closed`
   events for panes closed minutes earlier, so some backlog is delivered rather
   than dropped. The extent of that buffer is unknown and must not be relied on —
   the 30s reconcile remains the guarantee.
4. **`done` depends on being *seen*, and paddock cannot mark seen.** herdr derives
   `done` from idle-plus-unseen, where "seen" means the tab was focused in the
   herdr UI; reading over the socket does not clear it. So an agent answered from
   the phone stays `done`, and the **Needs you** section keeps showing it until
   the operator returns to the desk. `agent.focus` would clear it but yanks the
   desktop UI focus, which is worse. Left unresolved on purpose: the honest
   options are to accept a sticky `done`, or to track a paddock-local
   "acknowledged" flag that dismisses the card without lying to herdr. Decide
   before building the **Needs you** section.
5. **Zustand or `useReducer`.** One small dependency versus none. Leaning Zustand;
   reversible either way.
