import { expect, test } from "bun:test";
import { moveDialogTab, toggleDialogOption, typeIntoFreeText } from "@server/herdr/dialog-type";

/** `cursorOn` names the row the `❯` sits on: an option key, or "advance". */
function screen(cursorOn: string) {
  const mark = (row: string) => (row === cursorOn ? "❯" : " ");
  return [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    `${mark("1")} 1. [ ] Green tea`,
    "  Light and grassy, lower caffeine.",
    `${mark("2")} 2. [ ] Black tea`,
    "  Strong and malty, takes milk well.",
    `${mark("3")} 3. [ ] Type something`,
    `${mark("advance")}    Submit`,
  ].join("\n");
}

/** A two-question dialog showing whichever question `on` names. */
function tabScreen(on: "Teas" | "Strength") {
  return on === "Teas"
    ? [
      "←  ☐ Teas  ☐ Strength  ✔ Submit  →",
      "",
      "Which types of tea do you enjoy?",
      "",
      "❯ 1. [ ] Black tea",
      "  Fully oxidized and malty.",
      "  2. [ ] Type something",
      "     Next",
    ].join("\n")
    : [
      "←  ☒ Teas  ☐ Strength  ✔ Submit  →",
      "",
      "How strong do you like your tea?",
      "",
      "❯ 1. Light",
      "     Short steep.",
      "  2. Strong",
      "     Long steep.",
    ].join("\n");
}

/** Answers each read from a queue, so a move can change what the next read sees. */
function io(reads: string[]) {
  const keys: string[] = [];
  const typed: string[][] = [];
  let i = 0;
  return {
    keys, typed,
    async readPromptScreen() { return reads[Math.min(i++, reads.length - 1)]!; },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars(_t: string, c: string[]) { typed.push(c); },
    async sendOptionKey(_t: string, k: string) { keys.push(`digit:${k}`); },
  };
}

test("with the cursor already on the row, it types and moves nothing", async () => {
  const x = io([screen("3")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(true);
  expect(x.keys, "no keystroke the operator did not ask for").toEqual([]);
  expect(x.typed).toEqual([["h", "i"]]);
});

test("it walks down to the row, then re-reads before typing", async () => {
  // Two downs from option 1 to option 3 — and the SECOND read is what licenses
  // the typing. Counting presses against a screen that has since changed is how
  // an off-by-one becomes a wrong answer to a real question.
  const x = io([screen("1"), screen("3")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(true);
  expect(x.keys).toEqual(["down", "down"]);
  expect(x.typed).toEqual([["h", "i"]]);
});

test("it walks UP when the cursor sits below the row", async () => {
  const x = io([screen("advance"), screen("3")]);

  await typeIntoFreeText("w1:p1", ["h"], x);

  expect(x.keys).toEqual(["up"]);
});

test("if the cursor did not arrive, nothing is typed and it says so", async () => {
  // THE failure this function exists for. Typing into the wrong row edits an
  // option label the operator never chose, or is swallowed silently.
  const x = io([screen("1"), screen("1")]);

  const out = await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(out.ok).toBe(false);
  expect(out.detail).toContain("text row");
  expect(x.typed, "not a single character").toEqual([]);
});

test("no dialog, or no free-text row in it, is refused before any key is sent", async () => {
  const noDialog = io(["Do you want to proceed?\n❯ 1. Yes\n  2. No"]);
  expect((await typeIntoFreeText("w1:p1", ["h"], noDialog)).ok).toBe(false);
  expect(noDialog.keys).toEqual([]);

  const noRow = io([[
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n")]);
  expect((await typeIntoFreeText("w1:p1", ["h"], noRow)).ok).toBe(false);
  expect(noRow.typed).toEqual([]);
});

test("a single-select dialog takes typed text too", async () => {
  // An earlier version refused this, on a measurement that was wrong: the moves
  // and the characters went out in one batch, so the characters arrived before
  // the cursor. Re-measured one key at a time against a live agent, the row
  // takes the text and Enter submits it.
  const single = io([[
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Which is your single favourite fruit?",
    "",
    "❯ 1. Mango",
    "     Sweet, tropical, and unmistakable.",
    "  2. Type something.",
  ].join("\n"), [
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Which is your single favourite fruit?",
    "",
    "  1. Mango",
    "     Sweet, tropical, and unmistakable.",
    "❯ 2. Type something.",
  ].join("\n")]);

  const out = await typeIntoFreeText("w1:p1", ["k", "i", "w", "i"], single);

  expect(out.ok).toBe(true);
  expect(single.typed).toEqual([["k", "i", "w", "i"]]);
  // Never Enter: on an EMPTY row that declines the whole dialog, and committing
  // is the operator's call either way.
  expect(single.keys.includes("enter"), "typing never commits").toBe(false);
});

/**
 * Moving between questions, which is where "sometimes not work" lived.
 *
 * A nav key plus one fixed pause is a GUESS about how fast a TUI repaints. When
 * the guess was wrong the re-read returned the previous question, the UI
 * rendered it, and the tap looked ignored — intermittently, which is the worst
 * way for it to fail. This waits until the question actually changes, up to a
 * bound.
 */

test("it waits until the question actually changes", async () => {
  // The repaint lands on the SECOND look. A single settle would have returned
  // the old question and reported success.
  const order: string[] = [];
  const reads = [tabScreen("Teas"), tabScreen("Teas"), tabScreen("Strength")];
  let i = 0;
  const x = {
    async readPromptScreen() { order.push("read"); return reads[Math.min(i++, reads.length - 1)]!; },
    async sendNavKey(_t: string, k: string) { order.push(`key:${k}`); },
    async sendChars() {},
    async sendOptionKey() {},
    async settle() { order.push("settle"); },
  };

  const out = await moveDialogTab("w1:p1", "right", x);

  expect(out.ok).toBe(true);
  expect(out.dialog?.question).toBe("How strong do you like your tea?");
  expect(order).toEqual([
    "read", "key:right", "settle", "read", "settle", "read",
  ]);
});

test("it gives up after a bounded number of looks, rather than hanging", async () => {
  // Moving right from the last tab legitimately changes nothing. That is not a
  // failure and must not spin: it reports the screen as it stands.
  let looks = 0;
  const x = {
    async readPromptScreen() { looks++; return tabScreen("Teas"); },
    async sendNavKey() {},
    async sendChars() {},
    async sendOptionKey() {},
    async settle() {},
  };

  const out = await moveDialogTab("w1:p1", "right", x);

  expect(out.ok).toBe(true);
  expect(out.dialog?.question, "unchanged, and said so honestly").toBe("Which types of tea do you enjoy?");
  expect(looks, "bounded").toBeLessThanOrEqual(6);
});

test("with no dialog on screen there is nothing to move between", async () => {
  const x = {
    async readPromptScreen() { return "Do you want to proceed?\n❯ 1. Yes\n  2. No"; },
    async sendNavKey() { throw new Error("must not send a key"); },
    async sendChars() {},
    async sendOptionKey() {},
    async settle() {},
  };

  const out = await moveDialogTab("w1:p1", "left", x);

  expect(out.ok).toBe(false);
  expect(out.detail).toContain("dialog");
});

/**
 * Toggling an option, which is a digit — and a digit is only a toggle when the
 * cursor is not sitting on the free-text row.
 *
 * Found on a phone: with the cursor left on that row after typing, tapping an
 * option APPENDED its digit to the typed answer. `4. [✔] 2` became `4. [✔] 21`
 * and option 1 never moved. A control that silently edits a different answer is
 * the worst failure this feature has had.
 */

/** The multi-select question with the cursor wherever `on` says. */
function optScreen(on: string) {
  const mark = (row: string) => (row === on ? "❯" : " ");
  return [
    "←  ☐ Teas  ☐ Strength  ✔ Submit  →",
    "",
    "Which types of tea do you enjoy?",
    "",
    `${mark("1")} 1. [ ] Black tea`,
    "  Fully oxidized and malty.",
    `${mark("2")} 2. [ ] Green tea`,
    "  Grassy and light.",
    `${mark("3")} 3. [ ] typed answer`,
    `${mark("advance")}    Next`,
  ].join("\n");
}

test("with the cursor on an option, the digit goes straight out", async () => {
  // The fast path, and the common one: a digit toggles exactly its own option
  // and moves nothing.
  const keys: string[] = [];
  const x = {
    async readPromptScreen() { return optScreen("1"); },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars() {},
    async sendOptionKey(_t: string, k: string) { keys.push(`digit:${k}`); },
    async settle() {},
  };

  const out = await toggleDialogOption("w1:p1", "2", x);

  expect(out.ok).toBe(true);
  expect(keys, "no navigation needed").toEqual(["digit:2"]);
});

test("with the cursor on the TEXT row, it is moved off before the digit", async () => {
  // Otherwise the digit is text, not a toggle.
  const keys: string[] = [];
  let i = 0;
  const reads = [optScreen("3"), optScreen("1")];
  const x = {
    async readPromptScreen() { return reads[Math.min(i++, 1)]!; },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars() {},
    async sendOptionKey(_t: string, k: string) { keys.push(`digit:${k}`); },
    async settle() {},
  };

  const out = await toggleDialogOption("w1:p1", "2", x);

  expect(out.ok).toBe(true);
  // Off to the FIRST option, which is deterministic and cannot itself be the
  // text row — then the digit, which toggles its own option from anywhere that
  // is not an input.
  expect(keys).toEqual(["up", "up", "digit:2"]);
});

test("if the cursor cannot be moved off the text row, no digit is sent", async () => {
  // Sending it anyway would edit the operator's typed answer.
  const keys: string[] = [];
  const x = {
    async readPromptScreen() { return optScreen("3"); },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars() {},
    async sendOptionKey(_t: string, k: string) { keys.push(`digit:${k}`); },
    async settle() {},
  };

  const out = await toggleDialogOption("w1:p1", "2", x);

  expect(out.ok).toBe(false);
  expect(keys.some((k) => k.startsWith("digit")), "never a blind digit").toBe(false);
});

test("a tab move steps off the text row first, or the arrow never reaches the tabs", async () => {
  // THE THIRD key whose meaning changes on that row, after the digit and the
  // space. Measured on a live agent: with the cursor on `❯ 4. rất mạnh`, `right`
  // did nothing at all — the row is an input, so the arrow moved the text caret.
  // One `up` first, and the very next `right` reached Submit.
  const keys: string[] = [];
  let i = 0;
  const reads = [optScreen("3"), optScreen("1"), optScreen("1")];
  const x = {
    async readPromptScreen() { return reads[Math.min(i++, reads.length - 1)]!; },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars() {},
    async sendOptionKey() {},
    async settle() {},
  };

  await moveDialogTab("w1:p1", "right", x);

  expect(keys[0], "off the text row before anything else").toBe("up");
  expect(keys.includes("right"), "and then the arrow").toBe(true);
});

test("with the cursor already on an option, a tab move sends only the arrow", async () => {
  const keys: string[] = [];
  const x = {
    async readPromptScreen() { return optScreen("1"); },
    async sendNavKey(_t: string, k: string) { keys.push(k); },
    async sendChars() {},
    async sendOptionKey() {},
    async settle() {},
  };

  await moveDialogTab("w1:p1", "left", x);

  expect(keys).toEqual(["left"]);
});

test("typing REPLACES what is in the row, rather than appending to it", async () => {
  // Reported from a phone: "first i type Trái dừa, then i type Trái cây and add
  // again, i think it will replace but it append. So if I type wrong i cant
  // fix". Typing is characters, and characters land after what is already
  // there — so a correction became a concatenation and there was no way back.
  const sent: string[][] = [];
  const withText = (typed: string) => [
    "←  ☐ Teas  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    "  1. [ ] Green tea",
    "  Light and grassy.",
    `❯ 2. [✔] ${typed}`,
    "     Next",
  ].join("\n");
  const x = {
    async readPromptScreen() { return withText("dừa"); },
    async sendNavKey() {},
    async sendChars(_t: string, c: string[]) { sent.push(c); },
    async sendOptionKey() {},
    async settle() {},
  };

  const out = await typeIntoFreeText("w1:p1", ["c", "â", "y"], x);

  expect(out.ok).toBe(true);
  // Three characters in the row, so three backspaces, then the new text — one
  // call, because `send_keys` takes a list and a name like `backspace` rides in
  // it beside the characters.
  expect(sent).toEqual([["backspace", "backspace", "backspace", "c", "â", "y"]]);
});

test("an untouched row is written without erasing anything first", async () => {
  const sent: string[][] = [];
  const x = {
    async readPromptScreen() { return screen("3"); },
    async sendNavKey() {},
    async sendChars(_t: string, c: string[]) { sent.push(c); },
    async sendOptionKey() {},
    async settle() {},
  };

  await typeIntoFreeText("w1:p1", ["h", "i"], x);

  expect(sent).toEqual([["h", "i"]]);
});
