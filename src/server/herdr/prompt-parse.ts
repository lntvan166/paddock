import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { ParsedPrompt, PromptOption } from "@shared/types";

/** `❯ 1. Yes` / `   2. No` — the cursor marker is optional. */
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const QUESTION_RE = /^\s*(\S.*\?)\s*$/;

/** Box-drawing, U+2500–U+257F. An em dash is U+2014 and deliberately outside it. */
const BOX_CHAR_RE = /[\u2500-\u257F]/;

/**
 * The column a preview panel starts at, or null when there is no panel.
 *
 * The question dialog can draw a box to the RIGHT of the menu, so one screen
 * row holds an option and a slab of unrelated preview. Measured on a live
 * Claude Code dialog, the whole right-hand column starts at one fixed offset:
 *
 *   ❯ 1. Scaffold a brand new         ┌──────────────────────────┐
 *       Next.js application from      │ npx create-next-app@latest │
 *       to Vercel                     └──────────────────────────┘
 *       workspace and only minimal    Notes: press n to add notes
 *
 * A CHARACTER test is not enough, and that last line is why: once the box
 * closes, the same column carries ordinary prose. Cutting only box-drawing
 * characters left option three reading "…and only minimal Notes: press n to
 * add notes tooling installed". So the box is used to LOCATE the column, and
 * the column is what gets cut.
 *
 * A candidate needs a gutter of two spaces and real content to its left, which
 * is what separates a panel edge from a full-width horizontal rule at column 0.
 */
function panelColumn(lines: readonly string[]): number | null {
  let found: number | null = null;
  for (const line of lines) {
    for (let i = 2; i < line.length; i++) {
      if (!BOX_CHAR_RE.test(line[i]!)) continue;
      if (line[i - 1] !== " " || line[i - 2] !== " ") break;
      if (line.slice(0, i).trim() === "") break;
      found = found === null ? i : Math.min(found, i);
      break;
    }
  }
  return found;
}

/**
 * One line with the right-hand column removed.
 *
 * The gutter is re-checked per line rather than assumed: a footer running past
 * the panel's column ("Enter to select · ↑/↓ to navigate · n to add notes") has
 * no two spaces there and must survive whole.
 */
function cutPanel(line: string, col: number | null): string {
  if (col === null || line.length <= col) return line;
  if (line[col - 1] !== " " || line[col - 2] !== " ") return line;
  return line.slice(0, col).replace(/\s+$/, "");
}

/**
 * Any line carrying the cursor marker, whether or not it looks like an option.
 *
 * Deliberately looser than OPTION_RE: some prompts park the cursor on a
 * free-text row ("Type something"), and reporting that verbatim beats
 * reporting nothing. The operator sees what Enter will do either way.
 *
 * Which of these survives is decided later, in `parsePrompt`, and only when a
 * menu also parsed: an option-shaped match outside the live run is another
 * question's answer and is dropped, while a non-option-shaped one is the live
 * input row and is kept. So this stays as loose as it looks — the narrowing
 * happens where the run boundaries are known, which is the only place that can
 * tell the two apart.
 */
const CURSOR_RE = /^\s*❯\s*(\S.*?)\s*$/;

/**
 * The line the cursor sits on, marker stripped, or null.
 *
 * The FALLBACK, used by `parsePrompt` only when no menu could be parsed — which
 * is the case it is right for, and the only one. No route calls it directly any
 * more: both `/prompt` and `/key` go through `parsePrompt`, so one rule decides
 * what the preview says on load and after every keystroke. It stays exported
 * because it is tested directly, and because a bare marker scan is worth naming
 * separately from the scoping built on top of it.
 *
 * Either way the parsing lives here rather than in `web/`: the dependency rule
 * keeps every herdr-shaped assumption on this side of the socket.
 *
 * The LAST marker wins: a resolved earlier prompt can still carry one, and the
 * live prompt is always further down the buffer. Note what that cannot know —
 * whether the marker belongs to the menu currently awaiting an answer. Only
 * `parsePrompt` has the run boundaries needed to tell, which is exactly why the
 * scoping lives there and not here.
 */
export function selectedLine(text: string): string | null {
  let selected: string | null = null;
  for (const line of text.split("\n")) {
    const cur = CURSOR_RE.exec(stripAnsi(line));
    if (cur) selected = cur[1]!;
  }
  return selected;
}

/**
 * Escapes are removed before matching because the two callers read with
 * different settings. `/prompt` asks for `strip_ansi: true`, but `/key`
 * re-reads the LIVE screen with colour kept, so the cursor line starts with
 * escape bytes rather than whitespace. Matching only clean text made the
 * preview appear on load and then vanish on the first arrow-down — exactly
 * when it exists to stop the operator arrowing one step too far.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][A-Za-z0-9]|\u001b./g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

/**
 * Turn a `detection` snapshot into options paddock can render.
 *
 * Returning `options: null` is a first-class outcome, not a failure: the UI
 * falls back to raw output plus a free-text reply. Every guard below prefers
 * null over a plausible-looking list, because a wrong button is worse than no
 * button — a mis-tap could select "no, and here's what to do instead".
 *
 * Matching is scoped to the LAST contiguous run of option-shaped lines, not
 * the whole buffer. A `detection` snapshot is captured while the agent is
 * blocked, so the live menu is always the last such run in the buffer.
 * Scoping to it — instead of collecting every option-shaped line anywhere in
 * `raw` — means a stray numbered line elsewhere in scrollback (plain output,
 * or a resolved earlier prompt) can never be spliced onto the real menu just
 * because the concatenation happens to number contiguously.
 */
export function parsePrompt(raw: string): ParsedPrompt {
  /**
   * Parsed FIRST, because it decides whether wrapped labels are adopted below.
   *
   * `raw`, not the stripped lines: `parseAskDialog` needs the escapes.
   *
   * The question dialog's own shape puts a DESCRIPTION under each option, which
   * is indented exactly like a wrapped label and cannot be told from one by
   * looking. The general parser is required to refuse that shape — its refusal
   * is what routes the screen to the dialog parser instead — so the two rules
   * are separated by ownership rather than by a guess about indentation: a
   * screen the dialog parser claims is never re-read as wrapped prose here.
   */
  const dialog = parseAskDialog(raw);
  const adoptWrapped = dialog === null;

  // The nearest question line seen anywhere before the run currently being
  // scanned (or, once a run ends, before the next one starts).
  let lastQuestion: string | null = null;

  let currentRun: PromptOption[] = [];
  let currentRunQuestion: string | null = null;
  /**
   * Indent of the option line the run is currently on, or -1 between runs.
   *
   * A label too long for the column wraps onto a line with no number on it, so
   * `OPTION_RE` misses it and — before this — it ENDED THE RUN. Every option
   * became a run of one, `contiguous` (which needs two) rejected them all, and
   * a screen showing three answers offered none. Closing the run also cleared
   * `lastQuestion`, so the question vanished with them.
   *
   * The indent is what tells a wrapped label from the next paragraph: a
   * continuation sits under its own label, further in than the number that
   * introduced it.
   */
  let runIndent = -1;

  let lastRun: PromptOption[] = [];
  let lastRunQuestion: string | null = null;

  // The cursor is tracked in this same pass, but INDEPENDENTLY of the option
  // runs: the last marker anywhere in the buffer wins, so a selection is still
  // reported when the run guards refuse to produce a list. A resolved earlier
  // prompt can still carry a marker, and the live one is always further down.
  let selected: string | null = null;

  // Stripped once, up front, because the panel's column has to be known before
  // any line is matched against it.
  const stripped = raw.split("\n").map((l) => stripAnsi(l));
  const panelAt = panelColumn(stripped);

  for (const line of stripped.map((l) => cutPanel(l, panelAt))) {
    // Stripped HERE rather than left to the callers, because both now come
    // through this function: `/prompt` reads a detection snapshot with
    // `strip_ansi: true`, but `/key` re-reads the LIVE screen with colour
    // kept. Matching raw bytes made a coloured menu parse as no menu at all,
    // so the preview vanished on the first arrow-down — the same class of
    // failure the ANSI note above records, one call site over.

    const cur = CURSOR_RE.exec(line);
    if (cur) selected = cur[1]!;

    const opt = OPTION_RE.exec(line);
    if (opt) {
      if (currentRun.length === 0) {
        // Starting a new run: pin whatever question was nearest at this
        // point. A later, unrelated run must not inherit it.
        currentRunQuestion = lastQuestion;
      }
      currentRun.push({ key: opt[2]!, label: opt[3]!, selected: Boolean(opt[1]) });
      runIndent = line.length - line.trimStart().length;
      continue;
    }

    // A wrapped label: no number, but indented past the number that introduced
    // it, and immediately after it — a blank line still ends the run below, so
    // a later paragraph that happens to be deeply indented cannot be adopted.
    const last = currentRun[currentRun.length - 1];
    if (adoptWrapped && last !== undefined && line.trim() !== ""
        && line.length - line.trimStart().length > runIndent) {
      last.label = `${last.label} ${line.trim()}`;
      continue;
    }

    // A non-option line ends whatever run was in progress. Record it as the
    // most recent run seen so far — the last one standing wins.
    if (currentRun.length > 0) {
      lastRun = currentRun;
      lastRunQuestion = currentRunQuestion;
      currentRun = [];
      runIndent = -1;
      // The question that applied to the run that just closed must not
      // survive into the next one. Without this reset, two runs separated
      // only by a blank line (no fresh question in between) would let the
      // later run silently inherit an earlier, already-resolved caption.
      lastQuestion = null;
    }

    const q = QUESTION_RE.exec(line);
    if (q) lastQuestion = q[1]!.trim();
  }
  // The buffer can end mid-run (no trailing blank/other line after the menu).
  if (currentRun.length > 0) {
    lastRun = currentRun;
    lastRunQuestion = currentRunQuestion;
  }

  // Three guards, all preferring null:
  //  - fewer than two options is as likely to be a numbered list in output
  //  - non-contiguous numbering means a truncated capture, a stray line, or
  //    an accidental match — a partial list is tappable and wrong
  //  - no question means paddock has nothing to show the operator they'd be
  //    answering, so it must not render answer buttons for it
  const contiguous =
    lastRun.length >= 2 && lastRun.every((o, i) => o.key === String(i + 1));
  const usable = contiguous && lastRunQuestion !== null;

  /**
   * Whenever there IS a usable menu, the selection is scoped to that menu —
   * never to the global marker scan above.
   *
   * The scan takes the last marker anywhere in the buffer, which is right when
   * no list could be parsed (that is the case it exists for) and wrong the
   * moment one could. A box asking several questions in sequence leaves the
   * answered ones on screen with their markers, and the menu still awaiting an
   * answer carries none yet — so the last marker in the buffer belongs to a
   * DIFFERENT question than `options` does. The UI renders both next to each
   * other, so the operator reads "Enter selects <an option they already
   * answered>" above buttons from the live question. Found on a phone.
   *
   * That is the one failure this field exists to prevent, so silence beats a
   * stale answer: with a menu on screen the buttons already show what can be
   * chosen, and the selected one carries its own accent border.
   *
   * The `N. label` shape is rebuilt rather than reusing the matched line so
   * the string is identical to what the scan produced for the same menu — this
   * narrows where the value comes from, it does not restyle it.
   */
  const marked = lastRun.find((o) => o.selected);
  const fromRun =
    marked !== undefined
      ? `${marked.key}. ${marked.label}`
      // Not every surviving marker is another question's answer. An
      // OPTION-SHAPED one outside the live run can only be a menu already
      // answered — drop it. A marker that is NOT option-shaped can only be the
      // live input row ("❯ Type something"), where Enter submits text rather
      // than an option, and dropping that loses the one thing the operator
      // needed to know. `CURSOR_RE` was widened for precisely that case.
      : selected !== null && OPTION_RE.test(selected)
        ? null
        : selected;

  return {
    question: lastRunQuestion,
    options: usable ? lastRun : null,
    selected: usable ? fromRun : selected,
    // Composed HERE rather than at each route, and that is a deliberate choice
    // against the obvious one.
    //
    // The design had the /prompt route hand the screen to both parsers. But
    // `/prompt` is fetched ONCE per state change, never polled — so a dialog
    // parsed only there goes stale the instant a key lands, and a checkbox that
    // disagrees with the agent is precisely the lying control this project
    // refuses. `/key` already re-reads the screen and re-parses it for
    // `selected`, for the same reason and in the same breath. Putting the
    // dialog inside this function means every path that re-reads a screen gets
    // a fresh one and no path can forget to.
    //
    // `raw`, not the stripped lines: `parseAskDialog` needs the escapes. The
    // current tab of a dialog is marked ONLY by a background colour.
    dialog,
    raw,
  };
}
