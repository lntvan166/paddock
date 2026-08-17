import { expect, test } from "bun:test";
import { parsePrompt } from "@server/herdr/prompt-parse";

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
