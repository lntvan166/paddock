# herdr-core as a second backend

Status: awaiting the operator's review, 2026-11-09. Gated on Risk 1.

## Intent

herdr now ships a desktop app (`herdr-app`). Its terminals run in a separate
runtime, **herdr-core** (`hc`), with its own socket and its own API. Terminal
herdr (the TUI, 0.9.5, the latest release) is unchanged and still has its own
server and socket. The two do not share state. paddock talks only to the TUI
today, so agents started from the app are invisible to it.

The operator wants paddock ready before they move work into the app. One
paddock should show **both**: agents from the TUI and agents from the app in
the same Agents list and the same Spaces screen, with every action the TUI
path has. Nothing is in the app yet. This is preparation, so the TUI path
must keep working exactly as it does now.

## Goals

- **One list.** App agents and TUI agents appear together in the Agents list,
  grouped into Needs you / Ready / Working / Idle by the existing rules, and
  counted by the existing badge, finding line and notifications.
- **One Spaces screen.** The app's spaces and tabs appear beside the TUI's
  workspaces and tabs, with the same states, rows and drill-down.
- **Parity of actions.** Every action available for a TUI agent or space is
  available for an app one:
  - in the terminal: read the screen and history, answer a blocked prompt
    (on its dashboard card and in the terminal), send keys, send text, Stop,
    attach an image, run quick replies and slash commands;
  - on agents: rename, close;
  - on spaces and tabs: create (with a harness and a folder), rename, close;
  - start an agent in a chosen space or tab.
- **Notifications** (Telegram, web push) fire for app agents under the same
  triggers, settle times and presence rules.
- **Either backend may be absent.** No herdr-core installed, core not
  running, TUI not running: paddock runs on whatever is there, says plainly
  in Settings → Connection which backends it reached, and never errors
  noisily about a backend that is not installed.
- **Each agent's origin is visible.** A small mark on the row and in the
  terminal header says TUI or app. The two are reopened and continued in
  different programs on the desk.

## Non-goals (first version)

- Remote machines (`hc machine …`). Only terminals on this machine's core.
- Mod panes (the app's markdown viewer, boards, git panel). They are not
  terminals and are not shown.
- Sub-agents without a pane (terminals an agent started with `hc run`, which
  have a `parent`). See "Left to the builder" below.
- Moving or reordering spaces or tabs, and any focus, zoom or attention
  state, which the app keeps per screen.
- Migrating sessions between the TUI and the app.

## Anti-goals: failure even if it "works"

- **A guessed answer.** A one-tap answer button for a prompt shape paddock
  did not positively recognise. The existing rule ("never guess a keystroke")
  applies unchanged. herdr-core reports `status.kind` (`permission`,
  `question`, `auth`) for a blocked program, and it must be used as a
  *signal*. It is never permission to skip parsing the real options.
- **Silently rewriting the app's layout.** Writing the `herdr-app` core
  document in a format paddock does not own, and losing a person's spaces
  or splits on the next app write. The app's own docs say "use commands to
  change structure".
- **A control that does nothing.** A Rename that resolves while the app is
  closed and changes nothing. A control that cannot work says why on screen.
- **Two lists.** A separate "app agents" screen or toggle. The point is one
  place to look.
- **Breaking the TUI path,** or making it slower, while preparing for a
  backend nobody uses yet.

## Constraints

- **Architecture rules stand.** The dependency direction is
  `backend/socket → backend/adapter → state/store → ws/hub → web/`. Only
  backend directories know a backend exists. `src/shared/types.ts` stays the
  one payload contract, so the UI never learns herdr-core's field names. The
  new code lives in its own directory beside `src/server/herdr/`, for example
  `src/server/herdr-core/`. The existing TUI adapter is not rewritten into an
  abstraction first. Each backend implements the actions interface that
  `routes.ts` already consumes, and a small composite routes a call by the
  id's origin.
- **Generated types.** As for the TUI, the core's API types are generated
  from `hc schema` (OpenRPC JSON) by a `make types` step, committed, and never
  hand-edited.
- **Ids never collide and never lie.** Core addresses (`t7`), space ids
  (`spe…`) and tab ids (`tb…`) are namespaced so they cannot equal a TUI id
  (`w1:p1`) and so a route can tell the origin from the id alone. The ids
  survive URLs (`#/pane/<id>`), POST bodies and the pane cache.
- **Public repo.** Fixtures, demo data and tests use invented names. The
  browser demo and `paddock serve --demo` show app agents and app spaces from
  synthetic data. The `demo-actions` refusal rule covers every new write.
- **No new auth, no GET payloads, no swallowed errors.** As everywhere else.
  A core that cannot be reached is logged at INFO with the reason, and
  `/api/health` reports each backend's last event time.
- **herdr-core is young** (0.1.x, "protocol generation 1"). paddock checks
  the protocol generation in `hello`, refuses an unknown generation with a
  clear message instead of misreading it, and records the generation in
  `/api/health`, the same way the TUI's protocol is checked.

## What the reconnaissance found (facts the design rests on)

The sources: `hc schema` (herdr-core 0.1.19), `herdr-app --help`,
`~/.config/herdr-app/AGENTS.md`, and the upstream repos
`herdrdev/herdr-core` (`schema/README.md`, `docs/security.md`,
`docs/commands.md`, `CHANGELOG.md`) and `herdrdev/herdr-app`
(`docs/labels.md`, `docs/commands.md`, `CHANGELOG.md`), read 2026-11-09:

- **Terminal herdr is not moving onto the core yet.** 0.9.5 (2026-10-14) is
  the latest TUI release, and its changelog and commits through 2026-10-29
  say nothing about herdr-core. But the app's `docs/labels.md` lists the
  clients that share core state as "the desktop app, the phone app, a
  terminal UI". A core-based terminal client may come later, so the TUI
  adapter must stay separate and retirable, not entangled with the new one.
- **The core moves fast and promises not to break.** Releases every two to
  four days (0.1.15 to 0.1.19 between 2026-10-30 and 2026-11-07). Its
  schema README says "the API only grows": a test fails on any breaking
  change against `released.openrpc.json`, and a real break needs a new
  protocol generation. So paddock checks the generation and tolerates
  unknown fields and new values.
- **Locating the socket** (core `docs/security.md`): `HC_SOCKET` overrides
  it. Otherwise it is `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, then
  `/run/user/<uid>/herdr-core/<session>.sock`, then the session's state
  directory (`~/.local/state/herdr-core/<session>/`). The default session
  is `default`. paddock follows the same order and offers its own override.
- **Connection model** (core `schema/README.md`): "plain mode" is JSON-RPC
  2.0, one message per line, request ids, several requests per connection
  (unlike the TUI's one-response-and-close). `events.subscribe` on a plain
  connection turns it into an event stream. Events carry a rising `seq`.
  A `heartbeat` arrives every 15 s, and a subscriber that falls behind gets
  `missed` with a fresh snapshot. Doc changes arrive as `doc` events with
  `{name, version}`, including the `herdr-app` layout document.
- **Seen and pinned are a shared protocol** (app `docs/labels.md`). Clients
  write `herdr.seen=<turn>` when a person is really looking at an agent,
  and `herdr.pinned=1` to pin. Every client shows an agent as needing you
  when it is `blocked` or `error`, working when `working`, and otherwise
  **done when `turn > herdr.seen`, else idle**. A missing label is "use your
  own rules", not 0. "Looking" means in the foreground and drawn on screen,
  not a screen left on in an empty room; write once per turn; last writer
  wins. Seen state is already shared between "Herdr windows and the phone
  app" (app CHANGELOG).
- **Typing into a blocked program needs `force`.** `terminal.send` refuses
  to type while the program is blocked unless `force: true` ("it may answer
  its dialog"). `terminal.keys` has no `force` parameter and follows "the
  same quiet rule as send". Whether keys reach a blocked dialog must be
  measured first (see Risks).
- **An official phone client exists.** "Herdr Mobile" (`dev.herdr.mobile`,
  Android) connects over SSH, and there are third-party iOS clients
  (Heeler, herdrup). This is context for paddock's place, not a requirement
  of this design.

- **Transport.** JSON-RPC 2.0, one message per line on the core socket
  (`/run/user/<uid>/herdr-core/default.sock` here; the builder finds the
  documented way to locate it rather than hardcoding the path). It opens
  with `hello`, which reports the protocol generation and features.
  `framed: true` switches a connection to framed mode for raw `attach`
  streams (see the connection model above).
- **Agents.** A terminal is an agent when its program reports a status
  (OSC 7501). `terminal.status` is `{ state, kind, msg, title, progress,
  app }`, where `state` is one of idle, working, done, blocked, error and
  `kind` (blocked only) is permission, question or auth. `status_ms` says
  when the word last changed, so `stateSince` can be exact. `name`, `cwd`,
  `labels`, `argv`, `foreground`, `parent` and `turn` are on every
  terminal. `turn` is the core's counter: it rises each time the status
  leaves `working`, and a turn's end arrives as a `status` event and then a
  `turn` event.
- **Live changes.** `events.subscribe` returns a snapshot, then every fact
  change in order.
- **Actions.** `terminal.read` (screen plus history as text), `terminal.keys`
  (named keys, encoded for the program's keyboard modes), `terminal.send`
  (paste and Enter, waiting for ~3 s of no typing), `terminal.interrupt`,
  `terminal.put` (a file beside the terminal: images), `terminal.kill`,
  `terminal.run` (with labels, `--keep`), `terminal.label`, `doc.get` and
  `doc.set` (versioned opaque documents).
- **Spaces and tabs.** The app stores spaces, tabs and splits in the core's
  `herdr-app` document. Every terminal the app shows carries the labels
  `herdr.space=<id>` and `herdr.tab=<id>`. A terminal started with those
  labels appears in that space and tab even when paddock starts it. An id
  the app does not know becomes a new space or tab, unnamed and called by its
  place. An unnamed space is named after its first terminal's repo, else its
  folder, else `~`. A space's or tab's status is its most urgent agent's:
  blocked > done > working > idle. Closing the last terminal of a tab closes
  the tab, and the last tab closes the space.
- **Structure commands live in the app.** `space.rename`, `tab.rename`,
  `space.new`, `tab.new`, `space.close` and `tab.close` are `herdr-app do`
  commands, served by the running window over `~/.config/herdr-app/herdr-app.sock`.
  "Structural commands fail while that machine's layout is unavailable."

## Decided

These are the operator's decisions:

- Both backends at once, merged into one Agents list and one Spaces screen.
- App spaces and tabs are shown.
- Full parity with the TUI path for agent, terminal, space and tab actions.

These are the designer's calls, made with the operator watching and open to
review:

- **Reads come from the core only.** Grouping uses the terminal labels, which
  are documented and stable. Names and order come from the `herdr-app`
  document when it can be read. When it cannot (an unknown shape, or a
  missing document), paddock falls back to the app's documented naming rule
  and still shows the spaces. A failed document read is logged and degrades
  names only, never visibility.
- **Writes that the core can do, the core does, with no window needed:**
  - start an agent in a space or tab: `terminal.run` with the two labels and
    keep;
  - create a tab or space: a fresh id in the labels of the first terminal;
  - close an agent: kill the terminal;
  - close a tab or space: kill its terminals, so the app closes the empty
    tab and space by its own rule;
  - rename an agent: the terminal's name.
- **Renaming a space or tab goes through the running app** (its socket,
  using the same command `herdr-app do space.rename` sends). When the app is
  not running, the Rename control is still shown and says "Open Herdr to
  rename app spaces" instead of acting. paddock never writes the `herdr-app`
  document. If the builder finds that create and close are also more
  faithful through the app's commands when it *is* running (for example, to
  name a new space at creation), use them then, and fall back to the core
  path when it is not.
- **The blocked prompt:** the existing parse of the screen (`parsePrompt`,
  dialog detection) runs on `terminal.read` output, and its options and
  `commit` rules apply unchanged. `status.kind` may refine the choice, for
  example never offering one-tap buttons when it says `question` or `auth`,
  but a missing or unexpected `kind` must not make paddock offer buttons it
  otherwise would not.
- **Ready, Dismiss and presence speak `herdr.seen`.** For app agents,
  paddock does not keep its own acknowledged state. Ready follows herdr's
  shared rule exactly: an agent that is not blocked, error or working is
  Ready when `turn > herdr.seen`, **including an idle one**. This differs
  from TUI agents, where only `done` is ever Ready. The grouping rule
  therefore depends on origin, and the shared `Agent` contract gains what
  it needs to express that (for example `turn` and `seen`). The UI never
  reads herdr-core field names. Dismiss writes `herdr.seen=<turn>`, also when the label is missing,
  as `docs/labels.md` asks, so terminals started elsewhere join.
  **paddock writes the label only on a deliberate act** (the operator's
  decision): tapping Dismiss, or OPENING the agent (once, at the tap that
  opens its terminal). It does not write it continuously while a terminal
  stays open, and it does not tie it to presence. A tab left open on a desk
  must not clear "done" for every herdr client. That is the same reasoning
  that kept presence suppression per-device. paddock's per-device presence
  rule for its own notifications is unchanged. Dismissing on the phone
  clears "done" in the desktop app and in the phone app, and the reverse. With no label
  and no dismiss yet, paddock falls back to its current acknowledge model
  for that terminal.
- **Notifications respect `herdr.seen`.** At settle time, an app agent whose
  `herdr.seen >= turn` has already been seen (at the desk, in the app) and
  is not announced. `notify/` gains labels as an input for app agents.
- **Naming at creation with the app closed.** When the app is running,
  create goes through its commands, so the typed name is applied. When it is
  not, the name field says "Open Herdr to name it now". The space or tab is
  still created through the core and is called after its folder, and the
  name is never silently dropped.
- **`error` is "needs you"**, as every herdr client shows it. It gets its
  own state word ("Error") in the Needs you group and triggers the blocked
  notification. It never shows one-tap answer buttons. Adding the state to
  `AgentState` and every map that switches on it is part of the work.
- **Origin mark:** a small, quiet label (for example "app") on the row's
  second line and in the terminal header for app agents. TUI agents carry no
  mark, so the existing screens are unchanged for the operator's current
  setup.

## Left to the builder

- The id namespace format. It must be URL-safe, readable in a log, and must
  never parse as a TUI id.
- How many core connections to hold (one stream plus one for requests is
  the obvious shape). The README allows several requests per connection;
  measure reconnect behaviour on `hc server restart` and record it like the
  TUI's measurements.
- How to locate the app socket (`~/.config/herdr-app/herdr-app.sock`, or
  `HERDR_APP_HOME`) and its wire format. It is the channel `herdr-app do`
  uses; read the app source or probe it, and record what was measured.
- Sub-agents with no pane: include them in the Agents list (they are agents
  and can block) or leave them out for v1. If out, say so in Settings or the
  docs.
- Whether the history/journal path ("Show earlier") applies to app agents.
  `terminal.read` with `lines` may already cover it.
- Test strategy: a fake core socket in tests, mirroring how the TUI socket is
  faked, plus a live probe test, like `tests/dialog-live.test.ts`, run
  against a throwaway agent in the real app when herdr-core updates.

## Risks to settle first

**Risk 1 is a gate, by the operator's decision.** Nothing else in this
design is built until it passes. If keys cannot reach a blocked dialog and
there is no supported way through, **the project stops** and waits for
herdr-core to support it. The probe's findings are recorded either way.

1. **Answering a blocked prompt.** This is paddock's reason to exist. Probe a
   throwaway Claude Code agent in the app, one key at a time (CLAUDE.md:
   "probe a TUI one key at a time"). Check whether `terminal.keys ["1"]`
   reaches a blocked permission dialog, and whether `terminal.send` with
   `force` is needed for text answers. If keys are held while blocked,
   find the supported way before building anything on top. Record the
   findings in the style of `tests/dialog-live.test.ts`.
2. **The layout document's shape.** Read `doc.get herdr-app` on a real app
   with two spaces and a split. Confirm that names and order can be read,
   and that paddock degrades correctly when they cannot.
3. **Rename through the app socket.** Confirm the app answers on its socket
   when its window is closed but the process lives (macOS keeps running),
   and what it says when it does not.

## Done means

- With only the TUI running, every existing test passes and the screens are
  unchanged.
- With only the app running, its agents and spaces appear, a blocked Claude
  Code permission prompt in the app is answered from the phone (card and
  terminal), and the agent resumes. This is verified from a *used* screen:
  answer one prompt, then the next.
- With both running, the list and Spaces merge, the badge and finding count
  both, and a notification fires for an app agent.
- Rename with the app closed says why it cannot. With the app open, it
  renames and the app shows the new name.
- `/api/health` and Settings → Connection show each backend's state.
- The demo shows app agents and an app space from invented data, and every
  new write is refused there.
