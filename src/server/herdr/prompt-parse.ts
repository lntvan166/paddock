import type { ParsedPrompt, PromptOption } from "@shared/types";

/** `❯ 1. Yes` / `   2. No` — the cursor marker is optional. */
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const QUESTION_RE = /^\s*(\S.*\?)\s*$/;

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

  for (const line of raw.split("\n")) {
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

  return { question: lastRunQuestion, options: usable ? lastRun : null, raw };
}
