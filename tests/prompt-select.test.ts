import { expect, test } from "bun:test";
import { selectByCursor } from "@server/herdr/dialog-type";

/**
 * Answering a question dialog the way it actually accepts answers.
 *
 * Measured on a live agent: a digit sent to this dialog changed NOTHING — the
 * cursor stayed on option 1, the dialog stayed up, the agent stayed blocked,
 * and the wait for an unblock timed out and reported a failure for a keystroke
 * that had never done anything. ↑/↓ moved the cursor between the three options
 * and Enter committed the one under it, exactly as the footer says.
 *
 * So the cursor is walked and Enter commits. The fake below models that, and
 * the assertions are about which option was committed rather than which keys
 * were sent — sending the right keys to the wrong row is the failure worth
 * catching.
 */
function fakeDialog(startCursor = 1) {
  let cursor = startCursor;
  let committed: number | null = null;
  const keys: string[] = [];

  const screen = (): string =>
    [
      "Which deploy target should I use?",
      "",
      ...[1, 2, 3].map((n) =>
        `${n === cursor ? "❯" : " "} ${n}. Option number ${n} with a reasonably long label`,
      ),
      "",
      "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
    ].join("\n");

  return {
    keys,
    committedValue: () => committed,
    io: {
      readPromptScreen: async () => screen(),
      sendNavKey: async (_t: string, key: string) => {
        keys.push(key);
        if (key === "down") cursor = Math.min(3, cursor + 1);
        else if (key === "up") cursor = Math.max(1, cursor - 1);
        else if (key === "enter") committed = cursor;
      },
      sendChars: async () => { throw new Error("must not type"); },
      sendOptionKey: async () => { throw new Error("a digit does nothing here"); },
      settle: async () => {},
    },
  };
}

test("an option below the cursor is reached by moving down", async () => {
  const d = fakeDialog(1);
  const r = await selectByCursor("w1:p1", "3", true, d.io as never);
  expect(r.ok).toBe(true);
  expect(d.committedValue()).toBe(3);
});

test("an option above the cursor is reached by moving up", async () => {
  const d = fakeDialog(3);
  const r = await selectByCursor("w1:p1", "1", true, d.io as never);
  expect(r.ok).toBe(true);
  expect(d.committedValue()).toBe(1);
});

test("the option already under the cursor commits with no movement", async () => {
  const d = fakeDialog(2);
  const r = await selectByCursor("w1:p1", "2", true, d.io as never);
  expect(r.ok).toBe(true);
  expect(d.committedValue()).toBe(2);
  expect(d.keys.filter((k) => k === "up" || k === "down")).toEqual([]);
});

test("a digit is never sent, because it does nothing on this dialog", async () => {
  // The fake throws if one is. This is the whole defect being guarded.
  const d = fakeDialog(1);
  await selectByCursor("w1:p1", "2", true, d.io as never);
  expect(d.committedValue()).toBe(2);
});

test("Enter is the last key, never sent before the cursor arrives", async () => {
  const d = fakeDialog(1);
  await selectByCursor("w1:p1", "3", true, d.io as never);
  expect(d.keys[d.keys.length - 1]).toBe("enter");
  expect(d.keys.filter((k) => k === "enter").length).toBe(1);
});

test("an option the screen does not offer is refused, not guessed at", async () => {
  const d = fakeDialog(1);
  const r = await selectByCursor("w1:p1", "9", true, d.io as never);
  expect(r.ok).toBe(false);
  expect(d.committedValue()).toBeNull();
  expect(d.keys).toEqual([]);
});

test("a prompt that takes digits is refused by this path", async () => {
  // A permission prompt has no "Enter to select" footer and answers to its
  // digit. Walking a cursor through it would be a different guess.
  const io = {
    readPromptScreen: async () =>
      "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel · Tab to amend",
    sendNavKey: async () => { throw new Error("must not send keys"); },
    sendChars: async () => { throw new Error("must not send keys"); },
    sendOptionKey: async () => {},
    settle: async () => {},
  };
  const r = await selectByCursor("w1:p1", "1", true, io as never);
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("cursor");
});

/**
 * Moving without committing.
 *
 * Reported from a phone: "I click 2 with purpose choose option 2 to add note
 * but it send immediately." A permission prompt SHOULD answer on one tap — that
 * is what paddock is for. A question dialog is deliberative: it carries a
 * preview panel and a notes field, and the operator is choosing before they
 * commit. The TUI itself is two steps, arrows then Enter, and paddock now
 * matches it rather than collapsing them.
 */
test("moving the cursor without committing sends no Enter", async () => {
  const d = fakeDialog(1);
  const r = await selectByCursor("w1:p1", "3", false, d.io as never);
  expect(r.ok).toBe(true);
  expect(d.committedValue()).toBeNull();
  expect(d.keys).not.toContain("enter");
});

test("moving the cursor still lands on the option asked for", async () => {
  const d = fakeDialog(1);
  await selectByCursor("w1:p1", "2", false, d.io as never);
  // Committing afterwards must take the row the move reached.
  await selectByCursor("w1:p1", "2", true, d.io as never);
  expect(d.committedValue()).toBe(2);
});

test("a move onto the option already under the cursor does nothing at all", async () => {
  const d = fakeDialog(2);
  const r = await selectByCursor("w1:p1", "2", false, d.io as never);
  expect(r.ok).toBe(true);
  expect(d.keys).toEqual([]);
  expect(d.committedValue()).toBeNull();
});
