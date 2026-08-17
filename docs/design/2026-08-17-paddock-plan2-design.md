# paddock Plan 2 — reading output and the approve path

**Status:** approved design, not yet implemented
**Date:** 2026-08-17
**Builds on:** `docs/design/2026-08-17-paddock-design.md` (v1, shipped)

v1 answers "which agent needs me?" from a phone. It is read-only: you can see that
an agent is blocked, and nothing more. Plan 2 closes the loop — read a pane's
recent output, and answer a blocked agent without opening a terminal.

---

## 1. Scope

### In scope

- An agent detail view: bottom sheet below 640px, side panel above (v1 §6)
- Read a pane's recent output on demand, bounded by a line count
- Answer a blocked agent by tapping one of its **real** prompt options
- A free-text reply when the prompt cannot be parsed
- Acknowledge a `done` agent so it stops occupying **Needs you**

### Not in scope

- **Web Push.** Stays on the roadmap. Without it you must open the dashboard
  yourself to notice a blocked agent. Adding it pulls in VAPID keys, a service
  worker, a subscription store, and — because iOS only delivers push to a PWA
  added to the Home Screen — makes the missing PWA icons load-bearing rather
  than cosmetic. That is its own plan.
- **Multi-host**, arbitrary command entry, a web terminal. Unchanged from v1 §1.

---

## 2. What the probe established

v1 §14 question 1 was the design's largest unvalidated assumption: does the
`detection` snapshot actually contain a parseable option list? It has now been
probed against a real Claude Code permission prompt, in a throwaway agent started
in `/tmp` and destroyed afterwards.

**It is parseable.** The captured prompt, structurally:

```
 Bash command

   <the command>
   <one-line description>

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to tmp/ from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

| Question | Answer |
|---|---|
| Does a source contain the option list as text? | Yes — `detection` and `visible` |
| Numbered, or purely positional? | **Numbered** `1. 2. 3.`, with `❯` marking the current selection |
| Is the question separable from surrounding output? | Yes — `Do you want to proceed?` is its own line |
| Does answering by key actually work? | Yes — `agent.send_keys` with the digit selected the option and the command ran |

Three consequences shape this design.

**Option labels are dynamic and context-specific.** Option 2 was "Yes, and always
allow access to tmp/ from this project" — a *persistent policy change*, not an
approval. A generic "Approve" button would be genuinely ambiguous between "yes
once" and "yes forever". This is the strongest possible vindication of v1 §5's
never-guess rule, and it is why paddock renders the agent's exact label.

**`recent` and `recent_unwrapped` fail outright while an agent is blocked.**
herdr returns `agent_not_idle`: *"its alternate-screen history can only be
captured by scrolling while idle... use --source visible"*. The approve path is
safe because v1 §5 already specifies `detection` — but the *other* feature in
this plan, reading recent output, would error on exactly the agents you most want
to read. Source selection must therefore depend on agent state (§5).

**A blocked agent renders on the alternate screen.** This is why the scrollback
sources are empty rather than merely stale, and it means output history for a
blocked agent is genuinely unavailable, not just awkward to reach.

---

## 3. Architecture

No new layers. Plan 2 extends v1's strict direction —
`herdr/socket → herdr/adapter → state/store → ws/hub → web/` — and adds nothing
that inverts it.

| File | Responsibility |
|---|---|
| `server/herdr/actions.ts` | **New.** The only caller of `agent.read`, `agent.prompt`, `agent.send_keys`, `agent.wait`. herdr vocabulary stops here, as it already does in `socket.ts` and `adapter.ts`. |
| `server/herdr/prompt-parse.ts` | **New.** Pure function: detection snapshot → `ParsedPrompt`. No I/O, no herdr calls, exhaustively testable against fixtures. |
| `server/routes.ts` | Four POST routes (§4). |
| `server/state/store.ts` | Holds the acknowledge flag (§6). |
| `shared/types.ts` | `PromptOption`, `ParsedPrompt`, `ActionResult`; `Agent` gains `acknowledgedAt`. |
| `web/components/AgentDetail.tsx` | **New.** The sheet / panel. |
| `web/api.ts` | **New.** Client POST helpers. |

`prompt-parse.ts` is deliberately separate from `actions.ts`. Parsing is the part
most likely to need revision when an agent's TUI changes, and keeping it pure
means that revision is a change to one file with no I/O in it.

---

## 4. Transport: POST endpoints, state over the existing delta path

v1's WebSocket is strictly server → browser; `websocket.message()` is a
documented no-op. Plan 2 keeps it that way.

- **Actions are POST routes.** The response carries the result to the caller.
  Never a GET query string — those land in edge access logs (v1 §12).
- **State changes need no new mechanism.** Answering a blocked agent moves it
  `blocked → working`, which already propagates to every open browser through the
  delta path v1 built and tested. Multi-tab consistency is inherited, not designed.

| Route | Body | Returns |
|---|---|---|
| `POST /api/agents/:id/output` | `{ lines? }` | `{ lines: string[], source }` |
| `POST /api/agents/:id/prompt` | — | `ParsedPrompt` |
| `POST /api/agents/:id/answer` | `{ key }` or `{ text }` | `ActionResult` |
| `POST /api/agents/:id/ack` | — | `ActionResult` |

**Rejected: a `ClientMessage` union over the WebSocket.** It would need
request/response correlation IDs the protocol does not have, and error handling
across a socket that reconnects with backoff is materially harder than an HTTP
status code.

**Rejected: POST returning everything with no delta involvement.** Answering on
your phone would leave a laptop tab showing `blocked` until the next 30s
reconcile — two devices disagreeing about what still needs you.

The design in v1 §4 sketched `output`, `prompt` and `actionResult` as *server
messages*. That is over-built: those are per-request data the caller asked for,
so an HTTP response is the honest shape. The one genuinely shared piece of state
— the agent's status — already has a working broadcast path.

---

## 5. Reading output

Source selection depends on agent state, because of §2:

| Agent state | Source | Why |
|---|---|---|
| `blocked` | `visible` | Scrollback sources return `agent_not_idle`; herdr's own error recommends `visible` |
| anything else | `recent_unwrapped` | Soft wraps joined — the right choice for a transcript |

Bounded by a line count (default 120), fetched when the sheet opens, with an
explicit refresh control. **Never streamed.** v1 §11 item 6 names continuously
streaming several terminals over a ~250 ms mobile link as the one way to make
paddock genuinely slow, and that has not changed.

---

## 6. The approve path

1. Tapping a blocked card opens the detail sheet.
2. `POST /prompt` → `agent.read` with `source: detection` → `prompt-parse`.
3. The UI renders **one button per option, in the agent's order, carrying the
   agent's exact label.** The probe's option 2 appears verbatim, including
   "always allow". paddock does not editorialise, reorder, or summarise.
4. Tapping sends `POST /answer { key }` → `agent.send_keys`.
5. The server confirms with `agent.wait`, bounded by a timeout, and returns
   explicit success or failure.

   **Wait for the agent to leave `blocked` — not for it to reach `working`.**
   v1 §5 step 5 originally said `--until working`, which is wrong for any
   option that declines: tapping "No" sends the agent to `idle`, not `working`,
   so a `working`-only wait would time out and report a false failure on every
   rejection. `AgentWaitParams.until` takes an array, so the correct call is
   `--until working --until idle --until done`. Confirmed during the probe,
   where answering "Yes" settled on `idle` rather than `working` once the
   command finished. **v1 §5 has been corrected to match** — the two specs
   agree; this note records why the change was made.
6. The `blocked → working` transition reaches every other open browser through
   the delta path.

### When parsing fails

`ParsedPrompt.options` is `null` — a **first-class outcome, not an error.** The
UI then shows the raw snapshot plus a free-text box backed by `agent.prompt`.
paddock never synthesises a default action. v1 §5 put it plainly: a mislabelled
Approve button is worse than no button.

### Scope guard

`/answer` is accepted **only while the agent is actually `blocked`**, checked
against the store at request time. There is no general-purpose send endpoint —
`agent.prompt` accepts arbitrary text, so the boundary is enforced at the API
layer rather than trusted to the UI.

If someone answered at the desk first, the agent is no longer blocked and the
reply is refused with an explicit "no longer blocked" result — never typed
blindly into whatever is now on screen.

### Persistent-grant options

Rendered verbatim, with no special treatment: no confirmation step, no styling
that singles them out. Detecting "this option is persistent" would mean matching
label text against a pattern like "always allow" — which is exactly the guessing
the design forbids, and a pattern that misfires either nags on safe options or
stays silent on dangerous ones. The mitigation is honest labels and generous tap
targets, not a heuristic.

---

## 7. Acknowledging a `done` agent

v1 §14 question 4, now settled. herdr derives `done` from idle-plus-*unseen*, and
socket reads do not clear it, so finished agents accumulate in **Needs you** with
no way to clear them from a phone — eroding the triage design the whole UI rests on.

- `POST /ack` sets `acknowledgedAt` in **paddock's own store**.
- `Agent` gains `acknowledgedAt: number | null`, so the flag rides the existing
  delta path and every browser agrees.
- An acknowledged `done` agent leaves **Needs you** and renders as idle.
- The flag clears when the agent leaves `done`, or when its pane closes.
- **Nothing is sent to herdr.** herdr's `done` stays true; paddock stops shouting.

`agent.focus` would clear `done` at the source, and was rejected: it yanks focus
in the desktop herdr UI, which is harmless when you are away and disruptive when
you or anyone else is at the desk.

---

## 8. Error handling

Every action returns explicit success or failure. Consistent with v1's rule that
a silent break must be visible within seconds:

| Situation | Result |
|---|---|
| Parse produced no options | `options: null` + raw text — an outcome, not an error |
| `agent.wait` timed out | `ActionResult { ok: false, detail }` naming the timeout — and waiting on *leaving `blocked`*, so declining an option is a success, not a timeout |
| Agent no longer `blocked` | Refused, with an explicit reason |
| `agent.read` returned `agent_not_idle` | Surfaced, not swallowed — it means the state changed under us |
| herdr unreachable | The existing request timeout applies; the failure reaches the caller |

No empty catch blocks, no unconditional success.

---

## 9. Testing

`prompt-parse.ts` carries the weight, because it is the piece most likely to
break silently when an agent's TUI changes. Its fixtures cover: the real
structure captured in §2; two-, three- and four-option prompts; the `❯` marker on
a non-first option; a snapshot containing no prompt at all; and a snapshot
truncated mid-prompt.

**The committed fixture is sanitised.** The raw capture contains `/tmp` paths and
third-party banner URLs from a live machine. The fixture reproduces the exact
*structure* — numbered options, selection marker, separator rules, the
`Do you want to proceed?` line — with invented content, per the public-repo rule
that fixtures never carry real data. `make check-clean` covers this file like any
other.

The scope guard gets its own test: `/answer` on a non-blocked agent is refused.

---

## 10. Open questions

1. **Does the option list ever exceed what a phone can show?** The probe returned
   three options. An agent offering many, or offering very long labels, may need
   the sheet to scroll rather than truncate — truncating an option label would
   reintroduce exactly the ambiguity §6 exists to prevent.
2. **Should the free-text fallback be reachable even when parsing succeeds?** An
   operator may want to answer "no, and here's what to do instead" rather than
   pick an offered option. Leaning yes — the raw output is already fetched.
