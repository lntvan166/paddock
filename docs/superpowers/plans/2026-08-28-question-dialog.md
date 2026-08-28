# Question Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator answer Claude Code's `AskUserQuestion` dialog from a phone — toggle checkboxes, move between questions, type into the free-text row, and submit.

**Architecture:** A new parser (`src/server/herdr/ask-dialog.ts`) recognises the whole dialog or returns `null`; the prompt route reads the `visible` screen with colour kept and hands the same text to both the old parser and the new one; a new bounded route types literal characters via `agent.send_keys` after verifying the cursor from the screen; a new UI component renders controls whose state comes from the screen, and falls back to today's keypad whenever the parse refuses.

**Tech Stack:** Bun, `bun:test`, Hono, React 19, happy-dom.

**Spec:** `docs/design/2026-08-28-question-dialog-design.md` — read it first. Every keystroke effect asserted in this plan was measured on a live agent and is tabulated there.

## Global Constraints

- **This repository is public.** No real hostnames, home paths, usernames, or employer terms in code, tests, fixtures, comments, or commit messages. `tea`, `coffee`, `vegetables`, `Mango` are invented fixture content and are fine.
- **Run `make check-clean` before every commit.** If it fails, fix the content — never add to the ignore list.
- **Run `make test`, never bare `bun test`** (it builds the UI first). Single files during a task: `bun test tests/<file>` is fine.
- **`src/shared/types.ts` is the one payload contract.** Never redeclare a payload shape on one side.
- **`NAV_KEYS` stays a closed allowlist.** Characters get their own route and their own validation. Do not add a character to `NAV_KEYS`.
- **Dependency direction:** `herdr/socket → herdr/adapter → state/store → ws/hub → web/`. `ask-dialog.ts` imports types from `@shared/types` and nothing from `web/`.
- **Never swallow errors.** No empty catch, no `2>/dev/null`, no unconditional `exit 0`.
- **CSS:** colour tokens on bare `:root` and redefined under `prefers-color-scheme` *and* `[data-theme]`; radii only `--r-sm` / `--r-md` / `--r-full`; font sizes only `--t-*`; touch targets ≥ `2.75rem`; no hover-only affordances.
- **No device detection.** No `isMobile`, no user-agent parsing.
- **Tests must not assert a local time they did not pin themselves** — `tests/journal-text.test.ts` permanently moves this process's clock (see `docs/gotchas.md`). Nothing in this plan renders a time.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` (modify) | `DialogQuestion`, `DialogOption`, `AskDialog`; `ParsedPrompt.dialog` |
| `src/server/herdr/ask-dialog.ts` (create) | Parse one dialog screen, or return `null`. Pure; no I/O |
| `src/server/herdr/dialog-type.ts` (create) | Move the cursor to the free-text row, verify from a re-read, then type |
| `src/server/herdr/actions.ts` (modify) | `readDetection` → `readPromptScreen` (visible + colour); new `sendChars` |
| `src/server/demo-actions.ts` (modify) | `sendChars` refuses like every other write; rename the read |
| `src/server/routes.ts` (modify) | `/prompt` returns `dialog`; new `POST /api/agents/:id/type` |
| `src/web/api.ts` (modify) | `typeIntoDialog(id, text)` |
| `src/web/components/AskDialogView.tsx` (create) | The dialog's controls. Hook-free; state comes from props |
| `src/web/components/AgentTerminal.tsx` (modify) | Render `AskDialogView` when `prompt.dialog` is present |
| `src/web/styles.css` (modify) | `.dialog-*` rules |
| `tests/ask-dialog.test.ts` (create) | The parser, against captured real screens |
| `tests/dialog-type.test.ts` (create) | The move-verify-type sequence, including its refusals |
| `tests/type-route.test.ts` (create) | Route validation and wiring |
| `tests/ask-dialog-ui.test.tsx` (create) | What renders, and that the fallback survives |
| `docs/architecture.md`, `docs/decisions.md`, `docs/gotchas.md` (modify) | Module rows, the decision, the measured keystroke facts |

---

## Verifying against a real dialog

A probe agent named `probe-prompts` already exists in workspace `w1P`, tab "prompt probe", with a scratch `cwd`. Raise a dialog on it with:

```bash
herdr agent prompt probe-prompts "Call AskUserQuestion once with exactly two questions, both multiSelect true, two options each, about tea and coffee. No preamble, no file reads."
until herdr agent get probe-prompts | grep -q '"agent_status":"blocked"'; do sleep 3; done
herdr agent read probe-prompts --source visible --format text        # plain
herdr agent read probe-prompts --source visible --format text --ansi  # with colour
herdr agent send-keys probe-prompts down       # one key at a time
```

Use it to confirm behaviour; never paste its `cwd` into a committed file. When the work is done, close the tab: `herdr tab close w1P:t4`.

---

## Task 1: Dialog types and the parser

**Files:**
- Modify: `src/shared/types.ts` (append after `ParsedPrompt`)
- Create: `src/server/herdr/ask-dialog.ts`
- Test: `tests/ask-dialog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseAskDialog(raw: string): AskDialog | null` from `@server/herdr/ask-dialog`; the types `AskDialog`, `DialogOption`, `DialogQuestion` from `@shared/types`.

- [ ] **Step 1: Add the payload types**

In `src/shared/types.ts`, after the `ParsedPrompt` interface:

```ts
/**
 * One tab in the dialog's tab bar: a question, or the Submit tab that closes it.
 *
 * `isSubmit` rather than a separate field on `AskDialog`, because the bar
 * renders as one strip and the Submit tab is a position in it — the operator
 * arrows onto it exactly as they arrow onto a question.
 */
export interface DialogQuestion {
  /** The tab's label, verbatim: "Colours". */
  label: string;
  /** `☒` in the bar — this question already has an answer. */
  answered: boolean;
  /**
   * Whether this tab is the one on screen.
   *
   * Comes from an ANSI background colour, the only place the screen records it —
   * see the design doc. False for every tab when the read carried no colour.
   */
  current: boolean;
  /** The `✔ Submit` tab, which is a review screen rather than a question. */
  isSubmit: boolean;
}

/** One numbered row of the dialog's option list. */
export interface DialogOption {
  /** The digit to send. The agent's own, never derived. */
  key: string;
  /** The label as rendered, with any checkbox or tick marker removed. */
  label: string;
  /** Multi-select only: `[✔]` vs `[ ]`. Undefined means "not a checkbox list". */
  checked?: boolean;
  /** Single-select only: the trailing `✔` marking the current pick. */
  picked?: boolean;
  /**
   * The free-text row — the one that takes typed characters.
   *
   * Identified by two signals because neither survives alone: the label still
   * reads "Type something", OR it is the last option and the only one with no
   * description. See the design doc; a label-only rule breaks the moment the
   * operator types, because the label then IS the text.
   */
  freeText: boolean;
  /** The description line beneath the option, when it has one. */
  detail?: string;
}

/**
 * Claude Code's `AskUserQuestion` dialog, as read off the screen.
 *
 * Every field is derived from the CURRENT screen on every read — nothing here is
 * cached. When the dialog closes, the next parse returns null and the UI's
 * controls disappear with it, so a stale button cannot survive.
 */
export interface AskDialog {
  /** The tab bar, in order, including the Submit tab. */
  questions: DialogQuestion[];
  /** The question line above the options. */
  question: string;
  /** Whether options are checkboxes (`multi`) or a single pick (`single`). */
  mode: "multi" | "single";
  options: DialogOption[];
  /** The unnumbered row below the options. Null in single-select, which has none. */
  advance: "Next" | "Submit" | null;
  /** Where the agent's `❯` sits. Null when no marker was found. */
  cursor: { kind: "option"; key: string } | { kind: "advance" } | null;
}
```

Then add the field to `ParsedPrompt`, immediately after `selected`:

```ts
  /**
   * The structured dialog, when the screen is one paddock fully recognises.
   *
   * Null is the ordinary case and means "render the existing controls": a
   * permission prompt, another harness, or a dialog shape this parser refuses.
   * It is an OUTCOME, exactly as `options: null` is.
   */
  dialog: AskDialog | null;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/ask-dialog.test.ts`. These screens are real captures, reduced to the dialog region.

```ts
import { expect, test } from "bun:test";
import { parseAskDialog } from "@server/herdr/ask-dialog";

/** Two questions, both multi-select, nothing answered yet. A real capture. */
const TWO_MULTI = [
  "←  ☐ Tea  ☐ Coffee  ✔ Submit  →",
  "",
  "Which teas do you drink?",
  "",
  "❯ 1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "  2. [ ] Black tea",
  "  Strong and malty, takes milk well.",
  "  3. [ ] Type something",
  "     Next",
  "──────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

/** Single-select. Note: NO advance row — picking an option advances by itself. */
const SINGLE = [
  "←  ☒ Colours  ☒ Fruit  ✔ Submit  →",
  "",
  "Which is your single favourite fruit?",
  "",
  "❯ 1. Mango",
  "     Sweet, tropical, and unmistakable.",
  "  2. Apple ✔",
  "     Crisp, reliable, available year-round.",
  "  3. Strawberry",
  "     Bright and tart-sweet, best in season.",
  "  4. Type something.",
  "──────────────────────────────",
  "  5. Chat about this",
].join("\n");

/** After typing: the free-text label IS the text now. A real capture. */
const TYPED = [
  "←  ☐ Vegetables  ✔ Submit  →",
  "",
  "Which vegetables do you like most?",
  "",
  "  1. [ ] Broccoli",
  "  Green, crunchy, good roasted or steamed.",
  "  2. [ ] Carrot",
  "  Sweet and versatile, raw or cooked.",
  "  3. [ ] Spinach",
  "  Leafy and mild, wilts into almost anything.",
  "❯ 4. [✔] okra",
  "     Submit",
  "──────────────────────────────",
  "  5. Chat about this",
].join("\n");

const ESC = String.fromCharCode(27);
/**
 * The tab bar as it really arrives, byte for byte from a `--ansi` read of the
 * `visible` source. The current tab is the ONLY segment wrapped in a
 * background-setting SGR (`48;2;…`); the foreground SGR on `←` is the decoy
 * that a naive "contains 4x" test trips over.
 */
const ANSI_BAR = [
  `${ESC}[0m${ESC}[38;2;153;153;153m← ${ESC}[0m${ESC}[38;2;0;0;0m${ESC}[48;2;177;185;249m ☐ Tea ${ESC}[0m ☐ Coffee  ✔ Submit  →`,
  "",
  "Which teas do you drink?",
  "",
  "❯ 1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "  2. [ ] Black tea",
  "  Strong and malty, takes milk well.",
].join("\n");

test("a two-question multi-select dialog parses whole", () => {
  const d = parseAskDialog(TWO_MULTI);

  expect(d).not.toBeNull();
  expect(d!.question).toBe("Which teas do you drink?");
  expect(d!.mode).toBe("multi");
  expect(d!.advance).toBe("Next");
  expect(d!.cursor).toEqual({ kind: "option", key: "1" });
  expect(d!.questions.map((q) => [q.label, q.answered, q.isSubmit])).toEqual([
    ["Tea", false, false],
    ["Coffee", false, false],
    ["Submit", false, true],
  ]);
  expect(d!.options.map((o) => [o.key, o.label, o.checked, o.freeText])).toEqual([
    ["1", "Green tea", false, false],
    ["2", "Black tea", false, false],
    ["3", "Type something", false, true],
  ]);
  // The description belongs to the option above it, and the free-text row has
  // none — which is half of how it is identified once its label changes.
  expect(d!.options[0]!.detail).toBe("Light and grassy, lower caffeine.");
  expect(d!.options[2]!.detail).toBeUndefined();
});

test("`Chat about this` below the rule is not an option", () => {
  // It is an escape into free prose, which the reply box already covers.
  // Modelling it as an option would put a button on the screen that abandons
  // the question instead of answering it.
  const d = parseAskDialog(TWO_MULTI);
  expect(d!.options.some((o) => o.label.includes("Chat about"))).toBe(false);
});

test("a single-select dialog is recognised as one, ticks and all", () => {
  const d = parseAskDialog(SINGLE);

  expect(d!.mode).toBe("single");
  // No advance row exists in this mode. Anchoring the free-text rule on one
  // would have failed here — the mode where getting it wrong is worst.
  expect(d!.advance).toBeNull();
  expect(d!.options.map((o) => [o.label, o.picked])).toEqual([
    ["Mango", false],
    ["Apple", true],
    ["Strawberry", false],
    ["Type something.", false],
  ]);
  expect(d!.options[3]!.freeText, "spelled with a full stop in this mode").toBe(true);
  expect(d!.options.every((o) => o.checked === undefined)).toBe(true);
  expect(d!.questions[0]!.answered, "☒ means answered").toBe(true);
});

test("the free-text row is still found after the operator has typed into it", () => {
  // THE case a label rule cannot survive: the label now reads `okra`. Falling
  // back to "last option, and the only one with no description" is what keeps
  // the text field a text field instead of turning it into a button.
  const d = parseAskDialog(TYPED);

  expect(d!.options[3]!.label).toBe("okra");
  expect(d!.options[3]!.freeText).toBe(true);
  expect(d!.options[3]!.checked, "typing ticks it automatically").toBe(true);
  expect(d!.options.slice(0, 3).every((o) => !o.freeText)).toBe(true);
  expect(d!.cursor).toEqual({ kind: "option", key: "4" });
});

test("the current tab comes from a background colour, not from a guess", () => {
  const d = parseAskDialog(ANSI_BAR);

  expect(d!.questions.map((q) => q.current)).toEqual([true, false, false]);
});

test("a read with no colour reports no current tab rather than inventing one", () => {
  // The `detection` source strips every escape, so this is what a caller that
  // reads the wrong source gets. Saying "unknown" is honest; picking the first
  // tab would put the marker on the wrong question.
  const d = parseAskDialog(TWO_MULTI);
  expect(d!.questions.every((q) => !q.current)).toBe(true);
});

test("the review screen parses as the two-option prompt it is", () => {
  const review = [
    "←  ☒ Vegetables  ✔ Submit  →",
    "",
    "Review your answers",
    "",
    " ● Which vegetables do you like most?",
    "   → okra",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n");

  const d = parseAskDialog(review);

  // The QUESTION is the last line before the options, not the first line of the
  // screen: "Review your answers" is a heading and the summary sits under it.
  expect(d!.question).toBe("Ready to submit your answers?");
  expect(d!.mode).toBe("single");
  expect(d!.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  expect(d!.options.some((o) => o.freeText), "neither row takes text").toBe(false);
});

test("every shape it does not fully recognise is refused", () => {
  const cases: [string, string][] = [
    ["no tab bar", "Do you want to proceed?\n❯ 1. Yes\n  2. No"],
    ["one option", "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] Only"],
    ["numbering not contiguous from 1", "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 2. [ ] B\n  3. [ ] C"],
    [
      "checkboxes on some rows only",
      "←  ☐ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] B\n  2. Plain",
    ],
    ["an unrecognised tab marker", "←  ▣ A  ✔ Submit  →\n\nQ?\n\n❯ 1. [ ] B\n  2. [ ] C"],
  ];

  for (const [why, screen] of cases) {
    expect(parseAskDialog(screen), why).toBeNull();
  }
});

test("the LAST tab bar on screen wins", () => {
  // A resolved dialog's bar can still be in the scrollback above the live one.
  const stale = [
    "←  ☒ Old  ✔ Submit  →",
    "",
    "An answered question?",
    "",
    "  1. [✔] Chosen",
    "  Description.",
    "  2. [ ] Other",
    "  Description.",
    "",
    TWO_MULTI,
  ].join("\n");

  expect(parseAskDialog(stale)!.question).toBe("Which teas do you drink?");
});
```

- [ ] **Step 2b: Run the tests to verify they fail**

Run: `bun test tests/ask-dialog.test.ts`
Expected: FAIL — `Cannot find module '@server/herdr/ask-dialog'`.

- [ ] **Step 3: Write the parser**

Create `src/server/herdr/ask-dialog.ts`:

```ts
import type { AskDialog, DialogOption, DialogQuestion } from "@shared/types";

/**
 * Claude Code's `AskUserQuestion` dialog, read off one screen.
 *
 * Separate from `prompt-parse.ts` on purpose, and the split is by JOB rather
 * than by shape: that parser extracts what it can from an unknown screen and
 * reports the parts independently, so a cursor is still usable when an option
 * list is not. This one recognises ONE dialog completely or returns null, and
 * null costs nothing — the UI keeps the controls it has today.
 *
 * Every keystroke effect the caller relies on is tabulated in
 * `docs/design/2026-08-28-question-dialog-design.md`, measured on a live agent.
 * Read that before changing anything here: the same key means different things
 * on different rows, so the value of this parser is knowing which row is which.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|./g;

function strip(line: string): string {
  return line.replace(ANSI_RE, "");
}

/** `←  ☐ Tea  ☐ Coffee  ✔ Submit  →` — the whole bar, arrows included. */
const TAB_BAR_RE = /^\s*←\s+(.*?)\s+→\s*$/;
/** One segment of it: a marker then a label. An unknown marker refuses. */
const TAB_SEGMENT_RE = /^([☐☒✔])\s+(\S.*)$/;
/** A numbered option row, cursor optional. */
const OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/;
/** A checkbox prefix on an option's label. `x` is accepted beside `✔`. */
const CHECKBOX_RE = /^\[([ ✔x])\]\s*(.*)$/;
/** Single-select's trailing pick marker. */
const PICKED_RE = /^(.*\S)\s+✔$/;
/** The unnumbered row below the options. */
const ADVANCE_RE = /^\s+(❯)?\s*(Next|Submit)\s*$/;
/** The label a fresh free-text row carries. Single-select adds a full stop. */
const FREE_TEXT_LABEL_RE = /^Type something\.?$/;
/** The rule that closes the option list, above `N. Chat about this`. */
const RULE_RE = /^\s*─{4,}\s*$/;

/**
 * Whether a run of text sets an ANSI BACKGROUND colour.
 *
 * This is how the current tab is found, and it is fiddlier than it looks. A
 * naive `/4[0-7]/` test matches the digits inside a truecolor FOREGROUND —
 * `38;2;44;0;0` contains `44` — so the parameter list has to be walked, with
 * the arguments of an extended colour skipped rather than re-read as codes.
 * Getting this wrong marks every tab as current, which is worse than marking
 * none.
 */
function setsBackground(text: string): boolean {
  for (const m of text.matchAll(/\[([0-9;]*)m/g)) {
    const params = (m[1] ?? "").split(";").map((p) => Number(p) || 0);
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      // 48 = extended background, 40–47 = basic, 100–107 = bright.
      if (p === 48 || (p >= 40 && p <= 47) || (p >= 100 && p <= 107)) return true;
      // An extended FOREGROUND: step over its arguments so its bytes are not
      // mistaken for codes. `38;5;n` has one, `38;2;r;g;b` has three.
      if (p === 38) i += params[i + 1] === 2 ? 4 : 2;
    }
  }
  return false;
}

/**
 * The text of the one tab segment that carries a background, or null.
 *
 * Split on the reset, because that is what closes the highlight on screen.
 */
function currentTabText(rawBar: string): string | null {
  for (const chunk of rawBar.split("[0m")) {
    if (!setsBackground(chunk)) continue;
    const text = strip(chunk).trim();
    if (text !== "") return text;
  }
  return null;
}

function markersOf(label: string): Pick<DialogOption, "label" | "checked" | "picked"> {
  const box = CHECKBOX_RE.exec(label);
  if (box !== null) return { label: box[2]!.trim(), checked: box[1] !== " " };
  const pick = PICKED_RE.exec(label);
  if (pick !== null) return { label: pick[1]!.trim(), picked: true };
  return { label: label.trim(), picked: false };
}

export function parseAskDialog(raw: string): AskDialog | null {
  const rawLines = raw.split("\n");
  const lines = rawLines.map(strip);

  // The LAST bar wins: an already-answered dialog can still be on screen above
  // the live one, and the live one is always further down. Same rule, and the
  // same reason, as the cursor search in `prompt-parse.ts`.
  let barAt = -1;
  for (let i = 0; i < lines.length; i++) if (TAB_BAR_RE.test(lines[i]!)) barAt = i;
  if (barAt === -1) return null;

  const inner = TAB_BAR_RE.exec(lines[barAt]!)![1]!;
  const highlighted = currentTabText(rawLines[barAt]!);
  const questions: DialogQuestion[] = [];
  for (const segment of inner.split(/\s{2,}/)) {
    const m = TAB_SEGMENT_RE.exec(segment.trim());
    // A marker this does not know means a bar this does not understand. Better
    // to refuse the dialog than to render a strip with a tab missing from it.
    if (m === null) return null;
    const label = m[2]!.trim();
    questions.push({
      label,
      answered: m[1] === "☒",
      // `includes`, not equality: the highlighted run carries the marker and
      // the padding spaces around the label as well as the label itself.
      current: highlighted !== null && highlighted.includes(label),
      isSubmit: m[1] === "✔" && label === "Submit",
    });
  }
  if (questions.length < 2) return null;

  // The dialog's body ends at the rule; `N. Chat about this` lives below it and
  // is deliberately not an option.
  let endAt = lines.length;
  for (let i = barAt + 1; i < lines.length; i++) {
    if (RULE_RE.test(lines[i]!)) { endAt = i; break; }
  }

  let question = "";
  const options: DialogOption[] = [];
  let advance: AskDialog["advance"] = null;
  let cursor: AskDialog["cursor"] = null;
  let expected = 1;

  for (const line of lines.slice(barAt + 1, endAt)) {
    if (line.trim() === "") continue;

    const opt = OPTION_RE.exec(line);
    if (opt !== null) {
      // Contiguous from 1, or refuse. A gap means a truncated capture or an
      // accidental match, and a partial list is tappable and wrong.
      if (Number(opt[2]) !== expected) return null;
      expected++;
      options.push({ ...markersOf(opt[3]!), key: opt[2]!, freeText: false });
      if (opt[1] !== undefined) cursor = { kind: "option", key: opt[2]! };
      continue;
    }

    const adv = ADVANCE_RE.exec(line);
    if (adv !== null && options.length > 0) {
      advance = adv[2] as "Next" | "Submit";
      if (adv[1] !== undefined) cursor = { kind: "advance" };
      continue;
    }

    if (options.length === 0) {
      // OVERWRITTEN, not kept: the question is the last line before the
      // options. The review screen opens with a heading and a summary of what
      // was answered, and the actual question sits under both of them.
      question = line.trim();
      continue;
    }

    // Anything else inside the run describes the option above it. Only the
    // first line is kept — one line is orientation, more is a transcript.
    const last = options[options.length - 1]!;
    if (last.detail === undefined) last.detail = line.trim();
  }

  if (options.length < 2 || question === "") return null;

  // Checkboxes are all or nothing. A mixed list is a shape this does not
  // understand, and guessing the mode decides what a digit MEANS.
  const boxed = options.filter((o) => o.checked !== undefined).length;
  if (boxed !== 0 && boxed !== options.length) return null;
  const mode = boxed === options.length ? "multi" : "single";

  const last = options[options.length - 1]!;
  const onlyOneWithoutDetail =
    last.detail === undefined && options.slice(0, -1).every((o) => o.detail !== undefined);
  if (FREE_TEXT_LABEL_RE.test(last.label) || onlyOneWithoutDetail) last.freeText = true;

  return { questions, question, mode, options, advance, cursor };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/ask-dialog.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

```bash
make check && make check-clean
git add src/shared/types.ts src/server/herdr/ask-dialog.ts tests/ask-dialog.test.ts
git commit -m "feat: parse Claude Code's AskUserQuestion dialog, or refuse it"
```

---

## Task 2: Read the visible screen, and return the dialog

**Files:**
- Modify: `src/server/herdr/actions.ts` (the `readDetection` member and its implementation)
- Modify: `src/server/demo-actions.ts` (rename; keep the read answering)
- Modify: `src/server/routes.ts` (`/api/agents/:id/prompt`)
- Modify: `tests/actions.test.ts:194`, `tests/action-routes.test.ts:34,266,384`, `tests/close-routes.test.ts:60`, `tests/demo-actions.test.ts` (the `READS` set)
- Test: `tests/action-routes.test.ts` (new assertion)

**Interfaces:**
- Consumes: `parseAskDialog` from Task 1; `ParsedPrompt.dialog` from Task 1.
- Produces: `HerdrActions.readPromptScreen(target: string): Promise<string>` — replaces `readDetection`. `/api/agents/:id/prompt` now answers `ParsedPrompt & { dialog: AskDialog | null }`.

- [ ] **Step 1: Write the failing test**

In `tests/action-routes.test.ts`, beside the existing `/prompt` tests:

```ts
test("the prompt route carries the parsed dialog alongside the old fields", async () => {
  // The two parsers see the SAME text. `parsePrompt` refuses this screen — every
  // option is followed by a description line, which ends its option run — and
  // that refusal is what put a phone in front of a dialog with no buttons.
  const screen = [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    "❯ 1. [ ] Green tea",
    "  Light and grassy, lower caffeine.",
    "  2. [ ] Type something",
    "     Submit",
  ].join("\n");

  const app = createApp({
    ...base(),
    actions: { ...stubActions(), async readPromptScreen() { return screen; } },
  });

  const body = await (await app.request("/api/agents/w1:p1/prompt", { method: "POST" })).json();

  expect(body.options, "the old parser still refuses, and must keep refusing").toBeNull();
  expect(body.dialog).not.toBeNull();
  expect(body.dialog.question).toBe("Which teas do you drink?");
  expect(body.dialog.mode).toBe("multi");
  expect(body.dialog.options[1].freeText).toBe(true);
});
```

Adapt `base()` / `stubActions()` to whatever helpers that file already uses — read the top of it first and follow the existing pattern rather than inventing one.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/action-routes.test.ts`
Expected: FAIL — `body.dialog` is `undefined`.

- [ ] **Step 3: Rename the read and change its source**

In `src/server/herdr/actions.ts`, in the `HerdrActions` interface, replace the `readDetection` member:

```ts
  /**
   * The screen the prompt parsers read.
   *
   * `visible` with COLOUR KEPT, and both halves of that are load-bearing.
   * Measured: the `detection` source strips every escape unconditionally — a
   * detection read of a live dialog contains zero of them even when colour is
   * asked for — and the current tab of an `AskUserQuestion` dialog is marked
   * ONLY by a background colour. So the source had to change, not the flag.
   *
   * Safe for `parsePrompt`, which strips ANSI itself and is already fed a
   * coloured live screen by the `/key` route.
   */
  readPromptScreen(target: string): Promise<string>;
```

And its implementation, replacing `readDetection`:

```ts
    async readPromptScreen(target) {
      const res = await request<HerdrPaneRead>(socketPath, "agent.read", {
        target, source: "visible", lines: 60, format: "text", strip_ansi: false,
      } satisfies HerdrAgentReadParams);
      return res.read.text;
    },
```

Delete the now-false comment in `readOutput` that says "`readDetection` below deliberately keeps stripping, because its consumer is the prompt PARSER, and escapes there would break the option matching rather than inform it" — `parsePrompt` has done its own stripping since the `/key` route started re-reading the live screen, and leaving that note would send the next reader in the wrong direction.

- [ ] **Step 4: Update the route**

In `src/server/routes.ts`, in `app.post("/api/agents/:id/prompt", …)`:

```ts
      try {
        // ONE read, both parsers. `parsePrompt` keeps its job — it is the
        // fallback for permission prompts, other harnesses, and every shape
        // `parseAskDialog` refuses — and the dialog rides alongside it.
        const screen = await actions.readPromptScreen(agent.agentId);
        return c.json({ ...parsePrompt(screen), dialog: parseAskDialog(screen) });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err) }, 502);
      }
```

Import `parseAskDialog` from `@server/herdr/ask-dialog` at the top.

- [ ] **Step 5: Update every stub and the source assertion**

Rename `readDetection` → `readPromptScreen` in: `src/server/demo-actions.ts`, `tests/action-routes.test.ts` (3 sites), `tests/close-routes.test.ts`, and the `READS` set in `tests/demo-actions.test.ts`. Then replace the source test in `tests/actions.test.ts`:

```ts
test("the prompt read takes the visible screen, with colour kept", async () => {
  // Measured: the `detection` source strips every escape, and the dialog's
  // current tab is marked only by a background colour — so a detection read
  // cannot carry it under any flag. See docs/gotchas.md.
  const { path, seen } = await fakeHerdr(() => paneRead("snapshot", "visible"));

  expect(await createActions(path).readPromptScreen("w1:p1")).toBe("snapshot");
  expect(seen[0].params.source).toBe("visible");
  expect(seen[0].params.strip_ansi).toBe(false);
});
```

- [ ] **Step 6: Verify the demo still shows a parsed prompt**

The demo's blocked agent must keep producing a screen the real parser reads — `tests/demo-actions.test.ts` asserts exactly that. Run:

```bash
bun test tests/demo-actions.test.ts tests/actions.test.ts tests/action-routes.test.ts tests/close-routes.test.ts
```

Expected: PASS. If the demo's detection screen no longer parses, fix the demo screen — do not weaken the assertion.

- [ ] **Step 7: Full suite and commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: the prompt route reads the visible screen and returns the dialog"
```

---

## Task 3: `sendChars`, and a route that types

**Files:**
- Modify: `src/server/herdr/actions.ts` (new `sendChars`)
- Modify: `src/server/demo-actions.ts` (refuse it)
- Modify: `tests/demo-actions.test.ts` (add to `WRITES`)
- Test: `tests/actions.test.ts` (the wire call), `tests/type-route.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 2 beyond the renamed read.
- Produces: `HerdrActions.sendChars(target: string, chars: string[]): Promise<void>`; `POST /api/agents/:id/type` taking `{ text }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/actions.test.ts`:

```ts
test("sendChars sends one key per character", async () => {
  // Measured against a live agent: `send-keys "chào"` is refused with
  // `invalid_key: unsupported key chào`. A key is ONE character, so a word has
  // to arrive as an array — and single non-ASCII characters do work.
  const { path, seen } = await fakeHerdr(() => OK_RESULT);

  await createActions(path).sendChars("w1:p1", ["t", "e", "ế"]);

  expect(seen[0].method).toBe("agent.send_keys");
  expect(seen[0].params.keys).toEqual(["t", "e", "ế"]);
});
```

Create `tests/type-route.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const ESC = String.fromCharCode(27);

/** A dialog with the cursor already on the free-text row. */
const READY = [
  "←  ☐ Tea  ✔ Submit  →",
  "",
  "Which teas do you drink?",
  "",
  "  1. [ ] Green tea",
  "  Light and grassy, lower caffeine.",
  "❯ 2. [ ] Type something",
  "     Submit",
].join("\n");

function harness(over: Partial<Record<string, unknown>> = {}) {
  const sent: string[][] = [];
  const store = new AgentStore("dev-box");
  store.replace([{
    hostId: "local", agentId: "w1:p1", name: "api-refactor", task: null,
    state: "blocked", workspaceId: "w1", workspaceLabel: "w", cwd: "/srv/project",
    harness: "claude", stateSince: 0, stateSinceExact: false, updatedAt: 0,
    acknowledgedAt: null, hasJournal: false,
  }] as never);

  const app = createApp({
    store, hub: new Hub(), health: () => ({}) as never,
    actions: {
      async readPromptScreen() { return READY; },
      async sendChars(_t: string, chars: string[]) { sent.push(chars); },
      async sendNavKey() {},
      async readOutput() { return { lines: ["after"], source: "visible" }; },
      ...over,
    } as never,
  });
  return { app, sent };
}

const type = (app: ReturnType<typeof harness>["app"], text: unknown) =>
  app.request("/api/agents/w1:p1/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

test("text arrives as one key per code point", async () => {
  const { app, sent } = harness();

  const res = await type(app, "chào");

  expect(res.status).toBe(200);
  // Split by CODE POINT, not by byte and not by UTF-16 unit: the operator
  // writes Vietnamese, and a byte split would send fragments herdr rejects.
  expect(sent[0]).toEqual(["c", "h", "à", "o"]);
});

test("an astral-plane character is not cut in half", async () => {
  const { app, sent } = harness();

  await type(app, "a🌱b");

  expect(sent[0]).toEqual(["a", "🌱", "b"]);
});

test("what cannot be typed is refused, not sent on faith", async () => {
  const { app, sent } = harness();

  for (const [why, text] of [
    ["empty", ""],
    ["whitespace only", "   "],
    ["not a string", 42],
    ["a control character", `a${ESC}b`],
    ["a newline, which is Enter and not text", "a\nb"],
    ["past the ceiling", "x".repeat(1_000)],
  ] as [string, unknown][]) {
    const res = await type(app, text);
    expect(res.status, why).toBe(400);
  }

  expect(sent, "nothing reached the agent").toEqual([]);
});

test("the screen the typing produced comes back on the same round trip", async () => {
  // Same contract as `/text` and `/key`: settle, read, answer with the screen,
  // so the browser paints the result instead of waiting for a poll that may
  // have backed off toward ten seconds.
  const { app } = harness();

  const body = await (await type(app, "hi")).json();

  expect(body.ok).toBe(true);
  expect(body.lines).toEqual(["after"]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/type-route.test.ts tests/actions.test.ts`
Expected: FAIL — no `/type` route (404), and `sendChars` is not a function.

- [ ] **Step 3: Add the action**

In `src/server/herdr/actions.ts`, in the interface, after `sendNavKey`:

```ts
  /**
   * Type literal characters into whatever has the agent's keyboard.
   *
   * The capability paddock never had. Its absence is why answering a dialog's
   * free-text row was impossible: `agent.prompt` SUBMITS a reply (its own
   * generated doc says so), and while a menu holds the keyboard a submitted
   * reply goes nowhere the operator can see.
   *
   * One key per character, because herdr refuses a word — measured:
   * `send_keys ["chào"]` answers `invalid_key: unsupported key chào`. Single
   * non-ASCII characters are accepted, so this is NOT an ASCII-only path.
   *
   * Deliberately NOT part of `NAV_KEYS`. A nav key asserts nothing about
   * meaning; a character asserts nothing either, but the two have different
   * validation and folding them together would turn a closed allowlist into an
   * open one.
   */
  sendChars(target: string, chars: string[]): Promise<void>;
```

And the implementation, beside `sendOptionKey`:

```ts
    async sendChars(target, chars) {
      await request<HerdrOk>(socketPath, "agent.send_keys", {
        target, keys: chars,
      } satisfies HerdrAgentSendKeysParams);
    },
```

- [ ] **Step 4: Make the demo refuse it**

In `src/server/demo-actions.ts`, add `sendChars` refusing with the same plain "this is the demo" message every other write uses, and add it to the `WRITES` list in `tests/demo-actions.test.ts`. The guard test "every write on the interface is covered by the list above" fails if you forget — that is what it is for.

- [ ] **Step 5: Add the route**

In `src/server/routes.ts`, beside `/api/agents/:id/text`:

```ts
    /**
     * Type literal characters at the agent.
     *
     * Distinct from `/text`, which SUBMITS a reply through `agent.prompt`.
     * This one types and commits nothing, which is what a dialog's free-text
     * row needs: measured, characters land in the row under the cursor and tick
     * its checkbox, while a submitted reply while a menu holds the keyboard
     * lands nowhere at all.
     *
     * Validated here rather than trusted to the UI, like every other
     * client-supplied string that reaches a herdr parameter. Control characters
     * are refused because they are KEYS, not text — a newline is Enter, and
     * Enter on a dialog row means something the operator did not ask for.
     */
    app.post("/api/agents/:id/type", async (c) => {
      const agent = deps.store.snapshot().find((a) => a.agentId === c.req.param("id"));
      if (!agent) return c.json({ ok: false, detail: "unknown agent" }, 404);

      const text = (await jsonBody(c)).text;
      const chars = typeof text === "string" ? [...text] : [];
      if (
        typeof text !== "string" || text.trim() === "" ||
        chars.length > MAX_TYPE_CHARS ||
        // eslint-disable-next-line no-control-regex
        chars.some((ch) => /[ -]/.test(ch))
      ) {
        return c.json({
          ok: false,
          detail: "text must be printable characters within the length limit",
        }, 400);
      }

      try {
        await actions.sendChars(agent.agentId, chars);
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const out = await actions.readOutput(agent.agentId, agent.state);
        return c.json({ ok: true, ...out });
      } catch (err) {
        return c.json({ ok: false, detail: detailOf(err), lines: [], source: "" }, 502);
      }
    });
```

Add the ceiling beside the other limits at the top of the file:

```ts
/**
 * Characters one `/type` call may send.
 *
 * A free-text answer, not a message: the reply box already exists for prose and
 * goes through `agent.prompt`. Sized so a sentence fits and a paste of a file
 * does not, because every character here is one entry in a `send_keys` array.
 */
const MAX_TYPE_CHARS = 200;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/type-route.test.ts tests/actions.test.ts tests/demo-actions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
make check && make check-clean
git add -A
git commit -m "feat: a bounded route that types characters at an agent"
```

---

## Task 4: Reach the free-text row before typing into it

**Files:**
- Create: `src/server/herdr/dialog-type.ts`
- Modify: `src/server/routes.ts` (the `/type` route calls it)
- Test: `tests/dialog-type.test.ts` (create)

**Interfaces:**
- Consumes: `parseAskDialog` (Task 1), `readPromptScreen` / `sendNavKey` / `sendChars` (Tasks 2–3).
- Produces:

```ts
export interface TypeOutcome { ok: boolean; detail?: string }
export async function typeIntoFreeText(
  target: string,
  chars: string[],
  io: {
    readPromptScreen(target: string): Promise<string>;
    sendNavKey(target: string, key: "up" | "down"): Promise<void>;
    sendChars(target: string, chars: string[]): Promise<void>;
  },
): Promise<TypeOutcome>;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/dialog-type.test.ts`:

```ts
import { expect, test } from "bun:test";
import { typeIntoFreeText } from "@server/herdr/dialog-type";

/** `cursorOn` names the row the `❯` sits on: an option key, or "advance". */
function screen(cursorOn: string) {
  const mark = (row: string) => (row === cursorOn ? "❯" : " ");
  return [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    `${mark("1")} 1. [ ] Green tea`,
    "  Light and grassy, lower caffeine.",
    `${mark("2")} 2. [ ] Black tea`,
    "  Strong and malty, takes milk well.",
    `${mark("3")} 3. [ ] Type something`,
    `  ${mark("advance")}  Submit`,
  ].join("\n");
}

/** Answers each read from a queue, so a move can change what the next read sees. */
function io(reads: string[]) {
  const keys: string[] = [];
  const typed: string[][] = [];
  let i = 0;
  return {
    keys, typed,
    async readPromptScreen() { return reads[Math.min(i++, reads.length - 1)]!; },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars(_t: string, c: string[]) { typed.push(c); },
  };
}

test("with the cursor already on the row, it types and moves nothing", async () => {
  const x = io([screen("3")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(true);
  expect(x.keys, "no keystroke the operator did not ask for").toEqual([]);
  expect(x.typed).toEqual([["h", "i"]]);
});

test("it walks down to the row, then re-reads before typing", async () => {
  // Two downs from option 1 to option 3 — and the SECOND read is what licenses
  // the typing. Counting presses against a screen that has since changed is how
  // an off-by-one becomes a wrong answer to a real question.
  const x = io([screen("1"), screen("3")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(true);
  expect(x.keys).toEqual(["down", "down"]);
  expect(x.typed).toEqual([["h", "i"]]);
});

test("it walks UP when the cursor sits below the row", async () => {
  const x = io([screen("advance"), screen("3")]);

  await typeIntoFreeText("w1:p1", ["h"], x);

  expect(x.keys).toEqual(["up"]);
});

test("if the cursor did not arrive, nothing is typed and it says so", async () => {
  // THE failure this function exists for. Typing into the wrong row edits an
  // option label the operator never chose, or worse, is swallowed silently.
  const x = io([screen("1"), screen("1")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(false);
  expect(out.detail).toContain("text row");
  expect(x.typed, "not a single character").toEqual([]);
});

test("no dialog, or no free-text row in it, is refused before any key is sent", async () => {
  const noDialog = io(["Do you want to proceed?\n❯ 1. Yes\n  2. No"]);
  expect((await typeIntoFreeText("w1:p1", ["h"], noDialog)).ok).toBe(false);
  expect(noDialog.keys).toEqual([]);

  const noRow = io([[
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n")]);
  expect((await typeIntoFreeText("w1:p1", ["h"], noRow)).ok).toBe(false);
  expect(noRow.typed).toEqual([]);
});

test("a single-select dialog is refused outright", async () => {
  // Measured: in single-select the row is not live — characters are ignored —
  // and Enter on it while empty DECLINES the entire dialog. So there is nothing
  // to type into and a real hazard in pretending otherwise.
  const single = io([[
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Which is your single favourite fruit?",
    "",
    "❯ 1. Mango",
    "     Sweet, tropical, and unmistakable.",
    "  2. Type something.",
  ].join("\n")]);

  const out = await typeIntoFreeText("w1:p1", ["h"], single);

  expect(out.ok).toBe(false);
  expect(out.detail).toContain("single");
  expect(single.keys).toEqual([]);
  expect(single.typed).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/dialog-type.test.ts`
Expected: FAIL — `Cannot find module '@server/herdr/dialog-type'`.

- [ ] **Step 3: Write it**

Create `src/server/herdr/dialog-type.ts`:

```ts
import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { AskDialog } from "@shared/types";

export interface TypeOutcome { ok: boolean; detail?: string }

/** The rows a cursor can occupy, in screen order, as a list of keys. */
function rows(dialog: AskDialog): string[] {
  return [...dialog.options.map((o) => o.key), ...(dialog.advance === null ? [] : ["advance"])];
}

function cursorKey(dialog: AskDialog): string | null {
  if (dialog.cursor === null) return null;
  return dialog.cursor.kind === "advance" ? "advance" : dialog.cursor.key;
}

/**
 * Put the agent's cursor on the dialog's free-text row, then type into it.
 *
 * WHY THIS IS NOT JUST A SEND. Measured on a live agent: characters land in the
 * row the cursor is on, and only that row. So typing needs the cursor moved
 * first — and a move is arithmetic on a screen that an agent is free to repaint
 * underneath it. The screen is therefore read again after the move and BEFORE
 * the first character: if the cursor is not where this expected, nothing is
 * typed and the caller is told. A keystroke that did not land must never look
 * like one that did.
 *
 * Single-select is refused rather than attempted. In that mode the row ignores
 * characters entirely, and Enter on it while empty declines the whole dialog —
 * so "try it and see" is not a neutral experiment, it can throw away every
 * answer the operator has already given.
 */
export async function typeIntoFreeText(
  target: string,
  chars: string[],
  io: {
    readPromptScreen(target: string): Promise<string>;
    sendNavKey(target: string, key: "up" | "down"): Promise<void>;
    sendChars(target: string, chars: string[]): Promise<void>;
  },
): Promise<TypeOutcome> {
  const before = parseAskDialog(await io.readPromptScreen(target));
  if (before === null) return { ok: false, detail: "no question dialog on screen" };
  if (before.mode === "single") {
    return {
      ok: false,
      detail: "this question takes a single choice, not typed text",
    };
  }

  const row = before.options.find((o) => o.freeText);
  if (row === undefined) return { ok: false, detail: "this question has no text row" };

  const from = cursorKey(before);
  if (from === null) return { ok: false, detail: "cannot see the cursor on this screen" };

  const order = rows(before);
  const steps = order.indexOf(row.key) - order.indexOf(from);
  const key = steps > 0 ? "down" : "up";
  for (let i = 0; i < Math.abs(steps); i++) await io.sendNavKey(target, key);

  // Re-read even when nothing was sent: the screen may have repainted while the
  // first read was in flight, and this is the read that licenses typing.
  const after = parseAskDialog(await io.readPromptScreen(target));
  if (after === null || cursorKey(after) !== row.key) {
    return { ok: false, detail: "could not reach the text row — nothing was typed" };
  }

  await io.sendChars(target, chars);
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/dialog-type.test.ts`
Expected: PASS.

- [ ] **Step 5: Route the sequence**

In `src/server/routes.ts`, replace the bare `await actions.sendChars(...)` in `/api/agents/:id/type` with:

```ts
        const outcome = await typeIntoFreeText(agent.agentId, chars, actions);
        if (!outcome.ok) return c.json({ ok: false, detail: outcome.detail }, 409);
```

409, not 400: the request was well formed and the SCREEN was wrong, which is the
same distinction `/answer` already draws. Import `typeIntoFreeText` from
`@server/herdr/dialog-type`.

Then update `tests/type-route.test.ts`'s harness so its `READY` screen keeps the
cursor on the free-text row (it already does), and add:

```ts
test("a screen with no text row answers 409, not 400", async () => {
  const { app, sent } = harness({
    async readPromptScreen() { return "Do you want to proceed?\n❯ 1. Yes\n  2. No"; },
  });

  const res = await type(app, "hi");

  expect(res.status).toBe(409);
  expect((await res.json()).detail).toContain("dialog");
  expect(sent).toEqual([]);
});
```

- [ ] **Step 6: Verify against the real agent**

Raise a two-question multi-select dialog on `probe-prompts` (see "Verifying
against a real dialog" above), then:

```bash
curl -s -X POST localhost:8787/api/agents/probe-prompts/type \
  -H 'content-type: application/json' -d '{"text":"chào bạn"}' | head -c 200
herdr agent read probe-prompts --source visible --format text | grep -a "Type something\|chào"
```

Expected: the free-text row reads `[✔] chào bạn`. If the accented characters are
mangled, stop and measure `send_keys` again rather than working around it.

- [ ] **Step 7: Full suite and commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: reach the dialog's text row, verify the cursor, then type"
```

---

## Task 5: The dialog on the phone

**Files:**
- Create: `src/web/components/AskDialogView.tsx`
- Modify: `src/web/api.ts`, `src/web/components/AgentTerminal.tsx`, `src/web/styles.css`
- Test: `tests/ask-dialog-ui.test.tsx` (create)

**Interfaces:**
- Consumes: `AskDialog` (Task 1); `POST /api/agents/:id/type` (Tasks 3–4).
- Produces: `AskDialogView` (props below); `typeIntoDialog(id: string, text: string): Promise<KeyResult>` in `web/api.ts`.

```tsx
export function AskDialogView(props: {
  dialog: AskDialog;
  busy: boolean;
  onToggle: (key: string) => void;       // sends the option's digit
  onArrow: (key: "left" | "right") => void;
  onAdvance: () => void;                 // Enter
  onType: (text: string) => void;
}): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `tests/ask-dialog-ui.test.tsx`:

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import type { AskDialog } from "@shared/types";
import { AskDialogView } from "@web/components/AskDialogView";
import { click, render, textsOf, typeInto, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const multi: AskDialog = {
  questions: [
    { label: "Tea", answered: false, current: true, isSubmit: false },
    { label: "Coffee", answered: true, current: false, isSubmit: false },
    { label: "Submit", answered: false, current: false, isSubmit: true },
  ],
  question: "Which teas do you drink?",
  mode: "multi",
  options: [
    { key: "1", label: "Green tea", checked: true, freeText: false, detail: "Light and grassy." },
    { key: "2", label: "Black tea", checked: false, freeText: false, detail: "Strong and malty." },
    { key: "3", label: "Type something", checked: false, freeText: true },
  ],
  advance: "Next",
  cursor: { kind: "option", key: "1" },
};

const noop = () => {};
const view = (over: Partial<Parameters<typeof AskDialogView>[0]> = {}) => (
  <AskDialogView
    dialog={multi} busy={false}
    onToggle={noop} onArrow={noop} onAdvance={noop} onType={noop}
    {...over}
  />
);

test("each option carries the agent's own label and its real state", async () => {
  const host = await render(view());

  // The free-text row is NOT among the buttons: it is a field, below.
  expect(textsOf(host, ".dialog-option .dialog-option-label")).toEqual([
    "Green tea", "Black tea",
  ]);
  const pressed = [...host.querySelectorAll(".dialog-option")]
    .map((b) => b.getAttribute("aria-pressed"));
  expect(pressed, "state is read off the screen, not tracked locally").toEqual(["true", "false"]);
});

test("tapping an option sends that option's own digit", async () => {
  const sent: string[] = [];
  const host = await render(view({ onToggle: (k) => sent.push(k) }));

  await click(host.querySelector('[data-dialog-option="2"]'));

  // Measured: in multi-select a digit toggles exactly that option and submits
  // nothing. The digit is the agent's, never derived.
  expect(sent).toEqual(["2"]);
});

test("the free-text row is a field, and sending it types the text", async () => {
  const typed: string[] = [];
  const host = await render(view({ onType: (t) => typed.push(t) }));

  await typeInto(host.querySelector(".dialog-text") as HTMLInputElement, "oolong");
  await click(host.querySelector(".dialog-text-send"));

  expect(typed).toEqual(["oolong"]);
});

test("a single-select dialog offers no text control, and says why", async () => {
  // Measured: Enter on that row while empty declines the WHOLE dialog. A button
  // that can throw away every answer already given is worse than no button.
  const host = await render(view({
    dialog: {
      ...multi,
      mode: "single",
      advance: null,
      options: [
        { key: "1", label: "Mango", picked: false, freeText: false, detail: "Tropical." },
        { key: "2", label: "Apple", picked: true, freeText: false, detail: "Crisp." },
        { key: "3", label: "Type something.", picked: false, freeText: true },
      ],
    },
  }));

  expect(host.querySelector(".dialog-text")).toBeNull();
  expect(host.querySelector('[data-dialog-option="3"]'), "nor a button for it").toBeNull();
  expect(host.textContent).toContain("arrow keys");
});

test("the question strip shows where you are and moves one step at a time", async () => {
  const arrows: string[] = [];
  const host = await render(view({ onArrow: (k) => arrows.push(k) }));

  expect(textsOf(host, ".dialog-tab")).toEqual(["Tea", "Coffee ☒", "Submit"]);
  expect(host.querySelector('.dialog-tab[aria-current="step"]')?.textContent).toContain("Tea");

  await click(host.querySelector(".dialog-next-q"));
  expect(arrows).toEqual(["right"]);
});

test("with one question there is no strip to render", async () => {
  const host = await render(view({
    dialog: {
      ...multi,
      questions: [
        { label: "Tea", answered: false, current: true, isSubmit: false },
        { label: "Submit", answered: false, current: false, isSubmit: true },
      ],
    },
  }));

  expect(host.querySelector(".dialog-tabs")).toBeNull();
});

test("the advance button says what the screen says", async () => {
  let advanced = 0;
  const host = await render(view({ onAdvance: () => { advanced++; } }));

  const button = host.querySelector(".dialog-advance") as HTMLButtonElement;
  expect(button.textContent).toContain("Next");
  await click(button);
  expect(advanced).toBe(1);
});

test("every control goes dead while one is in flight", async () => {
  const host = await render(view({ busy: true }));

  for (const b of host.querySelectorAll("button")) {
    expect((b as HTMLButtonElement).disabled, b.className).toBe(true);
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/ask-dialog-ui.test.tsx`
Expected: FAIL — `Cannot find module '@web/components/AskDialogView'`.

- [ ] **Step 3: Add the API call**

In `src/web/api.ts`, beside `sendText`:

```ts
/**
 * Type into a dialog's free-text row.
 *
 * Distinct from `sendText`, which submits a reply through `agent.prompt` and is
 * exactly what fails while a menu holds the agent's keyboard — the reply lands
 * nowhere the operator can see. This types and commits nothing; the server puts
 * the cursor on the row and verifies it before a character is sent.
 */
export async function typeIntoDialog(id: string, text: string, f: Fetch = fetch): Promise<KeyResult> {
  try {
    const res = await request(url(id, "type"), { text }, f);
    return (await res.json()) as KeyResult;
  } catch (err) {
    return { ok: false, detail: String(err), lines: [], source: "" };
  }
}
```

- [ ] **Step 4: Write the component**

Create `src/web/components/AskDialogView.tsx`:

```tsx
import { useState } from "react";
import type { AskDialog } from "@shared/types";
import { Button } from "@web/components/shadcn/button";

/**
 * Claude Code's question dialog, as controls a thumb can reach.
 *
 * EVERY PIECE OF STATE HERE COMES FROM THE SCREEN. The checkbox marks, which
 * question is current, which option is picked — all parsed from what the agent
 * rendered, never tracked locally. A local mirror would drift the moment
 * someone answered at the machine instead of on the phone, and a checkbox that
 * disagrees with the agent is a control that lies.
 *
 * Hook-free apart from the field's own draft, which is genuinely local: it is
 * what the operator has typed and not yet sent.
 *
 * What is NOT offered is as deliberate as what is. In single-select there is no
 * text control and no button for the text row at all, because measurement says
 * that row ignores characters and that Enter on it while empty declines the
 * entire dialog. The arrows and the raw screen remain, which is the honest
 * floor this project keeps for every prompt it cannot fully drive.
 */
export function AskDialogView({ dialog, busy, onToggle, onArrow, onAdvance, onType }: {
  dialog: AskDialog;
  busy: boolean;
  onToggle: (key: string) => void;
  onArrow: (key: "left" | "right") => void;
  onAdvance: () => void;
  onType: (text: string) => void;
}) {
  const freeText = dialog.options.find((o) => o.freeText);
  // Seeded from the screen: after a send, the row's label IS the text, so the
  // field shows what is actually there rather than emptying under the operator.
  const [draft, setDraft] = useState("");
  const typed = freeText !== undefined && !/^Type something\.?$/.test(freeText.label)
    ? freeText.label
    : "";

  const answerable = dialog.options.filter((o) => !o.freeText);
  const questions = dialog.questions.filter((q) => !q.isSubmit);

  return (
    <section className="dialog" aria-label="Question">
      {questions.length > 1 && (
        <div className="dialog-tabs" role="group" aria-label="Questions">
          <Button
            type="button" variant="outline" className="dialog-prev-q"
            disabled={busy} aria-label="Previous question"
            onClick={() => onArrow("left")}
          >
            ◀
          </Button>
          {/* Display, not navigation: tapping a tab by name would mean sending a
              computed run of arrow presses, which is the riskiest machinery in
              this feature for a move the two ends already make in one tap. */}
          <ol className="dialog-tab-list">
            {dialog.questions.map((q) => (
              <li
                key={q.label}
                className="dialog-tab"
                aria-current={q.current ? "step" : undefined}
              >
                {q.label}{q.answered && " ☒"}
              </li>
            ))}
          </ol>
          <Button
            type="button" variant="outline" className="dialog-next-q"
            disabled={busy} aria-label="Next question"
            onClick={() => onArrow("right")}
          >
            ▶
          </Button>
        </div>
      )}

      <p className="dialog-question">{dialog.question}</p>

      <div className="dialog-options" role="group" aria-label="Answer">
        {answerable.map((o) => (
          <Button
            key={o.key}
            type="button"
            variant="outline"
            className="dialog-option"
            data-dialog-option={o.key}
            disabled={busy}
            aria-pressed={o.checked ?? o.picked ?? false}
            onClick={() => onToggle(o.key)}
          >
            <span aria-hidden="true" className="dialog-option-key">{o.key}</span>
            <span className="dialog-option-label">{o.label}</span>
            {o.detail !== undefined && <span className="dialog-option-detail">{o.detail}</span>}
          </Button>
        ))}
      </div>

      {freeText !== undefined && dialog.mode === "multi" && (
        <div className="dialog-text-row">
          <input
            className="dialog-text"
            type="text"
            value={draft}
            placeholder={typed === "" ? "Type your own answer" : typed}
            aria-label="Your own answer"
            disabled={busy}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <Button
            type="button" variant="outline" className="dialog-text-send"
            disabled={busy || draft.trim() === ""}
            onClick={() => { onType(draft); setDraft(""); }}
          >
            Add
          </Button>
        </div>
      )}

      {freeText !== undefined && dialog.mode === "single" && (
        <p className="dialog-note">
          To write your own answer, use the arrow keys and the agent's own screen —
          this question takes one choice, and answering it with empty text
          cancels the whole question.
        </p>
      )}

      {dialog.advance !== null && (
        <Button
          type="button" variant="outline" className="dialog-advance"
          disabled={busy} onClick={onAdvance}
        >
          {dialog.advance}
        </Button>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/ask-dialog-ui.test.tsx`
Expected: PASS.

- [ ] **Step 6: Wire it into the terminal**

In `src/web/components/AgentTerminal.tsx`, render the dialog INSTEAD of the
existing `.term-options` block when `prompt?.dialog` is present, and keep the
existing block otherwise:

```tsx
          {prompt?.dialog
            ? (
              <AskDialogView
                dialog={prompt.dialog}
                busy={busy}
                onToggle={(key) => {
                  setBusy(true);
                  void answerWithKey(agent.agentId, key)
                    .then((r) => setFeedback(r))
                    .finally(() => setBusy(false));
                }}
                onArrow={(key) => void press(key)}
                onAdvance={() => void press("enter")}
                onType={(text) => {
                  setBusy(true);
                  void typeIntoDialog(agent.agentId, text)
                    .then((r) => {
                      if (r.ok && r.lines) pane.current?.apply(r.lines);
                      setFeedback(r.ok ? null : { ok: false, detail: r.detail ?? "Failed." });
                    })
                    .finally(() => setBusy(false));
                }}
              />
            )
            : prompt?.options && prompt.options.length > 0 && (
              /* … the existing option block, unchanged … */
            )}
```

Keep the `⏎ Enter selects` row exactly as it is: it is the fallback's floor and
must still appear when `dialog` is null.

- [ ] **Step 7: Style it**

Add to `src/web/styles.css`, following the neighbouring `.term-option` rules —
tokens only, `2.75rem` minimum touch height, `--r-md` radii, `--t-*` sizes.
`.dialog-tab[aria-current="step"]` gets the accent; `.dialog-option-detail`
renders at `--t-xs` in `--muted`; `.dialog-text-row` lays the field and its
button out with `gap` rather than margins. Run `bun test tests/tokens.test.ts
tests/radius.test.ts tests/themes.test.ts` — those enforce all four rules.

- [ ] **Step 8: Verify on a real dialog in a browser**

```bash
make dev   # or rebuild the binary and restart it on 8787
```

Raise a two-question multi-select dialog on `probe-prompts`, open
`http://localhost:8787/#/agent/probe-prompts` at a 390px width, and check:
option buttons appear with correct checkbox state; tapping one flips it on the
real screen; the strip's `▶` moves to the next question; typing in the field and
tapping Add fills the row; `Next` advances. Take no screenshot into the repo —
the probe's `cwd` must not be committed.

- [ ] **Step 9: Full suite and commit**

```bash
make check && make check-clean && make test
git add -A
git commit -m "feat: answer a question dialog from the phone"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/architecture.md`, `docs/decisions.md`, `docs/gotchas.md`, `docs/design/2026-08-28-question-dialog-design.md`

- [ ] **Step 1: Module rows**

Add a row to the module table in `docs/architecture.md` for each new file —
`src/server/herdr/ask-dialog.ts`, `src/server/herdr/dialog-type.ts`,
`src/web/components/AskDialogView.tsx` — matching the existing column format.
Add `POST /api/agents/:id/type` to the route list beside `/text` and `/key`.

- [ ] **Step 2: The decision**

Append a numbered decision to `docs/decisions.md`, following the format of the
existing entries: that paddock parses this one harness's dialog and refuses
every shape it does not fully recognise; that `NAV_KEYS` stayed closed and
characters got their own validated route; and that no free-text control is
offered in single-select because Enter on an empty row there declines the whole
dialog.

- [ ] **Step 3: The measured facts**

Add to the "herdr protocol specifics" table in `docs/gotchas.md`:

- The `detection` source strips every escape unconditionally — measured, zero
  escapes in a detection read of a live dialog versus 37 escape-bearing lines
  from `visible`. Anything needing colour must read `visible`.
- `agent.send_keys` takes ONE character per key — `["chào"]` is refused with
  `invalid_key` — and accepts non-ASCII, so text is split by code point.
- The same key means different things on different rows of a dialog: a digit
  toggles in multi-select but picks-and-advances in single-select, and Enter on
  an empty free-text row in single-select declines the whole dialog.

- [ ] **Step 4: Mark the design built**

Change the design doc's header to `**Status:** BUILT, 2026-08-28. Plan:
docs/superpowers/plans/2026-08-28-question-dialog.md`, matching how
`2026-08-28-file-viewer-design.md` records the same thing.

- [ ] **Step 5: Close the probe and commit**

```bash
herdr tab close w1P:t4      # the "prompt probe" tab
make check-clean
git add -A
git commit -m "docs: the question dialog, its decision, and what herdr measured"
```

---

## Self-review notes

**Spec coverage.** Design §1 (parser) → Task 1. §2 (read source, stale comment,
background-not-value rule) → Task 2. §3 (three send paths, `/type`, cursor
verification) → Tasks 3–4. §4 (question strip, option buttons, text field,
single-select refusal, advance, fallback) → Task 5. Failure handling → the
refusal tests in Tasks 1, 4 and 5. Testing section → the four test files. The
"question strip: display first" decision → Task 5's component, which renders a
non-interactive `<li>` list plus two arrow buttons.

**Deviations from the design doc, and why.** `DialogQuestion` gained `isSubmit`,
because the Submit tab is a position in the same strip the operator arrows
through and modelling it separately would duplicate the bar. The types live in
`src/shared/types.ts` rather than in `ask-dialog.ts` as the doc's sketch showed
— rule 3 of the architecture: one payload contract, imported by both sides.
`readDetection` is renamed `readPromptScreen` rather than left with a name that
would now be false.
