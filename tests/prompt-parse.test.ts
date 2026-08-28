import { expect, test } from "bun:test";
import { parsePrompt, selectedLine } from "@server/herdr/prompt-parse";

// Structure copied from a real Claude Code permission prompt; content invented.
const REAL_SHAPE = `
 Bash command

   echo hello > /srv/project/out.txt
   Write a greeting to a file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to project/ from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

test("parses the real prompt shape", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.question).toBe("Do you want to proceed?");
  expect(p.options).toHaveLength(3);
  expect(p.options![0]).toEqual({ key: "1", label: "Yes", selected: true });
});

// The whole reason paddock renders real labels: this option is a persistent
// policy change, and a generic "Approve" would be ambiguous against option 1.
test("keeps a long option label verbatim, never truncated or summarised", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.options![1]!.label).toBe("Yes, and always allow access to project/ from this project");
});

test("marks only the option the cursor sits on", () => {
  const p = parsePrompt(REAL_SHAPE);
  expect(p.options!.map((o) => o.selected)).toEqual([true, false, false]);
});

test("handles the cursor on a non-first option", () => {
  const p = parsePrompt("Continue?\n  1. Yes\n ❯ 2. No\n");
  expect(p.options!.map((o) => o.selected)).toEqual([false, true]);
});

test("parses a four-option prompt", () => {
  const p = parsePrompt("Pick one?\n ❯ 1. A\n   2. B\n   3. C\n   4. D\n");
  expect(p.options!.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
});

test("returns options: null when there is no prompt at all", () => {
  const p = parsePrompt("just some output\nand another line\n");
  expect(p.options).toBeNull();
  expect(p.raw).toContain("just some output");
});

// A truncated capture must not yield a half-list the operator could tap.
test("returns options: null when the numbering is not a contiguous run from 1", () => {
  expect(parsePrompt("Proceed?\n   2. Yes\n   3. No\n").options).toBeNull();
  expect(parsePrompt("Proceed?\n   1. Yes\n   3. No\n").options).toBeNull();
});

test("returns options: null for a single option", () => {
  // One option is ambiguous — it is as likely to be a numbered list in output.
  expect(parsePrompt("Note?\n   1. Only\n").options).toBeNull();
});

test("takes the question nearest the options, not the first question in the buffer", () => {
  const p = parsePrompt("Earlier question?\n  some output\n\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\n");
  expect(p.question).toBe("Do you want to proceed?");
});

test("always returns raw, even when parsing fails", () => {
  expect(parsePrompt("nothing here").raw).toBe("nothing here");
});

// Finding: a flat scan across the whole buffer can concatenate a stray
// numbered line from earlier output onto a later, otherwise non-contiguous
// menu and make the combined run look contiguous — silently attaching a
// foreign line as "option 1". Scoping to the LAST contiguous run closes this.
test("does not splice a stray numbered line from earlier output onto a later menu", () => {
  const p = parsePrompt(
    "Old numbered output\n1. something\n\nProceed?\n   2. Yes\n   3. No\n",
  );
  expect(p.options).toBeNull();
});

test("returns options: null when options-shaped content has no question line", () => {
  const p = parsePrompt("   1. Yes\n   2. No\n");
  expect(p.options).toBeNull();
  expect(p.question).toBeNull();
});

// The scrollback case: a resolved earlier prompt sits above the live menu.
// Only the live menu's options may be returned, identified by label, not
// just count — both menus here have the same number of options.
test("returns only the current menu's options when a resolved prompt precedes it", () => {
  const p = parsePrompt(
    "Earlier question?\n ❯ 1. Yes\n   2. No\n\nDo you want to proceed?\n ❯ 1. Approve\n   2. Reject\n",
  );
  expect(p.question).toBe("Do you want to proceed?");
  expect(p.options!.map((o) => o.label)).toEqual(["Approve", "Reject"]);
});

// Finding: a stale question from an already-resolved run must not attach to
// a later run when no fresh question line separates them — otherwise the
// operator reads a foreign caption and could approve something they never
// intended. With no question of its own, this run correctly yields null.
test("does not let a stale question from an earlier run attach to a later one", () => {
  const p = parsePrompt("Old question?\n1. Yes\n2. No\n\n ❯ 1. Approve\n2. Reject\n");
  expect(p.question).not.toBe("Old question?");
  expect(p.options).toBeNull();
});

// The post-loop fallback: a buffer can end mid-run, with no trailing
// newline or other line after the menu to close it out.
test("parses a menu that ends the buffer with no trailing newline", () => {
  const p = parsePrompt("Pick one?\n ❯ 1. A\n   2. B");
  expect(p.options!.map((o) => o.label)).toEqual(["A", "B"]);
});

// ── the selected line ──────────────────────────────────────────────────────
// Independent of whether the option LIST parsed. The keypad's ↓ wraps from the
// last option back to the first, and the middle option of a permission prompt
// is routinely a persistent grant — so one tap too many can commit a standing
// permission. The wrap is not the danger; the wrap being INVISIBLE is. Showing
// what Enter will commit removes it, and works on prompt shapes the list
// parser cannot read at all.

test("the cursor line is reported for a permission prompt", () => {
  const raw = [
    " Do you want to proceed?",
    "   1. Yes",
    " ❯ 2. Yes, and don't ask again for: build *",
    "   3. No",
  ].join("\n");
  expect(parsePrompt(raw).selected).toBe("2. Yes, and don't ask again for: build *");
});

test("the cursor line is reported even when the option LIST cannot be parsed", () => {
  // The shape that defeats the list parser: each option followed by indented
  // description lines, so no two options are contiguous. The list is null and
  // the selection is still known — which is the whole point.
  const raw = [
    "Which approach should we take?",
    " ❯ 1. Add the index now (Recommended)",
    "      Costs one migration, pays off immediately.",
    "   2. Defer until the next release",
    "      Cheaper today, more work later.",
    "─────────────────────────────",
    "   3. Chat about this",
  ].join("\n");
  const p = parsePrompt(raw);
  expect(p.options).toBeNull();
  expect(p.selected).toBe("1. Add the index now (Recommended)");
});

test("no cursor means no selection, rather than a guess at the first option", () => {
  const raw = ["Proceed?", "   1. Yes", "   2. No"].join("\n");
  expect(parsePrompt(raw).selected).toBeNull();
});

test("the LAST cursor wins, since the live prompt is at the bottom", () => {
  // A resolved earlier prompt can still be in the snapshot with its marker.
  const raw = [
    " ❯ 1. An older, already-answered choice",
    "   some output since",
    " Do you want to proceed?",
    "   1. Yes",
    " ❯ 2. No",
  ].join("\n");
  expect(parsePrompt(raw).selected).toBe("2. No");
});

test("an empty snapshot has no selection", () => {
  expect(parsePrompt("").selected).toBeNull();
});

test("a cursor on a non-option line is still reported", () => {
  // Some prompts mark a free-text row. Reporting it verbatim beats reporting
  // nothing: the operator sees what Enter will do either way.
  expect(parsePrompt(" ❯ Type something").selected).toBe("Type something");
});

test("the cursor is found even when the line carries ANSI escapes", () => {
  // The two callers read with different settings: `/prompt` strips ANSI, but
  // `/key` re-reads the live screen with colour KEPT, so the cursor line
  // begins with escape bytes rather than whitespace. Matching only clean text
  // made the preview work on load and then vanish on the first arrow-down —
  // precisely when it is protecting against arrowing one step too far.
  const raw = [
    "\x1b[0m Do you want to proceed?",
    "\x1b[2m   1. Yes\x1b[0m",
    "\x1b[1m\x1b[38;2;255;255;255m \u276f 2. Yes, and always allow: curl *\x1b[0m",
    "\x1b[2m   3. No\x1b[0m",
  ].join("\n");
  expect(selectedLine(raw)).toBe("2. Yes, and always allow: curl *");

  // And the MENU parses from the same coloured buffer. This is the half the
  // route test could not pin: under the old cursor-only stripping, OPTION_RE
  // never matched a coloured line, `options` was null, and the bare scan
  // returned the same string — so the assertion above passed either way.
  const p = parsePrompt(raw);
  expect(p.question).toBe("Do you want to proceed?");
  expect(p.options?.map((o) => o.label)).toEqual([
    "Yes", "Yes, and always allow: curl *", "No",
  ]);
});

test("selectedLine agrees with parsePrompt when the marker is on the live menu", () => {
  // They agree on this input and are MEANT to diverge on others: the bare scan
  // takes the last marker anywhere, while parsePrompt scopes to the menu that
  // produced the options. See "a marker left on an answered question\u2026" below
  // for the case where agreeing would be the bug.
  const raw = [" Proceed?", "   1. Yes", " \u276f 2. No"].join("\n");
  expect(selectedLine(raw)).toBe(parsePrompt(raw).selected);
});

test("a marker left on an answered question is not attributed to the live menu", () => {
  // The shape that produced this, found on a phone: one box asking several
  // questions in sequence. Answering the first leaves its marker on screen,
  // and the menu now awaiting an answer carries no marker yet — so the last
  // marker in the buffer belongs to a DIFFERENT question than the options do.
  //
  // Reporting it tells the operator Enter will commit something it will not,
  // which is the one thing this field exists to prevent. Silence is correct
  // here: the buttons above it already show what can be chosen.
  const raw = [
    " Which approach?",
    " ❯ 1. Merge locally",
    "   2. Create a pull request",
    "",
    " Collapse the keypad?",
    "   1. Leave it visible",
    "   2. Collapse it",
  ].join("\n");
  const p = parsePrompt(raw);
  expect(p.options?.map((o) => o.label)).toEqual(["Leave it visible", "Collapse it"]);
  expect(p.selected).toBeNull();
});

test("a cursor on a free-text row below a menu is still reported", () => {
  // The scoping fix went one step too far. Suppressing the bare scan whenever a
  // menu parses also suppressed a marker that is NOT another question's answer:
  // some prompts park the cursor on an input row under the options, and Enter
  // then submits text rather than an option. CURSOR_RE was widened for exactly
  // this ("reporting that verbatim beats reporting nothing").
  //
  // The distinction that keeps both fixes: an OPTION-SHAPED marker outside the
  // live run can only belong to a question already answered, while a
  // non-option-shaped one can only be the live input row.
  const raw = [
    " Do you want to proceed?",
    "   1. Yes",
    "   2. No",
    " ❯ Type something",
  ].join("\n");
  const p = parsePrompt(raw);
  expect(p.options?.map((o) => o.label)).toEqual(["Yes", "No"]);
  expect(p.selected).toBe("Type something");
});

test("a parsed screen carries the question dialog, so no re-read can go stale", () => {
  // WHY THIS LIVES HERE rather than at the route. `/prompt` is fetched once per
  // state change and never polled, so a dialog parsed only there is stale the
  // instant a key lands — a checkbox disagreeing with the agent is the lying
  // control this project refuses. `/key` re-reads the screen and calls this
  // function for `selected` already; composing the dialog here is what makes
  // every re-read path carry a fresh one without having to remember to.
  const screen = [
    "←  ☐ Tea  ✔ Submit  →",
    "",
    "Which teas do you drink?",
    "",
    "❯ 1. [ ] Green tea",
    "  Light and grassy, lower caffeine.",
    "  2. [ ] Type something",
    "     Submit",
  ].join("\n");

  const p = parsePrompt(screen);

  // The old parser still refuses this shape, and must keep refusing: each
  // option is followed by a description line, which ends its option run. That
  // refusal is what put a phone in front of a dialog with no buttons.
  expect(p.options, "the general parser is unchanged").toBeNull();
  expect(p.dialog).not.toBeNull();
  expect(p.dialog!.mode).toBe("multi");
  expect(p.dialog!.options[1]!.freeText).toBe(true);
});

test("an ordinary prompt reports no dialog at all", () => {
  const p = parsePrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");

  expect(p.options, "this one the general parser reads fine").not.toBeNull();
  expect(p.dialog, "and there is no dialog to report").toBeNull();
});
