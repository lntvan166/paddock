# MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve an MCP endpoint at `/mcp` so a remote Claude Code session can list paddock's agents, read them, message them, wait for replies and answer their question dialogs, but never answer a permission prompt.

**Architecture:** A new `src/server/mcp/` module holds a hand-written, stateless JSON-RPC handler (no SDK, no SSE) and five tools built on deps paddock already has: the store, the journal reader, `HerdrActions`, and the herdr parsers. Waits listen on a new `AgentWatch` tapped into `deltaSink`. `routes.ts` mounts `POST /mcp` only on the default listener (never when `deps.pairing` is set), behind a per-request settings kill switch. Cloudflare Access does all authentication. This is documented, and verified by hand.

**Tech Stack:** Bun, TypeScript, Hono, `bun:test`.

**Spec:** `docs/design/2026-10-24-mcp-bridge-design.md`

## Global Constraints

- No application auth token. Decision 3 stands. `/mcp` reads no `Authorization` header.
- `/mcp` must never be registered on the gated quick-tunnel app (`createApp` called with `pairing`).
- Kill switch `settings.bridge.enabled` defaults to `false`. While it is off, `POST /mcp` → 404 and one INFO log line per process (not per request).
- Sent text is prefixed `[from remote #<tag>] ` (tag: 6 lowercase base-36 chars, random per message). It is bounded by the exported `MAX_TEXT_LEN` (10 000) **including** the prefix.
- One wait ≤ 90 s (`MAX_WAIT_S = 90`). `never_started` grace is 10 s (`START_GRACE_MS = 10_000`).
- `send_message` is refused in **every** `blocked` state. `answer_question` proceeds only on a screen `parseAskDialog` recognises, re-checked on every read.
- Option matching is by exact label (after `trim()`), never by position. Multi-select is refused in v1.
- Every tool call logs one INFO line: `mcp: <tool> <agentId|-> <outcome> len=<n>`. Never log the text.
- POST bodies only, never query strings. No empty catch blocks.
- Public repo: tests and fixtures use invented names (`api-refactor`, `flaky-test-fix`, `dev-box`). Docs use `paddock.example.com`. Run `make check-clean` before each commit.
- Dependency direction: `src/server/mcp/` may import `herdr/prompt-parse`, `herdr/ask-dialog`, `herdr/dialog-type` and `journal/text`, as `routes.ts` does. Nothing in `state/`, `ws/` or `herdr/` imports `mcp/`.

## Review Focus

1. **The agent finishes before the client calls `wait_for_agent`.** It must return `finished` immediately with the reply, not wait out 90 s. Tested in Task 5 (`wait returns at once when the tagged reply is already in the journal`).
2. **A message queued behind a running task.** The wait must not return the previous task's reply. Tested in Task 5 (`a working→idle edge without the tag in the journal is not finished`).
3. **The dialog is replaced by a permission prompt mid-`answer_question`.** No key may be sent after that read. Tested in Task 6 (`a permission screen on the second read throws before enter`).
4. **The agent disappears during a wait** (removed from the store). The wait should end with a tool error `agent is gone`, not hang to 90 s. Tested in Task 5 (`removal ends the wait`).
5. **The client sends a malformed JSON-RPC body or calls an unknown tool.** It should get a JSON-RPC error, not a 500. Tested in Task 3 (`parse error`, `unknown method`, `unknown tool is isError`).

---

### Task 1: `bridge.enabled` setting

**Files:**
- Modify: `src/server/settings/store.ts` (`Settings`, `defaults`, `migrate`, `view`, `patch`)
- Modify: `src/shared/types.ts` (`SettingsView`, `SettingsPatch`)
- Modify: `docs/settings.md`
- Test: `tests/settings-bridge.test.ts`

**Interfaces:**
- Produces: `Settings["bridge"]: { enabled: boolean }`, `SettingsView["bridge"]: { enabled: boolean }`, `SettingsPatch["bridge"]?: { enabled?: boolean }`. Read by Task 7 as `deps.settings?.current().bridge.enabled`.

- [ ] **Step 1: Write failing tests** in `tests/settings-bridge.test.ts`, modelled on the existing settings store tests:
  - `bridge is off by default`: a fresh store → `current().bridge.enabled === false` and `view().bridge.enabled === false`.
  - `migrate keeps an old file valid`: `migrate({version: 2, …no bridge…}).bridge` → `{ enabled: false }`.
  - `migrate refuses a non-boolean`: `bridge: { enabled: "yes" }` → `false`.
  - `patch turns it on and persists`: `patch({bridge:{enabled:true}})`, then reload the store from the same dir → `true`.
- [ ] **Step 2: Run** `bun test tests/settings-bridge.test.ts`. Expected: FAIL (no `bridge` field).
- [ ] **Step 3: Implement** the field in all five places in `store.ts` plus the two shared types. Keep `version: 2`: the field is additive and `migrate` defaults it. Document the key in `docs/settings.md` with one paragraph, the default, and the curl that toggles it (`curl -X PUT http://127.0.0.1:8787/api/settings -H 'content-type: application/json' -d '{"bridge":{"enabled":true}}'`).
- [ ] **Step 4: Run** `bun test tests/settings-bridge.test.ts && make check`. Expected: PASS, tsc clean. Also run the existing settings tests (`bun test tests/settings`) to catch `toEqual` fixtures that now need `bridge`.
- [ ] **Step 5: Commit** `feat(settings): bridge.enabled, off by default`.

### Task 2: `AgentWatch`, a delta tap for waits

**Files:**
- Create: `src/server/mcp/watch.ts`
- Modify: `src/server/index-wiring.ts` (`deltaSink`)
- Modify: `src/server/index.ts:686` and `:731` (both `deltaSink` calls)
- Test: `tests/mcp-watch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class AgentWatch {
    observe(d: Delta): void;
    /** Resolves with the agent's latest record when `pred` holds for an
     *  upsert of `agentId`, `"gone"` when it is removed, `"timeout"` after
     *  `ms`. Never rejects. Listeners are removed on every exit path. */
    until(agentId: string, pred: (a: Agent) => boolean, ms: number): Promise<Agent | "gone" | "timeout">;
  }
  export function deltaSink(hub, notifier, watch?: { observe(d: Delta): void } | null): (d: Delta) => void;
  ```
  The hub still goes first, then the notifier, then the watch.

- [ ] **Step 1: Write failing tests**:
  - `until resolves on a matching upsert`: `observe({upserted:[agent({state:"idle"})], removedIds:[]})` → resolves to that agent.
  - `non-matching upserts are ignored`.
  - `removal ends the wait` → `"gone"`.
  - `timeout` (use `ms: 20`) → `"timeout"`, and afterwards the internal listener count is 0 (expose `get listeners(): number` for the test).
  - `deltaSink calls the watch after the hub` (record order).
- [ ] **Step 2: Run** `bun test tests/mcp-watch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `AgentWatch` (a `Set` of listeners, each with its own `setTimeout`) and the optional third `deltaSink` argument. In `index.ts`, construct one `AgentWatch` before both wirings, pass it to both `deltaSink` calls, and add it to `appDeps` as `watch`, declaring `watch?: AgentWatch` on `AppDeps` now (Task 7 consumes it).
- [ ] **Step 4: Run** `bun test tests/mcp-watch.test.ts tests/index-wiring*.test.ts && make check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): AgentWatch tap on the delta fan-out`.

### Task 3: JSON-RPC handler

**Files:**
- Create: `src/server/mcp/protocol.ts`
- Test: `tests/mcp-protocol.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolDef {
    name: string; description: string; inputSchema: object;
    call(args: Record<string, unknown>): Promise<ToolResult>;
  }
  export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
  /** One JSON-RPC message in, the response body out, or null for a notification (→ HTTP 202). */
  export async function handleRpc(msg: unknown, tools: readonly ToolDef[]): Promise<object | null>;
  export const SERVER_INFO = { name: "paddock", version: string };
  export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
  ```
- Behaviour, as JSON-RPC 2.0:
  - `initialize`: reply `{protocolVersion, capabilities: {tools: {}}, serverInfo}`. `protocolVersion` echoes the client's version if it is in `PROTOCOL_VERSIONS`, else the first entry.
  - `notifications/*` (no `id`) → `null`.
  - `ping` → `{}`.
  - `tools/list` → `{tools: [{name, description, inputSchema}]}`.
  - `tools/call`: an unknown name, or a tool returning `{ok:false}` → `{content:[{type:"text",text:error}], isError:true}`. `{ok:true}` → `{content:[{type:"text",text:JSON.stringify(data,null,2)}]}`. A thrown error becomes `isError` with its message. Never a 500.
  - An unknown method → error `-32601`. A non-object, or one missing `jsonrpc: "2.0"` → `-32600`. Batches (arrays) → `-32600` (v1 is unbatched).
- [ ] **Step 1: Write failing tests**: `initialize echoes a supported version`, `initialize falls back for an unknown version`, `notification returns null`, `tools/list shape`, `tools/call ok`, `tools/call tool error is isError`, `thrown tool error is isError`, `unknown tool is isError`, `unknown method -32601`, `parse error / invalid request -32600`, `batch refused -32600`.
- [ ] **Step 2: Run** `bun test tests/mcp-protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `handleRpc`. The thrown-tool catch must also `console.warn` the message, because errors are never swallowed.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): stateless JSON-RPC handler`.

### Task 4: Read tools, `list_agents` and `read_agent`

**Files:**
- Create: `src/server/mcp/tools.ts`, `src/server/mcp/blocked.ts`
- Test: `tests/mcp-read-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolResult` (Task 3); `AgentWatch` (Task 2).
- Produces:
  ```ts
  export interface BridgeDeps {
    store: AgentStore; actions: HerdrActions; watch: AgentWatch;
    journal?: JournalReader; sessionFor?: (agentId: string) => HerdrAgentSession | null;
    dialogIo: DialogIo;               // `{ ...actions, settle }`, built in routes.ts
    log?: (line: string) => void;     // defaults to console.info
    newTag?: () => string;            // injected in tests
  }
  export function bridgeTools(deps: BridgeDeps): ToolDef[];
  // blocked.ts
  export interface BlockedInfo { kind: "permission" | "question"; question: string | null; options: string[]; raw: string | null }
  export function describeBlocked(screen: string): BlockedInfo;
  ```
  - `describeBlocked`: `kind` is `"question"` iff `parseAskDialog(screen) !== null`, else `"permission"`. An unrecognised shape is therefore treated as permission, which is the safe side. `question` and `options` (labels) come from the AskDialog, or from `parsePrompt` for permission. When `parsePrompt(...).options === null`, return `options: []` and `raw: stripAnsi(screen)`, otherwise `raw: null`.
  - `list_agents` (no input) → `[{id, name, state, cwd, workspace}]`. `name` uses the same fallback `toAgents` applies; read it off the `Agent` record, never `basename(cwd)` here. `workspace` is `workspaceLabel ?? workspaceId`.
  - `read_agent {id, limit?}` (limit 1–50, default 20) → `{id, state, transcript: string[], source: "journal" | "screen", blocked?: BlockedInfo}`. The transcript is the last `limit` journal lines with ANSI stripped, or the visible screen (`actions.readOutput(id, state)`) when the agent has no journal or the page `source` is `"reconstruction"`. `blocked` is present iff `state === "blocked"`, from `describeBlocked(await actions.readPromptScreen(id))`.
  - An unknown `id`, a bad `limit` → `{ok:false}` with a reason.
- [ ] **Step 1: Write failing tests** using a fake store, actions and journal, in the style of `tests/action-routes.test.ts` `harness()`:
  - `list_agents returns invented agents with their labels`.
  - `read_agent unknown id is an error`.
  - `read_agent prefers the journal and strips ANSI`.
  - `read_agent falls back to the screen without a journal`.
  - `blocked on a permission prompt → kind permission with real labels`, using the screen `"Proceed?\n ❯ 1. Yes\n   2. No\n"`.
  - `blocked on a question dialog → kind question`, reusing a fixture from `tests/ask-dialog.test.ts` / `tests/fixtures`.
  - `an unparseable blocked screen → permission, options [], raw set`.
- [ ] **Step 2: Run** `bun test tests/mcp-read-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `describeBlocked` and the two tools. Each tool's `description` string states the blocked rule plainly. For example `read_agent`: "When state is blocked, blocked.kind says whether it is a permission prompt (only the operator can answer) or a question (answer_question can)."
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): list_agents and read_agent`.

### Task 5: `send_message` and `wait_for_agent`

**Files:**
- Create: `src/server/mcp/reply.ts`
- Modify: `src/server/mcp/tools.ts`
- Modify: `src/server/routes.ts:113` (export `MAX_TEXT_LEN`)
- Test: `tests/mcp-send-wait.test.ts`, `tests/mcp-reply.test.ts`

**Interfaces:**
- Consumes: `BridgeDeps`, `describeBlocked` (Task 4); `AgentWatch.until` (Task 2).
- Produces:
  ```ts
  // reply.ts
  export const REMOTE_PREFIX = (tag: string) => `[from remote #${tag}] `;
  export function newTag(): string;   // 6 chars [0-9a-z]
  /** Lines after the agent's first speaker header that follows the tagged user
   *  line, ANSI stripped. null when the tag is not in `lines` or no agent
   *  header follows it yet. */
  export function replyAfter(lines: readonly string[], tag: string): string[] | null;
  export const AGENT_HEADER_RE = /^agent( · \d{2}:\d{2})?$/;   // matched on stripped lines
  // tools.ts
  export type WaitOutcome =
    | { status: "finished"; reply: string[]; source: "journal" | "screen" }
    | { status: "blocked"; blocked: BlockedInfo }
    | { status: "still_working" }
    | { status: "never_started" };
  ```
- `send_message {id, text, wait_seconds?}`:
  1. Validate: `text` is a non-empty string, `REMOTE_PREFIX(tag).length + text.length <= MAX_TEXT_LEN`; `wait_seconds` is an integer 0–90 (default 0).
  2. Re-read `store.snapshot()` **immediately** before sending. If `blocked`, return `{ok:false}` with `error: "agent is waiting on a prompt; …"` plus `describeBlocked`. If there is no journal and the agent is `working` and `wait_seconds > 0`, refuse ("this agent has no journal, so a reply can't be matched to this message while it is busy; send without waiting, or wait until it is idle").
  3. `actions.sendReply(id, REMOTE_PREFIX(tag) + text)`. A thrown error (including the demo refusal) → `{ok:false, error: detail}`.
  4. Return `{sent: true, cursor: tag, ...(wait_seconds > 0 ? await waitFor(id, tag, wait_seconds, {sentAt}) : {})}`.
- `wait_for_agent {id, cursor, wait_seconds}` (cursor matches `/^[0-9a-z]{6}$/`, wait 1–90) → `WaitOutcome`.
- `waitFor` algorithm, the one non-obvious part:
  ```
  deadline = now + wait_s*1000
  loop:
    a = current agent (gone → error "agent is gone")
    if a.state === "blocked": return blocked(describeBlocked(readPromptScreen))
    if journal available:
      r = replyAfter(page(lines, limit 200), tag)
      if r && a.state !== "working": return finished(r, "journal")
    else (screen fallback, only reachable when the agent was not working at send):
      if seenWorking && a.state !== "working": return finished(screen, "screen")
    if fromSend && !seenWorking && now - sentAt > START_GRACE_MS: return never_started
    next = await watch.until(id, s => s.state !== a.state, min(remaining, 2000))
    "gone" → error; set seenWorking if next.state === "working"; "timeout" → re-check journal (loop)
    remaining <= 0 → still_working
  ```
  The 2 s cap on each `until` lets the journal be re-polled while the state stays `working` → `working` across turns.
- [ ] **Step 1: Write failing tests** in `tests/mcp-reply.test.ts`:
  - `replyAfter finds the reply after the tagged line`, built with the real `toLines([...JournalEntry])` so header-format drift breaks the test.
  - `null before any agent header`.
  - `null for an absent tag`.
  - `only the first agent group after the tag`.
- [ ] **Step 2: Write failing tests** in `tests/mcp-send-wait.test.ts`, with a fake journal whose lines a test can append to, and `AgentWatch` driven by `observe`:
  - `prefix and tag reach sendReply`.
  - `length bound includes the prefix`.
  - `blocked (permission) refuses and sends nothing`.
  - `blocked (question) also refuses send_message`.
  - `state re-read: blocked between list and send refuses`.
  - `wait_seconds 91 refused`.
  - `wait returns at once when the tagged reply is already in the journal`.
  - `a working→idle edge without the tag in the journal is not finished` (the queued-behind case).
  - `finished after working→idle with the tag`.
  - `blocked mid-wait → blocked outcome with kind`.
  - `still_working at the cap` (use a small cap via a test-only `maxWaitMs` dep).
  - `never_started after the grace` (inject `startGraceMs`).
  - `removal ends the wait`.
  - `no-journal agent working + wait refused`.
  - `demo refusal surfaces as isError`, using `demoActions` from `src/server/demo-actions.ts`.
- [ ] **Step 3: Run** both files. Expected: FAIL.
- [ ] **Step 4: Implement** `reply.ts` and the two tools. Add `now?`, `maxWaitMs?` and `startGraceMs?` to `BridgeDeps` for tests, defaulting to `Date.now`, 90 000 and 10 000. Export `MAX_TEXT_LEN` from `routes.ts` and import it. **Verify that `renderMarkdown` leaves `[from remote #abc123]` intact.** Add the assertion `toLines` keeps the literal tag. If it does not, change the prefix brackets in `REMOTE_PREFIX` (and the spec) rather than special-casing the renderer.
- [ ] **Step 5: Run** `bun test tests/mcp-reply.test.ts tests/mcp-send-wait.test.ts && make check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(mcp): send_message and wait_for_agent, anchored by tag`.

### Task 6: `answer_question`

**Files:**
- Create: `src/server/mcp/answer.ts`
- Modify: `src/server/mcp/tools.ts`
- Test: `tests/mcp-answer.test.ts`

**Interfaces:**
- Consumes: `BridgeDeps.dialogIo`, `parseAskDialog`, `selectByCursor`, `typeIntoFreeText` (all existing).
- Produces:
  ```ts
  /** A DialogIo whose every readPromptScreen throws QuestionOnlyError unless
   *  parseAskDialog recognises the screen. */
  export function questionOnlyIo(io: DialogIo): DialogIo;
  export class QuestionOnlyError extends Error {}
  export async function answerQuestion(
    id: string, input: { option?: string; text?: string }, io: DialogIo,
  ): Promise<ToolResult>;
  ```
- Behaviour:
  1. The agent must be `blocked` in the store, else error.
  2. `dialog = parseAskDialog(await io.readPromptScreen(id))`. If null → error "not a question dialog: only the operator can answer this prompt".
  3. `dialog.mode === "multi"` → error "multi-select questions are answered in the paddock UI".
  4. Exactly one of `option` / `text`.
     - `option`: the matches are the non-free-text `dialog.options` with `label.trim() === option.trim()`. 0 or >1 → error listing the real labels. 1 → `selectByCursor(id, match.key, true, questionOnlyIo(io))`.
     - `text`: requires a `freeText` option (else error). Printable chars only, ≤ the `/type` route's `MAX_TYPE_CHARS` (export it). Run `typeIntoFreeText(id, [...text], questionOnlyIo(io))` then `selectByCursor(id, freeRow.key, true, questionOnlyIo(io))`.
  5. A helper `{ok:false}` → tool error with its `detail`. A `QuestionOnlyError` → tool error "the screen stopped being a question dialog; nothing further was sent".
  6. On success, settle, then return `{answered: true, state, next: describeBlocked(screen) | null}`, so the client sees the next question or the Submit tab.
- [ ] **Step 1: Write failing tests** with scripted screens (a fake `readPromptScreen` returning a queue). Reuse question-dialog fixtures from `tests/fixtures` / `tests/dialog-type.test.ts`:
  - `permission screen refused, no keys sent`.
  - `label match sends nav keys then enter`.
  - `unknown label lists the real labels`.
  - `duplicate label refused`.
  - `multi-select refused`.
  - `text without a free-text row refused`.
  - `text types then commits the free-text row`.
  - `a permission screen on the second read throws before enter` (queue: dialog, dialog, permission). Assert `enter` was never sent.
  - `agent not blocked refused`.
- [ ] **Step 2: Run** `bun test tests/mcp-answer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `answer.ts` and register the tool. Its description: "Answer a question the agent asked (AskUserQuestion). Refuses permission prompts — only the operator answers those. Pick an option by its exact label from read_agent."
- [ ] **Step 4: Run** the tests and `make check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): answer_question for question dialogs only`.

### Task 7: Mount `POST /mcp`

**Files:**
- Modify: `src/server/routes.ts` (`AppDeps.watch`, route registration inside the `if (deps.actions)` block)
- Modify: `src/server/demo-actions.ts` only if Task 5's demo test showed a write that does not refuse
- Test: `tests/mcp-route.test.ts`

**Interfaces:**
- Consumes: `handleRpc`, `bridgeTools`, `AgentWatch`, `Settings["bridge"]`.
- Behaviour:
  - Register only when `deps.actions && deps.watch && !deps.pairing`.
  - Per request: `deps.settings?.current().bridge.enabled !== true` → 404 `{ok:false, detail:"the MCP bridge is off"}`, logging once per process.
  - `POST /mcp` with JSON body → `handleRpc`. `null` → 202 with an empty body. Otherwise 200 `application/json`. An unparseable body → 200 with the JSON-RPC `-32700` error (not a 400, so the client sees a protocol error).
  - `GET /mcp` and `DELETE /mcp` → 405 (stateless server: no SSE stream, no sessions).
  - The tools run with `dialogIo: { ...actions, settle }`.
- [ ] **Step 1: Write failing tests**:
  - `404 when the bridge is off`.
  - `initialize then tools/list over HTTP lists five tools`, by name: `list_agents, read_agent, send_message, wait_for_agent, answer_question`.
  - `notification → 202`.
  - `GET → 405`.
  - `not registered on the gated app`: `createApp({...deps, pairing: fakePairing})` → `POST /mcp` 404 even with the bridge on.
  - `not registered without actions`.
  - `no Origin header passes the same-origin guard`.
  - `a request with a foreign Origin is still refused by the guard`.
  - `a tool call logs one INFO line without the text` (inject `log`).
- [ ] **Step 2: Run** `bun test tests/mcp-route.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route.
- [ ] **Step 4: Run the full suite** `make test && make check && make check-clean`. Expected: all pass, scanner clean.
- [ ] **Step 5: Commit** `feat(mcp): serve /mcp on the default listener behind bridge.enabled`.

### Task 8: Docs, decision, and live verification

**Files:**
- Modify: `docs/deploy-cloudflare.md` (new section "MCP bridge: a second Access application")
- Modify: `docs/decisions.md` (decision 34)
- Modify: `docs/architecture.md` (one paragraph placing `src/server/mcp/`)
- Modify: `README.md` (one short "Driving agents from another Claude Code session" section, placeholders only)

- [ ] **Step 1: Write the Cloudflare section.** Cover: create a service token; create an Access application for path `paddock.example.com/mcp` with one *Service Auth* policy; leave the hostname-wide app human-only; register with `claude mcp add --transport http paddock https://paddock.example.com/mcp --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"`. Then the two verification curls with the service-token headers: `POST /mcp` with an `initialize` body → 200 JSON-RPC result, and `POST /api/agents/x/key` → refused by **Access** (a Cloudflare page or 403, never paddock's `unknown agent` 404). Add a note on storing the secret in bifrost with `chezmoi add --encrypt`, phrased generically ("your dotfiles manager's encrypted store").
- [ ] **Step 2: Write decision 34.** The bridge authenticates only through Access path scoping, with no paddock token. Why that does not reopen decision 3. The two refusals (`send_message` while blocked; `answer_question` only on a recognised question dialog). Why it is off by default.
- [ ] **Step 3: Run** `make check-clean`. Expected: clean.
- [ ] **Step 4: Live-verify `answer_question` on a used dialog**, per CLAUDE.md, against a throwaway probe agent as described in `tests/dialog-live.test.ts`'s header. Ask the probe a two-question `AskUserQuestion`. Move the cursor once in the UI, then call `answer_question` for question 1 by label, then question 2 via `text`, then `Submit answers`. Confirm each step from the screen. Then put the probe on a permission prompt and confirm `answer_question` refuses and nothing is typed. Record what was observed in the commit message. If any step misbehaves, stop and fix it in Task 6 before going on.
- [ ] **Step 5: Hand the operator the Access check.** Paddock cannot do this itself: the operator creates the service token and second app, runs the two curls from Step 1, and reports both outcomes. The feature is not called done until the `/api/...` curl is shown to be refused by Access.
- [ ] **Step 6: Commit** `docs: MCP bridge deployment, decision 34`.
