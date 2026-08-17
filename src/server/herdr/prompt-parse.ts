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
 */
export function parsePrompt(raw: string): ParsedPrompt {
  const options: PromptOption[] = [];
  let question: string | null = null;

  for (const line of raw.split("\n")) {
    const opt = OPTION_RE.exec(line);
    if (opt) {
      options.push({ key: opt[2]!, label: opt[3]!, selected: Boolean(opt[1]) });
      continue;
    }
    // Keep the LAST question seen before the options start, so surrounding
    // scrollback cannot supply a stale question line.
    if (options.length === 0) {
      const q = QUESTION_RE.exec(line);
      if (q) question = q[1]!.trim();
    }
  }

  // Two guards, both preferring null:
  //  - fewer than two options is as likely to be a numbered list in output
  //  - non-contiguous numbering means a truncated capture or an accidental
  //    match, and a partial list is tappable and wrong
  const usable =
    options.length >= 2 && options.every((o, i) => o.key === String(i + 1));

  return { question, options: usable ? options : null, raw };
}
