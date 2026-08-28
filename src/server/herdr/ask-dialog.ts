import type { AskDialog, DialogOption, DialogQuestion } from "@shared/types";

/**
 * Claude Code's `AskUserQuestion` dialog, read off one screen.
 *
 * Separate from `prompt-parse.ts` on purpose, and the split is by JOB rather
 * than by shape: that parser extracts what it can from an UNKNOWN screen and
 * reports the parts independently, so a cursor stays usable when an option list
 * does not. This one recognises ONE dialog completely or returns null, and null
 * costs nothing — the UI keeps the controls it has today.
 *
 * WHY THIS EXISTS AT ALL. `prompt-parse.ts` refuses this screen, correctly: each
 * option is followed by a description line, a non-option line ends an option
 * run, so every run is one option long and every run fails the "fewer than two"
 * guard. Measured against a real dialog it returns
 * `question: null, options: null` — which is exactly what reached a phone, and
 * the report that started this: a structured question with no buttons on it.
 *
 * Every keystroke effect a caller relies on is tabulated in
 * `docs/design/2026-08-28-question-dialog-design.md`, measured on a live agent
 * one key at a time. Read that before changing anything here. The headline is
 * that THE SAME KEY MEANS DIFFERENT THINGS ON DIFFERENT ROWS — a digit toggles
 * in multi-select but picks-and-advances in single-select, and Enter on an empty
 * free-text row in single-select declines the whole dialog. Knowing which row is
 * which is the entire value this module adds.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -\/]*[@-~]|[()][A-Za-z0-9]|./g;

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
/**
 * The unnumbered row below the options.
 *
 * `^\s*` before the cursor, not `^\s+`, and that one character was a bug found
 * in a browser: the cursor marker sits at COLUMN 0 when it is on this row
 * (`❯    Next`) exactly as it does on an option row, so requiring leading
 * whitespace made the row invisible precisely when the cursor had reached it —
 * which is when advancing needs to see it. The `\s+` after the marker is what
 * still keeps a bare unindented `Next` in prose from matching.
 */
const ADVANCE_RE = /^\s*(❯)?\s+(Next|Submit)\s*$/;
/** The label a fresh free-text row carries. Single-select adds a full stop. */
const FREE_TEXT_LABEL_RE = /^Type something\.?$/;
/** The rule that closes the option list, above `N. Chat about this`. */
const RULE_RE = /^\s*─{4,}\s*$/;

/**
 * Whether a run of text sets an ANSI BACKGROUND colour.
 *
 * This is how the current tab is found, and it is fiddlier than it looks. A
 * naive `/4[0-7]/` test matches digits inside a truecolor FOREGROUND —
 * `38;2;44;0;0` contains `44` — so the parameter list has to be walked with the
 * arguments of an extended colour stepped over rather than re-read as codes.
 * Getting it wrong marks every tab as current, which is worse than marking none.
 */
function setsBackground(text: string): boolean {
  for (const m of text.matchAll(/\[([0-9;]*)m/g)) {
    const params = (m[1] ?? "").split(";").map((p) => Number(p) || 0);
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      // 48 = extended background, 40–47 = basic, 100–107 = bright.
      if (p === 48 || (p >= 40 && p <= 47) || (p >= 100 && p <= 107)) return true;
      // An extended FOREGROUND: step over its arguments. `38;5;n` has one,
      // `38;2;r;g;b` has three.
      if (p === 38) i += params[i + 1] === 2 ? 4 : 2;
    }
  }
  return false;
}

/**
 * The text of the one tab segment carrying a background, or null.
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
      // `includes`, not equality: the highlighted run carries the marker and the
      // padding spaces around the label as well as the label itself.
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
  // understand, and the mode decides what a digit MEANS — so guessing it is the
  // one error that turns a button into a wrong answer.
  const boxed = options.filter((o) => o.checked !== undefined).length;
  if (boxed !== 0 && boxed !== options.length) return null;
  const mode = boxed === options.length ? "multi" : "single";

  const last = options[options.length - 1]!;
  const onlyOneWithoutDetail =
    last.detail === undefined && options.slice(0, -1).every((o) => o.detail !== undefined);
  if (FREE_TEXT_LABEL_RE.test(last.label) || onlyOneWithoutDetail) last.freeText = true;

  return { questions, question, mode, options, advance, cursor };
}
