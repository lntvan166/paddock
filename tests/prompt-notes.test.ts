import { expect, test } from "bun:test";
import { parsePrompt } from "@server/herdr/prompt-parse";

/**
 * The question dialog's notes field, as MEASURED on a live Claude Code agent.
 *
 * Four states were observed through `herdr agent read --source detection`, and
 * every assertion here comes from one of them:
 *
 *   closed, empty   Notes: press n to add notes
 *   open, empty     Notes: Add notes on this design…      footer gains ctrl+g
 *   open, typed     Notes: hello                          footer gains ctrl+g
 *   closed, typed   Notes: ok                             footer loses ctrl+g
 *
 * `ctrl+g to edit in VS Code` is the discriminator for OPEN, and it is not
 * cosmetic. While the field is open every keystroke types into it — a digit
 * types a digit instead of choosing an option — and Enter submits the note
 * ALONE. The probe confirmed that by quoting what it received:
 *
 *   n, type, Enter        ->  "…?"=(no option selected) notes: hello
 *   n, type, Esc, Enter   ->  "…?"="Scaffold a new Next.js app…" notes: ok
 *
 * So a paddock that opened the field and pressed Enter, with the cursor sitting
 * visibly on an option, would DISCARD the operator's choice while looking
 * correct. That is the failure this parse exists to make impossible.
 */

/** Built to the measured geometry: options left, panel from column 34. */
function dialog(notesLine: string, footer: string): string {
  return [
    "Which setup path should I use for this project?",
    "",
    "❯ 1. Scaffold a brand new         ┌──────────────────────────┐",
    "    Next.js application from      │ npx create-next-app      │",
    "    scratch here (Recommended)    └──────────────────────────┘",
    "  2. Clone an existing repository",
    `                                  ${notesLine}`,
    "",
    "  Chat about this",
    "",
    footer,
  ].join("\n");
}

const CLOSED = "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel";
const OPEN =
  "Enter to select · ↑/↓ to navigate · n to add notes · ctrl+g to edit in VS Code · Esc to cancel";

test("a dialog advertising notes reports the affordance", () => {
  expect(parsePrompt(dialog("Notes: press n to add notes", CLOSED)).notes).not.toBeNull();
});

test("a prompt with no notes affordance reports none", () => {
  // An ordinary permission prompt. Offering a notes control there would be a
  // button that sends a keystroke the dialog has no use for.
  const plain = [
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "",
    "Esc to cancel · Tab to amend",
  ].join("\n");
  expect(parsePrompt(plain).notes).toBeNull();
});

test("the closed hint is not mistaken for a note", () => {
  // "press n to add notes" is the dialog's instruction, not the operator's text.
  const n = parsePrompt(dialog("Notes: press n to add notes", CLOSED)).notes!;
  expect(n.text).toBe("");
  expect(n.open).toBe(false);
});

test("the open placeholder is not mistaken for a note", () => {
  const n = parsePrompt(dialog("Notes: Add notes on this design…", OPEN)).notes!;
  expect(n.text).toBe("");
  expect(n.open).toBe(true);
});

test("an open field is reported open, so a digit is known to type", () => {
  const n = parsePrompt(dialog("Notes: hello", OPEN)).notes!;
  expect(n.open).toBe(true);
  expect(n.text).toBe("hello");
});

test("a note kept after Esc is reported closed, with its text", () => {
  // Esc closes the field and KEEPS the note — measured. This is the state in
  // which Enter commits the option AND the note together.
  const n = parsePrompt(dialog("Notes: ok", CLOSED)).notes!;
  expect(n.open).toBe(false);
  expect(n.text).toBe("ok");
});

test("the notes line survives the preview panel being cut away", () => {
  // The hint shares the panel's column, so the cut that removes the preview
  // would remove this too. Notes are read before that cut, deliberately — and
  // the options must still come out clean.
  const p = parsePrompt(dialog("Notes: ok", CLOSED));
  expect(p.notes!.text).toBe("ok");
  expect(p.options!.map((o) => o.label)).toEqual([
    "Scaffold a brand new Next.js application from scratch here (Recommended)",
    "Clone an existing repository",
  ]);
});
