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
 * Put the agent's cursor on a question dialog's free-text row, then type into it.
 *
 * WHY THIS IS NOT JUST A SEND. Measured on a live agent: characters land in the
 * row the cursor is on, and ONLY that row — with the cursor elsewhere they are
 * swallowed. So typing needs the cursor moved first, and a move is arithmetic
 * against a screen an agent is free to repaint underneath it. The screen is
 * therefore read AGAIN after the move and BEFORE the first character: if the
 * cursor is not where this expected, nothing is typed and the caller is told.
 * A keystroke that did not land must never look like one that did.
 *
 * Two measured details make this worth the round trip rather than a keystroke
 * count sent on faith:
 *
 *  - Typing into the row also TICKS its checkbox, so a stray character is a
 *    silently selected answer, not just a cosmetic edit.
 *  - `space` inserts a space on that row but TOGGLES on every other one, so the
 *    same payload sent one row off does something entirely different.
 *
 * Single-select is refused rather than attempted. In that mode the row ignores
 * characters entirely, and Enter on it while empty declines the whole dialog —
 * so "try it and see" is not a neutral experiment: it can throw away every
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
    return { ok: false, detail: "this question takes a single choice, not typed text" };
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
