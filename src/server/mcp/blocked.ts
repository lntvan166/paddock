import { parseAskDialog } from "@server/herdr/ask-dialog";
import { parsePrompt } from "@server/herdr/prompt-parse";
import { stripAnsi } from "@server/journal/text";

export interface BlockedInfo {
  /** `question` only when `parseAskDialog` recognises the screen. */
  kind: "permission" | "question";
  question: string | null;
  /** Real labels, as rendered. Empty when the screen could not be parsed. */
  options: string[];
  /** The stripped screen, only when there were no options to offer. */
  raw: string | null;
}

/**
 * Which kind of blocked screen this is, for the remote side.
 *
 * ANYTHING not recognised as a question dialog is a permission prompt. That
 * is the safe direction to be wrong in: a question mistaken for a permission
 * prompt costs the operator a tap on the phone, while the reverse would hand
 * the bridge an approval it must never have.
 */
export function describeBlocked(screen: string): BlockedInfo {
  const dialog = parseAskDialog(screen);
  if (dialog !== null) {
    return { kind: "question", question: dialog.question, options: dialog.options.map((o) => o.label), raw: null };
  }
  const p = parsePrompt(screen);
  if (p.options === null) return { kind: "permission", question: p.question, options: [], raw: stripAnsi(screen) };
  return { kind: "permission", question: p.question, options: p.options.map((o) => o.label), raw: null };
}
