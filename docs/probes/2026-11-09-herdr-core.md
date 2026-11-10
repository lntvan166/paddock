# Probe: answering a blocked prompt through herdr-core (2026-11-09)

Task 1 of the herdr-core backend plan, and the gate in
`docs/superpowers/specs/2026-11-09-herdr-core-backend-design.md` ("Risks to
settle first", risk 1). Nothing else in that design is built until this
passes. Risks 2 (the layout document) and 3 (renaming through the app socket)
were measured in the same session while the probe existed.

GATE: PASS — answer with `terminal.keys {terminal, keys:["<digit>"]}`, one key per call; never `terminal.send` with `force`

## Versions

| Piece | Version |
|---|---|
| herdr-core (`hc --version`, `server.status`) | 0.1.19, protocol generation 1 |
| Herdr desktop app (`herdr-app --version`) | 0.1.14 (Linux) |
| Claude Code | the release current on 2026-11-09, model shown as Opus 5.5 |

`hello` (no params) answered with `generation: 1` and features
`framed, attach, events, status, shell, resize_notifications, automatic_input`.

## Method

All requests were plain-mode JSON-RPC on the core socket, one JSON message per
line, from a scratch Bun script (not committed) — the same thing
`tests/core-live.test.ts` now does. Only terminals the probe created were
touched: they carried the labels `herdr.space=probe` / `herdr.tab=probe`
(and `probe2` for the second-space test), ran in a `mktemp -d` folder, and
were killed and removed at the end. The operator's own space and terminal
were never read, sent to, labelled or killed.

```sh
cd "$(mktemp -d)"
hc run --bg --keep --name probe-blocked \
  --label herdr.space=probe --label herdr.tab=probe -- claude
```

Claude Code started in **auto mode**, which approves on its own and so never
blocks. One `terminal.keys ["shift+tab"]` (sent while idle, so nothing held
it) moved it to manual mode. The probe was then asked, with `hc send`, to run
`touch probe-file.txt` with the Bash tool, and `hc wait` returned when it
blocked:

```json
{"status":{"app":"claude-code","kind":"permission","msg":"approve Bash: touch probe-file.txt","state":"blocked"}}
```

Every step below sent ONE key or ONE request, then read the status and the
screen, as CLAUDE.md requires for a TUI.

## Step 2 — reading the prompt

`terminal.read {terminal}` returns `{text, complete, how}`; here
`complete: true, how: "screen"`. The prompt's tail:

```
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to <scratch folder> from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

**"No" is option 4, not 3.** In manual mode, Claude Code adds "Yes, and switch
to auto mode" as option 3. The plan's brief assumed `keys ["3"]` was "No";
on this build that key would have approved and switched the agent to auto
mode. The probe sent the digit the screen showed for "No" instead. Code and
tests must find the option by its label, never by a remembered position —
which is what paddock's parser already makes possible.

`parsePrompt` (`src/server/herdr/prompt-parse.ts`) on that text: question
`Do you want to proceed?`, `commit: "digit"`, four options with keys 1–4 and
their real labels, `selected: true` on option 1. No change is needed for the
core's `terminal.read` text.

## Step 3 — one key while blocked

| Request | Reply | Took | After (≤ 1 s) |
|---|---|---|---|
| `terminal.keys {keys:["4"]}` on a fresh prompt | `{"result":{"status":"blocked","turn":1}}` | ~70 ms | status `idle`; screen shows `Interrupted · What should Claude do instead?`; no file created |

**The key landed at once.** It was not held until the program unblocked and
not refused. The reply's `status` is the status at the moment of sending
(`blocked`), not after. "Same quiet rule as send" here means the human-typing
quiet period (keys wait for ~3 s with no person typing), not the blocked
guard: `terminal.keys` has no blocked guard. Nobody was typing during the
probe, so the quiet-period delay itself was not measured.

## Step 4 — the other paths, each on a fresh block

| Request | Result |
|---|---|
| `terminal.send {text:"4"}` (no force) | **Refused**: `{"code":-32000,"message":"<t> is blocked (permission)","data":{"kind":"blocked","hint":"typing would answer its dialog; read its screen first (hc read <t>), or --force"}}`. Prompt untouched. |
| `terminal.send {text:"4", force:true}` | Reply `{"started":true,"status":"blocked"}` in ~270 ms. **It APPROVED the command**: the status went to `working`, the tool ran, and the file was created. The pasted `4` is a paste, not a key press, so the dialog did not take it as a digit, and the Enter that `send` adds committed the cursor row — option 1, "Yes". |
| `terminal.keys ["down"]` ×3, one per call, then `["enter"]` | Cursor moved 1→2→3→4 (each read back on screen), then Enter committed "No": status `idle`, `Interrupted`. |
| Used dialog: `terminal.keys ["down"]` (cursor on 2), then `["4"]` | The digit picked its own row, "No", regardless of the cursor. |

The forced-send result is the trap this probe exists to catch. `force` is
the documented override, and it answers the dialog, but not with the option
you asked for. A "No" sent that way is a "Yes". **paddock must never answer a
dialog with `terminal.send {force:true}`.** Text answers (the free-text row of
a question dialog, "Tab to amend") need a separate measurement before any code
uses `force` for them. That is out of scope for the gate, because
`terminal.keys` covers every option answer.

The harmless consequence here: the probe ran `touch` in its own scratch
folder once.

## Step 5a — the connection model

- **One plain connection carries many requests.** `hello`, then 200
  sequential `terminal.get`, then 200 pipelined `server.status` with distinct
  ids, then another request after 5 s idle: every one answered, and the
  connection stayed open. Replies match by `id`.
- **`events.subscribe {}`** answered first with a snapshot
  `{channel: null, seq, terminals: [...]}`. That includes finished terminals,
  so filter on `state`. After it came `heartbeat {seq}` every 15.00 s and
  `event` notifications shaped `{type, terminal?, seq, data}`. Types seen:
  `created` (data: the whole terminal record), `foreground`, `keep`,
  `labels` (data: the full label map, not a diff), `size`, `status`, and
  `doc` (`{name:"herdr-app", version}`, no `terminal`). `seq` rose by one per
  event, and a heartbeat repeats the last `seq`.
- The app writes labels of its own on terminals: `where` =
  `"<space name> / <tab name>"` (the folder name and the tab number while
  unnamed, updated on rename), and `herdr.seen=<turn>` when the window shows
  the agent.
- **What an open subscription does across `hc server restart` was NOT
  measured.** The restart was blocked in this session, because it acts on the
  whole core, including the operator's own working agent (documented as safe:
  "programs keep running, the next core adopts them"). See "Needs the
  operator".

## Step 5b — the `herdr-app` layout document

`doc.get {name:"herdr-app"}` → `{version, value}`. After making a second
space (a terminal with labels `herdr.space=probe2 herdr.tab=probe2`) and a
split (a second terminal with the probe's own space/tab labels — the app
added it beside the first pane), the value was, with ids shortened:

```json
{"spaces":[
  {"id":"sp…","name":"","folder":"<path>","tabs":[ … ]},
  {"id":"probe","name":"","folder":"<path>","tabs":[
    {"id":"probe","name":"","root":{"id":"probe","type":"row","children":[
      {"id":"p…","type":"block","content":{"terminal":"t9"},"size":{"weight":0.5}},
      {"id":"p…","type":"block","content":{"terminal":"t10"},"size":{"weight":0.5}}
    ]}}]},
  {"id":"probe2","name":"","folder":"<path>","tabs":[
    {"id":"probe2","name":"","root":{"id":"probe2","type":"row","children":[
      {"id":"p…","type":"block","content":{"terminal":"t11"}}]}}]}
]}
```

- Space order is the array order. Tab order is the `tabs` array order.
- Names are `""` while unnamed. The app then shows a derived name: a space is
  named after its folder, a tab by its number. paddock has to derive the same
  way, or read the `where` label.
- **The space and tab ids ARE the label values.** A terminal started with
  `herdr.space=probe` made a space whose `id` is `probe`, and the tab root's
  `id` equals the tab id.
- A tab's layout is a tree: `row` nodes with `children`, leaves of
  `type:"block"` with `content.terminal` (an address) and an optional
  `size.weight`. A `column` (split down) node was not produced, because only
  the app's `pane.split` makes one and that would have moved the operator's
  window focus. Assume nesting.
- The version rose on every change (17 → 23 over the probe), and each change
  arrived as a `doc` event first.
- Killing the last terminal of a tab removed the tab and its space from the
  document (the version went up, and only the operator's space was left).

## Step 5c — the app socket

`herdr-app do <command>` is a thin client. Seen with `strace`, it connects
to the app's socket in its home directory (`$HERDR_APP_HOME`, by default
`~/.config/herdr-app/herdr-app.sock`) and sends **one newline-terminated
JSON line**:

```
→ {"do":"space.rename","args":{"id":"probe2","name":"probe-renamed"}}
← {"ok":true}
```

| Request | Reply |
|---|---|
| `space.rename {id, name}` (known id) | `{"ok":true}`, then the doc and the `where` label update |
| `tab.rename {id, name}` (known id) | `{"ok":true}` |
| `space.rename` with an unknown id | `{"error":"no space \"no-such-space\""}` |
| unknown command | `{"error":"unknown command \"…\": see \`herdr-app commands\`; …"}` |
| not JSON | `{"error":"bad request: expected ident at line 1 column 2"}` |
| two request lines on one connection | only the first is answered; the connection then closes |

So there is **one request per connection**, the reply is `{"ok":true}` or
`{"error":"<text>"}` (no codes, no `kind`), and the rename takes effect
immediately.

With the window **open**, every request was answered. With the window
**closed**, the behavior was not measured. On Linux this may not be a state
that exists: `herdr-app commands` describes `window.close` as "Close the
window (on Linux, quits)". See below.

## Needs the operator

These need the operator at the machine, because they change something that
is not the probe's:

1. **The app socket with the window closed and the process alive.** This is
   only possible on macOS, where `app.hide` / closing the window keeps the
   process. On Linux, closing the window quits the app (per `herdr-app
   commands`), so the case to measure is **the app not running**. Close the
   Herdr window yourself, then:

   ```sh
   ls -l "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/herdr-app.sock"   # socket still there?
   echo '{"do":"tab.rename","args":{"id":"no-such-tab","name":"x"}}' \
     | socat -t2 - UNIX-CONNECT:"${HERDR_APP_HOME:-$HOME/.config/herdr-app}/herdr-app.sock"
   herdr-app do tab.rename --id no-such-tab --name x; echo "rc=$?"
   ```

   Record whether the socket file is left behind (a stale socket gives
   ECONNREFUSED, a missing one gives ENOENT), what `herdr-app do` prints and
   its exit code, and whether `hc` terminals keep running (they should: the
   core owns them). On macOS, repeat with the window closed but the app in the
   Dock. Then reopen the app.

2. **An open `events.subscribe` connection across `hc server restart`.**
   With a scratch subscriber logging every line and how the connection ends
   (`end`/`close`/`error`), run `hc server restart` and record: whether the
   old connection is closed (and how), how long until the socket accepts
   again, whether `seq` restarts (the README says it does, per core process),
   and whether kept terminals come back as `restarted` or are unchanged in
   the new snapshot. This restarts the core under every live terminal, the
   operator's included, so it is the operator's call when.

3. **A nested split.** Run `herdr-app do pane.split --direction down --pane
   <a probe pane id>` on a probe tab, then `doc.get herdr-app`, to confirm
   the name of the vertical node type (expected `column`).

## What this decides for the plan

- **`sendOptionKey` (Task 8)** → `terminal.keys {terminal, keys:[digit]}`,
  one key per call, digit read off the parsed prompt by label.
  Arrows+`enter` also work, as a fallback.
- **`sendReply` / `sendChars` (Task 8): this is the controller's ruling, not a
  measurement.** When a core agent is BLOCKED, paddock refuses these itself
  and gives the reason ("answer the dialog's options"). Text into a blocked
  dialog is UNMEASURED and must be probed before paddock ever offers it. When
  the agent is not blocked, use `terminal.send {terminal, text}` without
  `force`. `terminal.send` with `force` must never be used to answer a
  dialog: step 4 showed it approves the command whatever digit it pastes.
- **Connection (Task 3)** → one persistent plain connection can carry all
  requests, matched by `id`. Use a separate connection for
  `events.subscribe`, since it turns its connection into a stream.
- **Layout (Tasks 9, 10)** → spaces and tabs in array order, names may be
  `""` (derive them), and ids equal the `herdr.space` / `herdr.tab` labels.
- **Renames (Task 10)** → one JSON line per connection to the app socket:
  `{"do":"space.rename"|"tab.rename","args":{id,name}}` → `{"ok":true}` or
  `{"error":text}`. Its behaviour when the app is down is still open (above).

`tests/core-live.test.ts` asserts the answer path against a live probe (see
its header). On 2026-11-09 it passed 5/5 against the probe used here.

## Step 6 — shell keys (Task 10)

Measured before core shell panes became reachable from the Spaces screen,
because `sendPaneText` types a shell command one `terminal.keys` call per
character and none of those key names had been measured.

On a throwaway, UNLABELLED shell (`hc run --bg --no-parent --no-notify --name
paddock-keyprobe -- sh`, killed and removed afterwards — unlabelled
terminals are invisible to the app, and no other terminal was touched), each
candidate was sent as ONE key in its own `hc keys` call, the screen read
after it, and the character erased with `backspace` before the next. Same
core (0.1.19).

| Key name sent | Result |
|---|---|
| `space` | a space (seen between two letters: `a b`) |
| `backspace` | erases the last character |
| `a`…`z`, `0`…`9` | that character |
| `'` `,` `-` `.` `/` `;` `=` `[` `\` `]` `` ` `` | that character |
| `shift+a`…`shift+z` | the UPPERCASE letter |
| `A`…`Z` | **the lowercase letter** — accepted, and wrong |
| `+` `plus` `!` `"` `#` `$` `%` `&` `(` `)` `*` `:` `<` `>` `?` `@` `^` `_` `{` `\|` `}` `~` | refused: `invalid_params`, `unknown key "+"`; nothing typed |
| `shift+` a digit or one of the punctuation keys above | the UNshifted character (`shift+1` typed `1`), so shift does not reach the symbols |

What this decides: core `sendPaneText` maps a lowercase letter, a digit and
the eleven punctuation keys to themselves, an uppercase letter to
`shift+<letter>`, and a space to `space`. Any other character is refused
before anything is sent (`Unsupported`, naming the characters), because a
bare `A` would silently type `a` and the refused symbols have no measured key
at all. Typing a command that needs `|`, `_`, `:` or `~` into an app shell is
therefore not offered from the phone yet.
