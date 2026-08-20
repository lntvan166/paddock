# Journal history — design

An agent's history is not on its screen, and paddock has been trying to
reconstruct it from there. This replaces that guess with the harness's own
session log, for the harnesses that keep one.

The scope is deliberately narrow: **"Show earlier" goes deeper and stops having
gaps.** No new view, no conversation UI. `AgentTerminal` keeps its shape and
changes where its earlier lines come from.

---

## Why the current approach cannot be improved

`src/web/history.ts` accumulates a transcript by diffing consecutive viewport
snapshots and committing only the lines an offset match proves scrolled off the
top. Its own header calls it a **viewer, not a recorder**, and the two limits
that follow are structural rather than defects:

- An agent nobody had open has **no history at all**. Nothing was watching, so
  nothing was captured.
- A scroll larger than half the visible screen between polls is recorded as a
  gap rather than guessed at.

Asking herdr for more does not help, and this is measured rather than assumed.
From `docs/roadmap.md`, against herdr 0.8.0: `recent_unwrapped` costs ~35 ms per
line past the viewport — 120 lines took 3.1 s, 300 lines 10.7 s (past
`HERDR_TIMEOUT_MS`, so `POST /output` with `lines: 300` fails outright), and
500/1000/2000 lines each took ~15.8 s and returned *less* than `visible` returns
in 2 ms.

The reason is upstream of paddock. A pane running a coding agent sits on the
terminal's **alternate screen**, which has no scrollback ring — herdr's terminal
core keeps nothing behind the viewport. The bytes were never retained. No clamp,
no timeout and no better parser recovers data that was never kept.

## Where the history actually is

Claude Code writes every turn to its own session log as it goes:

```
~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl
```

**And herdr hands us the key.** Verified live against herdr 0.8.2, protocol 20,
on the `agent.list` result paddock already calls — `AgentInfo.agent_session`:

```json
{"agent": "claude", "kind": "id", "source": "herdr:claude",
 "value": "<uuid>"}
```

`pane.list` is not involved, so the rule in `CLAUDE.md` stands untouched.

This source is strictly better than scrollback would have been: real message
boundaries, timestamps, tool calls adjacent to their results, and it survives the
pane being closed. Measured on one real session while writing this document:
**1.5 MB, 729 records**, spanning 40 minutes — 201 assistant turns, 112 user
records, 93 `Bash` calls.

Codex, pi and OpenCode each keep an equivalent log. Only Claude ships in v1; the
seam for the others is a registry entry, not a rewrite.

---

## Decisions

### 1. The journal is flattened server-side; the client only ever sees lines

`journal/` returns text. The client renders it the way it renders any other
history lines, and gains no per-harness knowledge.

This is the same reason `parsePrompt` lives in `src/server/` rather than in
`web/`: the dependency rule keeps harness- and protocol-shaped assumptions on the
server side of the socket. A structured-turns payload was considered — it would
let a future conversation view reuse the route unchanged — and rejected, because
it puts a second renderer, and per-harness rendering rules, in `web/`.

Pushing history over the WebSocket was also rejected: it needs file watching and
a per-agent buffer for every open pane, which is a large amount of machinery for
an affordance the operator taps.

### 2. Journal history and reconstruction never coexist for one agent

Where a journal is readable it is the **only** source RENDERED above the live
screen — the reconstructed buffer is not drawn for that agent, and the two are
never concatenated. It keeps accumulating in the background, deliberately:
`history.ts` can only commit a line it watched scroll off the viewport, so a
buffer switched off at the source would be empty at the exact moment the pane
needs it — when a journal read answers `source: "reconstruction"` and the pane
falls back. Where no journal is readable, nothing changes from today.

Two sources for one range means reconciling overlapping text that was produced by
two different mechanisms, which is guesswork of exactly the kind this feature
exists to remove. Nothing regresses either way: a plain shell pane keeps the
reconstruction it has now.

### 3. One continuous scroll, with menus stripped from journal lines

Journal text joins the buffer above the live screen without a labelled divider.

The cost is stated plainly: those lines are a **reconstruction rendered as
prose**, and cannot reproduce the box drawing and colour the agent actually
painted, so they will not look like the screen below them.

The sharp edge is not cosmetic, and is designed out rather than accepted. A
journal turn can contain an old prompt menu — `❯ 1. Yes / 2. No` — which, blended
directly above the live screen, reads as the question being asked *now*.
`prompt-parse.ts` already records this failure in its own scoping comment: a
marker left on an already-answered question reappearing as the live menu's
selection. Therefore **cursor markers and option rows are stripped from
journal-derived lines**. Only the live screen may ever render a selectable menu.

### 4. Prose is served; tool output is not

The journal holds far more than the screen ever showed: every file the agent
read, every command's output, any secret that passed through either. paddock has
no authentication of its own (decision 3), so what this route serves is bounded
at the source rather than at the gate.

- **Kept:** assistant text, and user text the operator actually typed.
- **Summarised:** a `tool_use` becomes one line — `▸ Bash ×3 · Read timer.ts` —
  carrying the tool name and a short input hint. A run of the same tool
  collapses to one `×N` token. The hint comes from a short allow-list of input
  fields and never from `pattern`: a search pattern routinely embeds the very
  secret being searched for.
- **Dropped:** every `tool_result`. That is where file contents and command
  output live.
- **Dropped:** subagent (sidechain) traffic and thinking blocks.

A `user` record whose content is a **list** is tool-result traffic, not something
a person typed. Folding those into the call that produced them is what stops a
session rendering hundreds of fabricated "you" turns.

A `user` record whose content is a **string** is not automatically something a
person typed either, and this is measured rather than assumed. The harness
injects its own blocks into that same field — `<result>` (subagent and tool
result text), `<task-notification>`, `<output-file>`, `<system-reminder>`,
`<local-command-stdout>`, and the
`<command-name>`/`<command-message>`/`<command-args>` triple a slash command
expands to. Across the three largest session logs on the development machine,
733 string-content `user` records would have been served, 176 of them carrying a
`<result>` body. `<result>` is also how a **sidechain's** output reaches a record
whose top-level `isSidechain` is absent, so that flag alone never closed the
hole. Those blocks are **stripped**, before any truncation, and a record left
empty by stripping is **dropped** rather than rendered as a bare speaker row.

Absolute paths surviving in genuinely typed prose are deliberately **not**
redacted. That is content the operator wrote and asked to see; a scrubber over
it would mangle real messages while doing nothing about the secret a person can
type directly into a message. The bound is on the KIND of content served, which
is what "bounded at the source" means.

### 5. The session id never reaches the browser

`adapter.ts` maps `agent_session` into a **server-side** map of `agentId →
session ref`. The wire type `Agent` gains exactly one field, `hasJournal:
boolean`, which is all the UI needs in order to choose a history source.

A session id is a filesystem key. The browser has no use for one, and paddock
does not hand out filesystem keys to clients that cannot need them.

### 6. A missing journal is quiet in the UI and loud on the host

The operator sees the old behaviour, not an error: falling back to reconstruction
is a working dashboard, and a red banner for a pane that never had a journal
would be noise.

The server does not get to be quiet — `CLAUDE.md` forbids swallowing errors. Each
cause logs once per agent and travels in the response's `detail`: no adapter for
this harness, no session ref from herdr, file missing (compacted, rotated or
deleted), permission denied. An unparseable line skips **that line**, never the
file.

---

## The route

```
POST /api/agents/:id/history
→ { before?: string, limit?: number }
← { ok: true, lines: string[], source: "journal" | "reconstruction",
    hasMore: boolean, cursor: string | null, detail: string | null }
```

POST, not GET: a cursor in a query string lands in edge access logs, which
`CLAUDE.md` forbids. It is a write-shaped request only in verb, so the
same-origin gate (decision 17) covers it like any other POST.

`source` is on **every** response, so the client never infers provenance. Note
what `"reconstruction"` means precisely, because the server cannot produce those
lines: it is the server saying **"I have no journal for this agent"**, and it
comes with `lines: []` and a `detail`. Reconstruction itself stays entirely
client-side, exactly where it is today. The field is a routing answer, not a
payload description.

`limit` is counted in **turns**, not lines — a single assistant turn can flatten
to many lines, and a client asking for "50 more" means 50 more things that were
said. `before` is an **opaque cursor** echoed from a previous response; its
contents are the server's business and the client must never construct one.

Paginated from the tail. One session's file is 1.5 MB, and the existing "Show
earlier" is already an incremental reveal, so the whole file is never sent and
never read: the reader walks backwards from the end in bounded chunks and stops
once it has the requested turns. At the measured ~2 KB per record, 50 turns is
~100 KB read. Two caps, both refused rather than truncated silently: bytes
scanned per request, and lines returned.

## Path safety

A session id becomes a path, so it is treated as hostile input at every step:

1. It must match the canonical uuid shape **before any filesystem call**.
2. The resolved `realpath` must lie inside a configured root.
3. Roots are a **list**, not a string: `CLAUDE_CONFIG_DIR` gives one machine
   several Claude homes. Roots are searched in order and the first holding the
   session wins — session ids are globally unique, so that is a lookup, not a
   guess.

## Demo mode

`--demo` has no herdr and no journals, and `README.md` screenshots come from
`--demo`. `docs/roadmap.md` already carries one feature invisible there (the
approve path); adding a second is a choice, not an accident.

So the demo backend ships a small synthetic journal for one demo agent, with
invented content per house rule 2, and `hasJournal` true for it. "Show earlier"
then works in the mode the screenshots come from.

This route is therefore registered **unconditionally**, not inside the
`deps.actions` block. It reads a file and never touches herdr, so gating it on a
herdr dependency it does not use would repeat the `/ack` mistake recorded in
`routes.ts`: the one feature that works without herdr being the one visibly
broken in `--demo`.

## The risk worth stating

This file is Claude Code's private format, not a documented API, and it will
change without notice. The mitigations are structural rather than hopeful:
unknown record types are tolerated instead of fatal, a bad line is skipped, and
any failure degrades to exactly today's behaviour. The Claude Code version the
shape was verified against goes in the adapter's header and is updated whenever
it is re-checked — the same discipline `docs/gotchas.md` applies to every other
measured claim in this repo.

---

## Files

| File | Change |
|---|---|
| `src/server/journal/registry.ts` | new — harness → adapter; adding one is a line |
| `src/server/journal/claude.ts` | new — the only adapter in v1 |
| `src/server/journal/files.ts` | new — containment, roots, bounded tail reader |
| `src/server/journal/text.ts` | new — truncation, ANSI stripping, tool summaries |
| `src/server/journal/types.ts` | new — adapter interface, transcript entry |
| `scripts/gen-herdr-types.ts` | emit `agent_session`; it is absent today |
| `src/shared/herdr-api.d.ts` | regenerated by `make types`, never hand-edited |
| `src/server/herdr/adapter.ts` | map `agent_session` into the server-side ref map |
| `src/shared/types.ts` | `Agent.hasJournal: boolean` |
| `src/server/routes.ts` | `POST /api/agents/:id/history` |
| `src/web/components/AgentTerminal.tsx` | "Show earlier" fetches when `hasJournal` |
| `src/web/demo/backend.ts` | synthetic journal for one demo agent |
| `docs/decisions.md` | the new axis, and decisions 1–6 above |
| `docs/architecture.md` | `journal/` in the dependency diagram |

## Tests

- **Adapter**, over fixture JSONL with invented content: turn extraction, tool
  folding, list-content `user` records folded rather than rendered, sidechain and
  thinking dropped, unknown record types tolerated, one bad line skipped without
  losing the file.
- **Containment**: `../` refused, a uuid-shaped path resolving outside the root
  refused, a non-uuid refused before any filesystem call.
- **Tail reader**: asserts the bytes actually read for a tail request, and that a
  record split across a chunk boundary is recovered.
- **Route**: pagination and cursor, `source` on every response, fallback to
  `reconstruction` with a `detail`, and the same-origin gate applying to it.
- **Client**: `hasJournal` chooses the source; journal lines carrying a menu are
  stripped of markers and option rows before they enter the buffer.
- **Mutation pass**, per house rule 4: break each guard and watch the test fail
  before trusting it.

## Documentation

`docs/gotchas.md` gains the alternate-screen finding — why scrollback cannot be
read from herdr at all — since it is the measurement that justifies this entire
feature and will otherwise be rediscovered. `docs/roadmap.md`'s
`MAX_READ_LINES` entry is resolved by it and should say so rather than being
deleted.
