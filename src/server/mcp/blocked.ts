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
  const dialog = isQuestionDialog(screen) ? parseAskDialog(screen) : null;
  if (dialog !== null) {
    return { kind: "question", question: dialog.question, options: dialog.options.map((o) => o.label), raw: null };
  }
  const p = parsePrompt(screen);
  if (p.options === null) return { kind: "permission", question: p.question, options: [], raw: stripAnsi(screen) };
  return { kind: "permission", question: p.question, options: p.options.map((o) => o.label), raw: null };
}

/**
 * Words only a permission prompt puts on screen. Claude Code writes them
 * itself; an agent's output cannot remove them from its own prompt.
 */
const PERMISSION_MARKERS = /\bDo you want to\b|don['’]t ask again|\bAllow (once|always)\b/i;

/**
 * A question dialog, positively, for the bridge's purposes.
 *
 * `parseAskDialog` alone is not enough here. It takes the last tab-bar-shaped
 * line anywhere on screen, so a permission prompt whose COMMAND contains such
 * a line (a heredoc writing a fixture, say) parses as a question. The UI can
 * afford that; the bridge cannot, because "question" is what licenses it to
 * press a key. So any permission marker on screen vetoes the parse. The cost
 * falls on the safe side: a real question that mentions "Do you want to" is
 * refused, and the operator answers it on the phone.
 */
export function isQuestionDialog(screen: string): boolean {
  return parseAskDialog(screen) !== null && !PERMISSION_MARKERS.test(stripAnsi(screen));
}

/**
 * Whether ANY prompt seems to be on screen: a question dialog, a permission
 * marker, or a numbered menu under a question line.
 *
 * Read just before `send_message` types, because the store's state lags
 * herdr's detection: an agent can sit on a fresh prompt while the store
 * still says `working`, and the Enter that submits a message would answer it.
 */
export function promptOnScreen(screen: string): boolean {
  if (parseAskDialog(screen) !== null || PERMISSION_MARKERS.test(stripAnsi(screen))) return true;
  const p = parsePrompt(screen);
  return p.options !== null && p.question !== null;
}
