import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { AskDialog } from "@shared/types";

export interface TypeOutcome { ok: boolean; detail?: string }

/** A tab move also answers with the dialog it landed on, so the UI can render it. */
export interface TabOutcome extends TypeOutcome { dialog?: AskDialog }

/**
 * What either action needs from the agent: read the screen, move the cursor,
 * and act. `enter` is a move-adjacent key here rather than a separate verb
 * because it is what COMMITS the row the cursor reached.
 */
export interface DialogIo {
  readPromptScreen(target: string): Promise<string>;
  sendNavKey(target: string, key: "up" | "down" | "enter" | "left" | "right"): Promise<void>;
  sendChars(target: string, chars: string[]): Promise<void>;
  sendOptionKey(target: string, key: string): Promise<void>;
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
 * Get the cursor OFF the free-text row, if it is on it.
 *
 * THE RULE THIS FEATURE KEEPS RELEARNING: the free-text row is an input, so
 * every key that means something to an input means something different there.
 * Measured on a live agent, one at a time:
 *
 *  - a DIGIT is typed as text, not a toggle (`4. [✔] 2` became `4. [✔] 21`)
 *  - `space` inserts a space instead of toggling
 *  - LEFT/RIGHT move the text caret instead of changing question — reported as
 *    "current probe cannot go left right by arrow", with the cursor left there
 *    by the previous thing the operator did
 *  - `enter` on it, empty, declines the whole dialog
 *
 * So anything that is not itself meant for the text row steps off first. The
 * destination is the FIRST option, which is deterministic and cannot be the
 * text row itself; `reachRow` then verifies before the real key is sent.
 *
 * Returns false when it could not be done, and the caller must send nothing.
 */
async function leaveTextRow(target: string, dialog: AskDialog, io: DialogIo): Promise<boolean> {
  const cursor = cursorKey(dialog);
  const onText = dialog.options.some((o) => o.freeText && o.key === cursor);
  if (!onText) return true;

  const landing = dialog.options.find((o) => !o.freeText);
  if (landing === undefined) return false;
  return await reachRow(target, dialog, landing.key, io) !== null;
}

/**
 * Toggle or pick one option, by sending its own digit — safely.
 *
 * A digit is a toggle ONLY when the cursor is not on the free-text row. With
 * the cursor there it is TEXT: measured on a phone, `4. [✔] 2` became
 * `4. [✔] 21` and option 1 never moved. So a tap silently edited the operator's
 * typed answer instead of answering the question, which is the worst thing a
 * control in this project can do.
 *
 * The fast path is unchanged and is the common one — cursor on an option, digit
 * straight out, nothing moved. Only when the cursor is parked on the text row
 * does this move it first, and then it verifies before sending, because a digit
 * sent on a guess is exactly the failure being fixed.
 */
export async function toggleDialogOption(
  target: string, key: string, io: DialogIo,
): Promise<TypeOutcome> {
  const dialog = parseAskDialog(await io.readPromptScreen(target));
  if (dialog === null) return { ok: false, detail: "no question dialog on screen" };

  if (!await leaveTextRow(target, dialog, io)) {
    return { ok: false, detail: "could not step off the text row — nothing was sent" };
  }

  await io.sendOptionKey(target, key);
  return { ok: true };
}

/**
 * How many times to look for the repaint before giving up.
 *
 * Bounded rather than open-ended: moving right from the last tab legitimately
 * changes nothing, and that must return promptly rather than spin. Four looks
 * at the route's settle interval is a few hundred milliseconds — long enough
 * for a repaint, short enough that "nothing happened" still feels like a tap.
 */
const LOOKS = 4;

/**
 * Move to the next or previous question, and WAIT until the screen agrees.
 *
 * A nav key followed by one fixed pause is a guess about how fast a TUI
 * repaints, and when the guess was wrong the re-read returned the previous
 * question, the UI rendered it, and the tap looked ignored. Reported as "left
 * right sometimes not work" — intermittently, which is the worst way for a
 * control to fail, because the operator cannot tell a slow tap from a dead one.
 *
 * So the question line is the witness: read it, send the key, then look again
 * until it changes or the budget runs out. An unchanged question after the
 * budget is reported as success with the screen as it stands, because that is
 * what "you are already on the last tab" looks like and it is not an error.
 */
export async function moveDialogTab(
  target: string, dir: "left" | "right", io: DialogIo,
): Promise<TabOutcome> {
  const before = parseAskDialog(await io.readPromptScreen(target));
  if (before === null) return { ok: false, detail: "no question dialog on screen" };

  // The arrow reaches the tabs only from a row that is not an input.
  if (!await leaveTextRow(target, before, io)) {
    return { ok: false, detail: "could not step off the text row — nothing was sent" };
  }

  await io.sendNavKey(target, dir);

  let latest = before;
  for (let i = 0; i < LOOKS; i++) {
    await io.settle?.();
    const now = parseAskDialog(await io.readPromptScreen(target));
    if (now === null) continue;
    latest = now;
    if (now.question !== before.question) break;
  }

  return { ok: true, dialog: latest };
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
 * BOTH MODES, and an earlier version of this refused single-select on a
 * measurement that was simply wrong. That test sent the cursor moves and the
 * characters in ONE batch, so the characters arrived before the cursor did and
 * were swallowed — the very repaint race `reachRow` now settles for. Re-measured
 * one step at a time: `4. Type something.` becomes `4. rust`, and Enter then
 * submits it (`… → rust`, verbatim from the transcript). A refusal built on a
 * bad measurement is worse than no feature, because it also carried a note
 * telling the operator to do it a way that does not work either.
 *
 * What remains true is narrower: Enter on an EMPTY text row declines the whole
 * dialog. So nothing here ever sends Enter, and the UI keeps its send disabled
 * until there is something to send.
 */
export async function typeIntoFreeText(
  target: string,
  chars: string[],
  io: DialogIo,
): Promise<TypeOutcome> {
  const before = parseAskDialog(await io.readPromptScreen(target));
  if (before === null) return { ok: false, detail: "no question dialog on screen" };

  const row = before.options.find((o) => o.freeText);
  if (row === undefined) return { ok: false, detail: "this question has no text row" };

  const after = await reachRow(target, before, row.key, io);
  if (after === null) {
    return { ok: false, detail: "could not reach the text row — nothing was typed" };
  }

  // ERASE FIRST. Typing is characters, and characters land after whatever is
  // already in the row — so correcting a typo produced a concatenation, and
  // there was no way back. Reported from a phone: "first i type Trái dừa, then
  // i type Trái cây and add again, i think it will replace but it append".
  //
  // The count comes from the row as the VERIFYING read saw it, not from the
  // first read, so it cannot be stale. `backspace` is a key name and rides in
  // the same `send_keys` list as the characters, so this stays one round trip.
  const existing = after.options.find((o) => o.freeText)?.typed ?? "";
  const erase = Array.from({ length: [...existing].length }, () => "backspace");

  await io.sendChars(target, [...erase, ...chars]);
  return { ok: true };
}
