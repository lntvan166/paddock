# Answering a multi-question dialog from the phone

**Status:** BUILT, 2026-08-28. Plan:
`docs/superpowers/plans/2026-08-28-question-dialog.md`.
**Date:** 2026-08-28.

## The problem

An agent asks a structured question and paddock renders none of it.

Claude Code's `AskUserQuestion` puts up a dialog with a tab bar of questions,
options carrying checkboxes, a free-text row, and a Submit step. Reported from a
phone against a real one of these: no option buttons appeared, the only control
was `⏎ Enter selects · 5. [] Type something`, and choosing the free-text option
and typing a reply **did nothing at all**.

Both halves of that are explained by the code.

**No buttons**, because every option in this dialog is followed by a description
line, and a non-option line ENDS the option run in `prompt-parse.ts`. Each
option becomes a run of one, every run fails the "fewer than two options" guard,
and the parser correctly refuses. Run against the real screen, it returns
`question: null, options: null, selected: "1. [ ] Broccoli"` — which is exactly
what was on the phone.

**No typing**, because paddock has no way to type into an agent at all.
`NAV_KEYS` is a closed nine-key allowlist of navigation, and `sendReply` is
`agent.prompt`, whose own generated doc comment reads "the call that SUBMITS a
reply, not one that types". Sending the operator's text as a reply while a menu
holds the keyboard is why it vanished.

## Measured behaviour

Everything below was measured on a throwaway `claude` agent in a scratch
directory (`herdr tab create` + `herdr agent start`), driven one key at a time
with `herdr agent send-keys` and read back with `herdr agent read` between every
key. It is recorded here because most of it is not guessable, and three of the
findings contradict the obvious assumption.

### A multi-select question — options carry `[ ]` / `[✔]`

| Key | Effect |
|---|---|
| digit `N` | **Toggles** option N. The cursor does not move. Nothing is submitted. |
| `space` | Toggles the option under the cursor. |
| `enter` | Toggles the option under the cursor. **Does not advance.** |
| letters, with the cursor on the free-text row | Types into it, and **ticks its checkbox automatically**. `[ ] Type something` became `[✔] okra`. |
| `space`, with the cursor on the free-text row | Inserts a space. It does **not** toggle. |
| `enter`, on a filled free-text row | Toggles the checkbox off. The text survives. |
| `down`, from the last option | Moves to `Next` (or `Submit`), which is unnumbered and indented below the options. |
| `enter`, on `Next` | Advances to the next question. |

The same key means different things depending on which row the cursor is on.
That is the whole reason paddock has to know where the cursor is before it sends
anything.

### A single-select question — no checkboxes; the pick gets a trailing `✔`

| Key | Effect |
|---|---|
| digit `N` | Picks option N **and advances immediately** to the review tab. |
| letters, cursor on the free-text row | **Ignored.** The row is not live here. |
| `enter`, on an EMPTY free-text row | **Declines the entire dialog** and closes it. The transcript records `User declined to answer questions`. |

The last row is the reason this design refuses to render a button for the
free-text option in single-select mode. A control that silently abandons every
answer the operator already gave is the "mislabelled Approve button" this
project bans, in its worst form.

### The tab bar — `←  ☐ Colours  ☒ Fruit  ✔ Submit  →`

- `left` / `right` move between questions, and onto Submit.
- `☐` is unanswered, `☒` answered, `✔ Submit` is the final tab.
- **The current tab is marked only by an ANSI background colour** — the current
  segment is wrapped in an SGR that sets a background (measured:
  `48;2;177;185;249`, paddock's own accent lavender, with black text), and no
  other segment carries one. There is no plain-text marker of any kind.
- **The `detection` source strips escapes unconditionally.** Measured: a
  detection read of a live dialog contains ZERO escape sequences even with
  `--ansi`, while the same screen read from `visible` has 37 lines carrying them.
  So the current tab is unavailable on the read `/prompt` uses today, and no
  `strip_ansi` flag can recover it — the SOURCE has to change, not the flag.
- Submit is a review screen plus `1. Submit answers` / `2. Cancel`. Only `enter`
  committed it; the bare digit `1` did nothing there, unlike every other
  single-select screen measured. The review screen's two options DO parse under
  the existing parser, which is why submitting already worked by hand.

### The capability that was missing

`agent.send_keys` accepts arbitrary literal characters. `t`, `e`, `a`, `l` sent
as four keys typed `teal` into a row. Nothing in paddock uses this: the
allowlist stops at navigation, deliberately, and that decision predates any
prompt with a text row in it.

Two further measurements bound how text must be sent:

- **One character per key.** `send-keys "chào"` is refused —
  `invalid_key: unsupported key chào`. A key is a single character or a named
  key, so text is sent as an ARRAY of single characters, never as a word.
- **Non-ASCII works.** `à`, `ế` and `日` each sent as one key each typed
  correctly. This matters specifically: the operator writes Vietnamese, and an
  ASCII-only route would have shipped a text field that silently dropped half of
  what was typed into it. Splitting is by CODE POINT (`Array.from`), not by byte
  or by UTF-16 unit, so a precomposed `ế` stays one key and an astral-plane
  character is not cut in half.

## What this is not

- **Not a general key-send endpoint.** `NAV_KEYS` stays closed. Characters get
  their own bounded route with its own validation, not a hole in the allowlist.
- **Not a replacement for `prompt-parse.ts`.** That parser stays exactly as it
  is and remains the fallback for permission prompts, other harnesses, and every
  shape the new parser refuses.
- **Not harness-agnostic.** This dialog is Claude Code's. The parser lives in
  `src/server/herdr/` with everything else that knows what an agent's screen
  looks like, and refuses anything it does not fully recognise.
- **Not a rewrite of the keypad.** The arrows already exist and already work.

## Design

### 1. `src/server/herdr/ask-dialog.ts` — parse the dialog, or refuse

A new module beside `prompt-parse.ts`, not inside it. The two have different
jobs: the existing parser extracts what it can from an unknown screen; this one
recognises one specific dialog completely or not at all.

```ts
export interface DialogQuestion {
  /** The tab's own label, verbatim: "Colours". */
  label: string;
  /** `☒` — this question has an answer. */
  answered: boolean;
  /** Highlighted in the tab bar. Requires a colour-preserving read. */
  current: boolean;
}

export interface DialogOption {
  /** The digit to send. The agent's own, never derived. */
  key: string;
  /** The label as rendered, checkbox marker already removed. */
  label: string;
  /** Present only in multi-select: `[✔]` vs `[ ]`. */
  checked?: boolean;
  /** Single-select's trailing `✔`. */
  picked?: boolean;
  /** The free-text row. Positional — see below. */
  freeText: boolean;
  /** The description line under the option, when there is one. */
  detail?: string;
}

export interface AskDialog {
  questions: DialogQuestion[];
  question: string;
  mode: "multi" | "single";
  options: DialogOption[];
  /** The label on the unnumbered row below the options. */
  advance: "Next" | "Submit" | null;
  /** Which option the `❯` sits on, or "advance" when it is on that row. */
  cursor: { kind: "option"; key: string } | { kind: "advance" } | null;
}

export function parseAskDialog(raw: string): AskDialog | null;
```

**Identifying the free-text row takes two signals, because neither alone
survives.** The obvious rule — the label reads `Type something` — holds only
until the operator types, after which the label IS the text (`teal blue`) and is
indistinguishable from a real option. The other obvious rule — it is the last
numbered option — cannot stand alone either, because being wrong means rendering
a text field over a real option.

So: the candidate is the last option in the run, and it is accepted as free-text
only when EITHER its label still matches `Type something` (optionally with a full
stop — measured, single-select spells it with one and multi-select without) OR it
carries **no description line** while every other option does. Every real option
in an `AskUserQuestion` has a description, because the tool requires one; the
free-text row never has one. That was true in all three dialogs measured.

An earlier draft anchored this on the `Next`/`Submit` row instead. That is wrong,
and checking the captures is what caught it: **a single-select question has no
advance row at all**, because picking an option advances on its own. Anchoring
there would have failed to identify the free-text row in exactly the mode where
misidentifying it is most expensive — a digit sent to that row in single-select
declines the whole dialog.

**Refusal is the default.** No tab bar line, no question, fewer than two numbered
options, mixed checkbox presence within one question, or a run whose numbering is
not contiguous from 1 → `null`, and the UI falls back to what it does today.
`null` is an outcome, not an error, exactly as in `prompt-parse.ts`.

**`6. Chat about this`** sits below a horizontal rule, outside the option run,
and is deliberately NOT modelled as an option. It is an escape into free prose,
which paddock already has a control for — the reply box.

### 2. The read changes source, not flag

`/api/agents/:id/prompt` calls `readDetection`, which reads
`source: "detection", strip_ansi: true`. Both halves of that are wrong for this
feature, and only one of them is fixable with a flag: measured, the `detection`
source carries no escapes at all, so the current tab cannot be recovered from it
under any setting.

So `/prompt` reads `source: "visible", strip_ansi: false` — one read, handed to
BOTH parsers. This is safe rather than novel: `parsePrompt` strips ANSI
internally, and its own comment records that `/key` already re-reads the live
screen with colour kept and feeds it the result. The visible+colour read is
therefore an existing, exercised path for the old parser, and it is the only path
that carries what the new one needs.

The stale comment on `readDetection` — "deliberately keeps stripping, because its
consumer is the prompt PARSER, and escapes there would break the option matching"
— predates `parsePrompt` doing its own stripping and must be corrected rather
than left to mislead the next reader.

**Detecting the current tab is by the PRESENCE of a background, not by its
value.** Matching `48;2;177;185;249` exactly would break the moment the harness
is themed; matching "this segment sets a background and the others do not" is the
actual invariant on screen.

### 3. Sending: three paths, every keystroke measured

| Intent | What is sent | Why it is safe |
|---|---|---|
| Toggle an option (multi) | The option's digit | Measured: toggles exactly that option, moves nothing, submits nothing |
| Pick an option (single) | The option's digit | Measured: picks and advances, which is what the operator asked for by tapping it |
| Change question | `left` / `right` | Already in `NAV_KEYS`, already works |
| Fill the free-text row | `down`/`up` to reach it, **then** literal characters | The cursor position is re-read from the screen between the move and the type — never counted blind |
| Advance / submit | `enter` on `Next`/`Submit` | Measured |

**A new route, `POST /api/agents/:id/type`,** carrying `{ text }` and sending it
as one key per CODE POINT through `agent.send_keys` — `Array.from(text)`, because
a word is refused as a key and a byte split would corrupt anything non-Latin.
Bounded like every other client-supplied string that reaches herdr: non-empty,
length-capped, and control characters rejected — but NOT restricted to ASCII,
which is measured to work and is what the operator actually types. `NAV_KEYS` is
untouched: a character is not a key name, and folding them together would turn a
closed allowlist into an open one.

**The cursor is verified, not assumed.** To fill the text row the route reads the
screen, computes the distance from the cursor to the free-text row, sends that
many `down` keys, reads again, and only types if the cursor is now where it
expected. If it is not, it stops and says so. Counting keystrokes against a
stale screen is how an off-by-one becomes a wrong answer to a real question.

### 4. The phone UI

In `AgentTerminal`, above the existing controls, rendered only when
`parseAskDialog` returned something:

- **A question strip**, only when there is more than one question:
  `Colours ☒ · Fruit · Submit`, with the current one marked and `◀ ▶` at the
  ends sending one arrow press each. See "the question strip" below for why the
  labels themselves are not tappable in this pass.
- **Option buttons**, carrying the agent's own labels verbatim, with the
  description line as secondary text. State is truthful and comes from the
  screen: `aria-pressed` for a multi-select checkbox, radio semantics for a
  single-select pick.
- **The free-text option renders as a text field**, not a button — with a
  send action that runs the move-verify-type sequence. In **single-select mode it
  is not rendered at all**, and the reason is stated in the UI: Enter on an empty
  text row there declines every answer. The operator still has the arrows and the
  raw screen, which is the honest floor.
- **One primary action**: `Next` or `Submit`, whichever the screen says.
- **When the parser refuses:** exactly today's fallback — raw output, the keypad,
  and the `⏎ Enter selects` row.

The compact keypad gains nothing. `←`/`→` stay out of it: with a question strip
the operator taps a question rather than arrowing to it, and the pad's three keys
are its whole reason for existing.

## Failure handling

- **Parse refuses** → today's behaviour. No degradation, no error.
- **Cursor verification fails** → the action stops, nothing is typed, and the
  operator is told which control did not land. A keystroke that did not land must
  never look like one that did.
- **A key is rejected by herdr** → surfaced as the existing key path already
  surfaces it.
- **The dialog closes under the operator** (the agent gave up, or someone
  answered at the machine) → the next poll returns a screen that does not parse,
  the controls disappear, and the fallback returns. No stale button survives,
  because nothing is cached: the dialog is derived from the current screen on
  every read.

## Testing

- **The parser, against captured real screens** — the three shapes measured
  above, byte for byte, including the ANSI-coloured tab bar. Plus the refusals:
  a permission prompt, a plain numbered list in ordinary output, a dialog with
  its `Submit` row missing.
- **The positional free-text rule**, specifically against a dialog whose text
  row has already been typed into, since that is where a label-based rule breaks.
- **The `/type` route**: validation boundaries, and that it refuses rather than
  types when the cursor is not where it expected.
- **The single-select refusal**: no free-text control is rendered, asserted
  directly, because the cost of regressing it is a declined dialog.
- **The UI**, against a parsed dialog: state is read from the screen and not from
  local state, and the fallback returns intact when the parse goes null.

## The question strip: display first, tapping second

Tapping `Fruit` means "get me to that tab", which paddock can only deliver as
some number of `left`/`right` presses with a verify between each — more
machinery than any other control here, for a movement the arrow keys already
make in one tap each.

**Decided: the strip ships as display plus `◀ ▶`.** It shows the questions, their
`☒` marks and which one is current, and its two ends send a single arrow press.
Tapping a question by name is deferred until the strip has been used on a phone,
because the multi-press sequence is the riskiest part of the whole design and the
display half delivers most of the value — knowing where you are was the thing
the raw screen never told you at a glance.
