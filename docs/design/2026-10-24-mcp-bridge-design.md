# MCP bridge: a remote Claude Code session talks to paddock's agents

Status: approved design, 2026-10-24.

## Why

The operator sometimes runs a Claude Code session on a laptop while the
agents that can act on a server run there, under herdr, and paddock watches
them. To hand one of those agents work today, the laptop session writes a
handoff file into a shared git repo, the operator tells the server agent to
pull, and then everyone waits on a `STATUS.md` to come back. The two costs
the operator named are **having to nudge the other side to pull** and
**waiting a long time without knowing whether anything is happening**.

Success is: the laptop session sends a message straight into a running agent
and gets its reply when the agent finishes. It can wait for that reply in
place or send and come back later, whichever suits the moment. And it never
gets more power than the operator has, minus the one power the operator
keeps for themselves: answering permission prompts.

## Goals

- An MCP server inside paddock, at `/mcp`, over Streamable HTTP.
- Five tools: list agents, read an agent, send a message (optionally
  waiting), wait for an agent, answer an agent's own question.
- Any running agent can be messaged. There is no per-agent opt-in (the
  operator's choice).
- Permission prompts stay with the operator, and that is **enforced** rather
  than merely left unimplemented.

## Non-goals

- **No `start_agent` / `stop_agent`.** The agents the operator wants to reach
  are already running. Lifecycle stays in the UI.
- **No `service_logs` / `service_health`.** The agent on the other end has a
  shell, so "run `docker compose ps` and tell me" is a message, not a tool.
  Building these would also make paddock know about docker and about another
  project's services. Architecture rule 2 says only `src/server/herdr/` knows
  about anything outside paddock, and only about herdr.
- **No secret retrieval, no arbitrary shell through the bridge itself.**
- **No replacement for the UI.** The bridge is a programmatic door onto
  features paddock already has.

## Anti-goals: failure even if it technically works

- The bridge can answer a permission prompt, whether through a tool, through
  `send_message` typing into a dialog, or because the bridge's credential
  can reach `/api/agents/:id/answer`, `/key`, `/dialog-key` and so on
  directly.
- The operator, reading the agent on their phone, cannot tell a remote
  message from one they typed.
- A wait silently returns "done" when the agent never started, or returns an
  empty reply that looks like success.
- Anything real (hostname, service-token ID, the other project's name) lands
  in this public repo, including in tests and fixtures.

## Auth: Cloudflare Access does all of it

Decision 3 (no application auth token) stands, and **no paddock token is
added**. The operator asked whether a hand-made paddock token was needed. It
was rejected because it would gate only `/mcp`, and the hole is the other
routes (below), which such a token would not close.

**The hole.** Paddock trusts Access and does no authentication of its own. If
a service token is simply added to the existing Access application, a holder
of that token reaches every route, including those that approve prompts.

**The fix, entirely in Cloudflare:**

1. A **second Access application** scoped to the path `paddock.example.com/mcp`,
   with exactly one policy: *Service Auth*, accepting the one service token
   created for the laptop.
2. The existing hostname-wide application keeps its human-only policy.
   Access picks the most specific path match, so a service token hitting
   `/api/...` is evaluated against the human policy and refused.
3. Revoking means deleting or rotating the service token in the dashboard.

**This must be verified, not assumed.** `docs/deploy-cloudflare.md` §3
already has a "verify the gate" step. Extend it with two curls using the
service token: `/mcp` succeeds, and `POST /api/agents/x/key` is refused **by
Access** (an Access error page or 403, never a paddock 404). The design is not
done until both have been observed against a real Access setup.

**Local kill switch.** Add a settings boolean (name left to the builder,
e.g. `bridge.enabled`), **off by default**. While it is off, `/mcp` answers
404 and logs once at INFO. It is a settings toggle, not a secret, and it
replaces the "revocable paddock token" the original proposal wanted.

**Quick tunnels.** `paddock tunnel` / `paddock start` publish a listener with
no Access in front of it (decision 13's cookie gate). `/mcp` must **not** be
served on that listener, only on the default loopback listener that the named
tunnel points at.

Registering on the laptop (documented with placeholders only):

```bash
claude mcp add --transport http paddock https://paddock.example.com/mcp \
  --header "CF-Access-Client-Id: <id>" \
  --header "CF-Access-Client-Secret: <secret>"
```

## Tools

All inputs are validated and bounded the way the existing routes bound them.
Agent ids are checked against `store.snapshot()`. An unknown id is a tool
error, never a guess.

| Tool | Input | Returns |
|---|---|---|
| `list_agents` | none | `[{id, name, state, cwd, workspace}]`, built from the store, labelled exactly as the UI labels them (never `basename(cwd)` alone; see gotchas). |
| `read_agent` | `id`, `limit?` (≤ 50 entries) | state; the last N journal entries as text (the same source as `/api/agents/:id/history`), falling back to the visible screen when the agent has no journal adapter; and **when `state` is `blocked`, the prompt's question and its real option labels** (from `herdr/prompt-parse.ts`, as `/api/agents/:id/prompt` returns them, or the raw screen if parsing fails). |
| `send_message` | `id`, `text` (≤ the existing `MAX_TEXT_LEN`), `wait_seconds?` (0–90) | `{sent: true}`. With `wait_seconds > 0`, also the outcome of a wait (see below). |
| `wait_for_agent` | `id`, `wait_seconds` (1–90) | the outcome of a wait. |

### Sending

- The text is sent through the same action `/api/agents/:id/text` uses
  (`actions.sendReply`), **prefixed with `[from remote #<id>] `**, where
  `<id>` is a short random tag generated per message. Both the agent and the
  operator see it is not the operator, and the tag is how a wait finds this
  message in the journal (below).
- **Refused while the agent is `blocked`.** `/text` deliberately works in
  every state, because it is the operator typing into a terminal they can
  see. For the bridge, typing into a prompt dialog *is* answering it, so a
  blocked agent returns a tool error saying the agent is waiting on the
  operator's approval, with the question attached. A race (the agent becomes
  blocked between the check and the send) is possible. The builder should
  re-check state immediately before sending and document the remaining
  window. It cannot be made zero without herdr support.
- No other state is refused. Sending to a `working` agent queues the message
  the way typing would.

### Answering the agent's own questions (`answer_question`)

`blocked` covers two different screens, and the operator split them
(choice (b)):

- **Permission prompts.** Only the operator answers these. The bridge has no
  path to them.
- **Question dialogs** (the harness's `AskUserQuestion` dialog, recognised by
  `parseAskDialog` in `herdr/ask-dialog.ts`, decision 29). The remote session
  may answer these. It is usually the one that handed out the task the
  question is about.

A fifth tool:

| Tool | Input | Returns |
|---|---|---|
| `answer_question` | `id`, `option` (an option label, verbatim from `read_agent`) **or** `text` (only when the dialog has a free-text row) | `{answered: true}` plus the new screen state, or a tool error. |

Rules:

- **The dialog is re-read and re-classified on the server at call time.**
  The tool proceeds only if `parseAskDialog` recognises the current screen as
  a question dialog. Anything else is refused: a permission prompt, an
  unrecognised shape, or a screen that changed since `read_agent`. This is
  the one check that keeps (b) from turning into "the bridge can approve
  prompts", so it must never be loosened to "blocked and not obviously a
  permission prompt".
- **Options are matched by label, never by position.** A label that matches
  no option, or matches more than one, is refused. The server picks the key.
  The client never sends a keystroke ("never guess a keystroke").
- **Drive the dialog with the existing helpers** in `herdr/dialog-type.ts`
  (`toggleDialogOption`, which is what `/dialog-key` uses, and `typeIntoFreeText`; `selectByCursor` cannot see these options, because `parsePrompt` refuses the dialog) rather than new key
  sequences. Those helpers carry the eleven used-screen fixes. Multi-question
  dialogs are answered one question per call, the current tab first.
  Multi-select is **refused in v1** with a message pointing at the UI. The
  call is YAGNI until a real multi-select question needs answering remotely.
- **Every screen read inside the helpers is re-classified.** A digit or an
  Enter answers a *permission* prompt as readily as a question, and the
  helpers read the screen themselves. So the
  helpers get a wrapped `DialogIo` whose `readPromptScreen` throws unless
  `parseAskDialog` recognises the screen. A prompt that replaces the dialog
  mid-call then stops the call before any further key is sent.
- `read_agent` and the `blocked` wait outcome say **which kind** of blocked
  screen it is (`permission` or `question`), so the client knows whether
  `answer_question` is even possible.
- `send_message` stays refused for **every** blocked state, questions
  included. Answering goes only through `answer_question`.
- The answer is logged at INFO (tool, agent, matched option label, or the
  text length for free text).

### Waiting

Cloudflare closes a proxied response that is silent for ~100 s (error 524),
so **one wait is capped at 90 s**. A longer wait is the client calling
`wait_for_agent` again. This was my call, made because of that limit. The
operator's requirement was only that both "wait now" and "come back later"
work.

**A wait is anchored to the message, not to the clock** (my call, settling
two gaps the builder check found). `send_message` returns a `cursor`, an
opaque marker that is the message's `#<id>` tag.
`wait_for_agent` takes that cursor. Without anchoring, a client that comes
back after the agent has already finished would wait 90 s on an idle agent
and lose the reply. And a message queued behind a running task would
"finish" when the *previous* task ended.

- **Finished** means the journal holds this message's `[from remote]` user
  entry, followed by the agent's reply, and the agent is now not `working`.
  If that is already true when `wait_for_agent` is called, it returns
  immediately.
- **No journal adapter for this agent.** A wait is then refused while the
  agent is `working` at send time, because there is no way to tell this
  message's turn from the current one. Otherwise it falls back to the state
  edge (`working` → not working) plus the visible screen, and says in the
  result that it did.

A wait returns one of:

- `finished`: as defined above. Includes the journal entries after the
  cursor, falling back to the screen.
- `blocked`: the agent is on a prompt. Includes `kind` (`permission` or
  `question`), the question and its options. For `permission`, it also says
  plainly that only the operator can answer. For `question`, it says that
  `answer_question` can.
- `still_working`: the cap was hit. Includes nothing else, so the client
  knows to call again.
- `never_started`: after `send_message`, the agent was not seen `working`
  within a short grace period (builder's choice, around 10 s). This is
  distinct from `finished` on purpose (see anti-goals).

The wait is driven by state changes, not by polling herdr. `AgentStore` has
no subscription mechanism of its own: changes leave through the `onDelta`
callback that `index-wiring.ts` (`deltaSink(hub, notifier)`) and the demo
wiring in `index.ts` pass in. The bridge adds a tap at that fan-out, in both
wirings. The journal check can poll the journal reader cheaply while a wait
is open.

## Logging

Every tool call logs one INFO line: tool, agent id, outcome, and text length
(never the text itself). This is the audit trail. Access already logs who
connected. A rate limit is not built: the only client is the operator's own
session, and Access fronts it.

## Architecture placement

- The MCP handler lives in a new server module (e.g. `src/server/mcp/`) and
  is mounted from `routes.ts` when `deps.actions` exists. The kill switch is
  checked **per request** against the settings store, so toggling it through
  `PUT /api/settings` (`{"bridge":{"enabled":true}}`, e.g. curl on the box)
  takes effect without a restart (my call). The store is in memory, so a hand
  edit of `settings.json` needs a restart. There is no UI control in v1.
  The module depends on the store, the journal reader, `HerdrActions` and
  `herdr/prompt-parse.ts` (the server-side parser `/api/agents/:id/prompt`
  uses). That import matches what `routes.ts` already does.
  `MAX_TEXT_LEN` (10 000, currently private to `routes.ts`) is exported
  rather than redeclared.
- `--demo`: `/mcp` is either absent or backed by `demo-actions.ts`, whose
  writes already refuse. If the bridge is served in demo mode, `send_message`
  must return that refusal, never a silent success.
- Whether to use `@modelcontextprotocol/sdk` or a minimal hand-written
  stateless JSON-RPC handler is the builder's call. Constraints: it must work
  in the compiled Bun binary; responses can be plain JSON (no SSE needed,
  given the 90 s cap); and any new dependency should be justified in the
  plan.

## Acceptance checks

1. From the laptop: `list_agents` shows a running agent. `send_message(id,
   "report docker compose ps", wait_seconds=90)` returns `finished` with the
   answer, or `still_working`, after which `wait_for_agent` returns it.
2. A message that makes the agent hit a permission prompt returns `blocked`
   with the question. The agent does not proceed until the operator answers
   in the UI. `send_message` to it is refused while it is blocked.
3. The service token cannot reach any non-`/mcp` route (verified with curl
   against real Access, step above).
4. With the kill switch off, `/mcp` is 404. `/mcp` is never served on the
   quick-tunnel listener.
5. `answer_question` answers a real question dialog by label. It is
   verified on a *used* dialog (second question, cursor already moved, text
   already typed), against a throwaway probe agent as in
   `tests/dialog-live.test.ts`. The same call against a permission prompt is
   refused.
6. Tests cover: the `[from remote]` prefix, the blocked refusal, every wait
   outcome including `never_started`, the 90 s bound, cursor-anchored waits
   (already finished; queued behind a running task), `answer_question`'s
   classification refusal and label matching, and demo refusal. All fixtures
   use invented agent names.

## Left to the builder

The settings key name, module layout, MCP library choice, the grace period
value, journal-vs-screen fallback details, and the wording of tool
descriptions (which Claude reads, so they should state the blocked rule
plainly).
