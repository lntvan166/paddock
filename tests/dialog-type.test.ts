import { expect, test } from "bun:test";
import { typeIntoFreeText } from "@server/herdr/dialog-type";

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
    `  ${mark("advance")}  Submit`,
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

test("a single-select dialog is refused outright", async () => {
  // Measured: in single-select the row is not live — characters are ignored —
  // and Enter on it while empty DECLINES the entire dialog. So there is nothing
  // to type into, and a real hazard in pretending otherwise.
  const single = io([[
    "←  ☒ Fruit  ✔ Submit  →",
    "",
    "Which is your single favourite fruit?",
    "",
    "❯ 1. Mango",
    "     Sweet, tropical, and unmistakable.",
    "  2. Type something.",
  ].join("\n")]);

  const out = await typeIntoFreeText("w1:p1", ["h"], single);

  expect(out.ok).toBe(false);
  expect(out.detail).toContain("single");
  expect(single.keys).toEqual([]);
  expect(single.typed).toEqual([]);
});
