import type { ParsedPrompt, PromptOption } from "@shared/types";

/** `❯ 1. Yes` / `   2. No` — the cursor marker is optional. */
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const QUESTION_RE = /^\s*(\S.*\?)\s*$/;

/**
 * Any line carrying the cursor marker, whether or not it looks like an option.
 *
 * Deliberately looser than OPTION_RE: some prompts park the cursor on a
 * free-text row ("Type something"), and reporting that verbatim beats
 * reporting nothing. The operator sees what Enter will do either way.
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
  // The nearest question line seen anywhere before the run currently being
  // scanned (or, once a run ends, before the next one starts).
  let lastQuestion: string | null = null;

  let currentRun: PromptOption[] = [];
  let currentRunQuestion: string | null = null;

  let lastRun: PromptOption[] = [];
  let lastRunQuestion: string | null = null;

  // The cursor is tracked in this same pass, but INDEPENDENTLY of the option
  // runs: the last marker anywhere in the buffer wins, so a selection is still
  // reported when the run guards refuse to produce a list. A resolved earlier
  // prompt can still carry a marker, and the live one is always further down.
  let selected: string | null = null;

  for (const rawLine of raw.split("\n")) {
    // Stripped HERE rather than left to the callers, because both now come
    // through this function: `/prompt` reads a detection snapshot with
    // `strip_ansi: true`, but `/key` re-reads the LIVE screen with colour
    // kept. Matching raw bytes made a coloured menu parse as no menu at all,
    // so the preview vanished on the first arrow-down — the same class of
    // failure the ANSI note above records, one call site over.
    const line = stripAnsi(rawLine);

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
      continue;
    }

    // A non-option line ends whatever run was in progress. Record it as the
    // most recent run seen so far — the last one standing wins.
    if (currentRun.length > 0) {
      lastRun = currentRun;
      lastRunQuestion = currentRunQuestion;
      currentRun = [];
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
  const fromRun = marked === undefined ? null : `${marked.key}. ${marked.label}`;

  return {
    question: lastRunQuestion,
    options: usable ? lastRun : null,
    selected: usable ? fromRun : selected,
    raw,
  };
}
