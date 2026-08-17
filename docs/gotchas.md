# Gotchas

Failure modes observed in a comparable system, or found while building this
one, recorded here so they are not reintroduced.

| Failure | Cause | Design response |
|---|---|---|
| Every row shows the same label | Label derived from `basename(cwd)`; agents commonly share a working directory | `name` from `agent.list` is the primary label — this is the defect the project exists to prevent |
| A field is always empty | Read from the wrong object (pane vs workspace vs agent) | Generated types make a rename a build error |
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
