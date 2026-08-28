import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { AskDialog } from "@shared/types";

export interface TypeOutcome { ok: boolean; detail?: string }

/**
 * What either action needs from the agent: read the screen, move the cursor,
 * and act. `enter` is a move-adjacent key here rather than a separate verb
 * because it is what COMMITS the row the cursor reached.
 */
export interface DialogIo {
  readPromptScreen(target: string): Promise<string>;
  sendNavKey(target: string, key: "up" | "down" | "enter"): Promise<void>;
  sendChars(target: string, chars: string[]): Promise<void>;
  /**
   * Wait for the TUI to repaint after a write, before the read that checks it.
   *
   * Supplied by the route, which owns the timing constant. Optional so a test
   * can omit it and run without a real delay — but a caller that omits it in
   * production reintroduces the race described on `reachRow`.
   */
  settle?: () => Promise<void>;
}

/** The rows a cursor can occupy, in screen order, as a list of keys. */
function rows(dialog: AskDialog): string[] {
  return [...dialog.options.map((o) => o.key), ...(dialog.advance === null ? [] : ["advance"])];
}

function cursorKey(dialog: AskDialog): string | null {
  if (dialog.cursor === null) return null;
  return dialog.cursor.kind === "advance" ? "advance" : dialog.cursor.key;
}

/**
 * Move the cursor onto `rowKey` and CONFIRM it arrived, returning the re-read
 * dialog — or null if it did not.
 *
 * Shared by both actions here because both learned the same lesson the same
 * way. Keys act on the row the cursor is on, and a row count computed from one
 * read is a guess about a screen the agent may have repainted since. So the
 * screen is read again before anything is committed, and "the cursor is not
 * where I put it" is a refusal rather than a keystroke sent anyway.
 *
 * The re-read happens even when no move was needed: the first read may already
 * have been stale.
 *
 * AND IT WAITS FOR A REPAINT FIRST when moves were sent. `/key`'s own comment
 * records why: a TUI repaints asynchronously after a write, so reading
 * immediately returns the PREVIOUS frame. Without the settle this saw the
 * pre-move cursor and refused — intermittently, and never when zero moves were
 * needed, which is precisely the shape that let it pass every test and every
 * command-line check while failing on a phone.
 */
async function reachRow(
  target: string, dialog: AskDialog, rowKey: string, io: DialogIo,
): Promise<AskDialog | null> {
  const from = cursorKey(dialog);
  if (from === null) return null;

  const order = rows(dialog);
  const steps = order.indexOf(rowKey) - order.indexOf(from);
  const key = steps > 0 ? "down" : "up";
  for (let i = 0; i < Math.abs(steps); i++) await io.sendNavKey(target, key);
  if (steps !== 0) await io.settle?.();

  const after = parseAskDialog(await io.readPromptScreen(target));
  if (after === null || cursorKey(after) !== rowKey) return null;
  return after;
}

/**
 * Advance the dialog: Enter, but on the `Next`/`Submit` row rather than
 * wherever the cursor happens to be.
 *
 * FOUND IN A BROWSER against a live agent, which is the only place it could
 * have been found: the Next button sent Enter blindly, the cursor was on option
 * 1, and the tap UNTICKED "Black tea" and advanced nothing. Enter acts on the
 * cursor's row — the same fact that makes typing need a verified cursor — and a
 * control that silently changes an answer is worse than one that does nothing.
 */
export async function advanceDialog(target: string, io: DialogIo): Promise<TypeOutcome> {
  const dialog = parseAskDialog(await io.readPromptScreen(target));
  if (dialog === null) return { ok: false, detail: "no question dialog on screen" };
  if (dialog.advance === null) {
    // Single-select has no advance row: picking an option advances on its own.
    return { ok: false, detail: "this question has nothing to advance to" };
  }

  const reached = await reachRow(target, dialog, "advance", io);
  if (reached === null) {
    return { ok: false, detail: `could not reach ${dialog.advance} — nothing was pressed` };
  }

  await io.sendNavKey(target, "enter");
  return { ok: true };
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
  io: DialogIo,
): Promise<TypeOutcome> {
  const before = parseAskDialog(await io.readPromptScreen(target));
  if (before === null) return { ok: false, detail: "no question dialog on screen" };
  if (before.mode === "single") {
    return { ok: false, detail: "this question takes a single choice, not typed text" };
  }

  const row = before.options.find((o) => o.freeText);
  if (row === undefined) return { ok: false, detail: "this question has no text row" };

  if (await reachRow(target, before, row.key, io) === null) {
    return { ok: false, detail: "could not reach the text row — nothing was typed" };
  }

  await io.sendChars(target, chars);
  return { ok: true };
}
