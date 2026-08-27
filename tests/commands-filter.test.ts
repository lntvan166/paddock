import { expect, test } from "bun:test";
import { commandQuery, filterCommands, replaceCommandToken } from "@web/commands";
import type { AgentCommand } from "@shared/types";

const cmd = (command: string, description: string | null = null): AgentCommand => ({
  command,
  description,
  source: "command",
});

const ALL: readonly AgentCommand[] = [
  cmd("/check", "Run the project's checks"),
  cmd("/eod", "Write the end-of-day summary"),
  cmd("/changelog", "Update the changelog from recent commits"),
  { command: "/review", description: "Review the working tree", source: "skill" },
];

// ---- the trigger -----------------------------------------------------------
//
// What decides whether the list is open at all. It is deliberately the FIELD's
// whole value, not a keystroke: a reply that merely contains a slash — "look in
// src/web" — must not open a command list, and the only way to know that is to
// look at where the slash is.

test("a leading slash opens the list", () => {
  expect(commandQuery("/")).toBe("");
  expect(commandQuery("/ch")).toBe("ch");
});

test("a slash anywhere else is just text", () => {
  expect(commandQuery("look in src/web")).toBeNull();
  expect(commandQuery("yes")).toBeNull();
  expect(commandQuery("")).toBeNull();
});

test("a command with an argument stops offering the list", () => {
  // Once a space is typed the term is settled and the argument is being
  // written. Continuing to filter would fight the operator for the field.
  expect(commandQuery("/review HEAD~1")).toBeNull();
});

test("leading whitespace does not defeat the trigger", () => {
  // A phone keyboard inserts a space after autocorrect more often than anyone
  // would like.
  expect(commandQuery("  /ch")).toBe("ch");
});

// ---- the filter ------------------------------------------------------------

test("an empty term offers everything", () => {
  expect(filterCommands(ALL, "")).toHaveLength(4);
});

test("a term matches the command name", () => {
  expect(filterCommands(ALL, "ch").map((c) => c.command)).toEqual([
    "/check",
    "/changelog",
  ]);
});

test("matching is case-insensitive", () => {
  expect(filterCommands(ALL, "EOD").map((c) => c.command)).toEqual(["/eod"]);
});

test("a prefix match ranks above a mid-word one", () => {
  // Typing `og` should still find `/changelog`, but anything starting with
  // `og` would belong first. Ordering is the whole value of a filter on a
  // phone: the first row is the one a thumb reaches without reading.
  const ranked = filterCommands([cmd("/changelog"), cmd("/ogre")], "og");
  expect(ranked.map((c) => c.command)).toEqual(["/ogre", "/changelog"]);
});

test("the description is searched too, after the name", () => {
  // "commits" appears only in /changelog's description.
  expect(filterCommands(ALL, "commits").map((c) => c.command)).toEqual([
    "/changelog",
  ]);
});

test("a term that matches nothing offers nothing", () => {
  // Not "everything": a list that ignores the term looks broken, and on a
  // phone it puts an unrelated command under the thumb.
  expect(filterCommands(ALL, "zzz")).toEqual([]);
});

// ---- the trigger, anywhere in the field ------------------------------------
//
// A command no longer has to open the reply. What still must NOT trigger is a
// slash inside a word — `src/web` — which is why the rule is "start of field or
// after whitespace", the same rule @-mentions use everywhere.

test("a command mid-sentence triggers, when the slash follows a space", () => {
  expect(commandQuery("please run /ch")).toBe("ch");
  expect(commandQuery("first /")).toBe("");
});

test("a slash inside a word still triggers nothing", () => {
  expect(commandQuery("look in src/web")).toBeNull();
  expect(commandQuery("a/b")).toBeNull();
  expect(commandQuery("http://example.com")).toBeNull();
});

test("the term ends at the caret, not at the end of the field", () => {
  // Editing in the middle: the caret sits after `/ch`, and the rest of the
  // line is not part of what is being searched.
  expect(commandQuery("/changelog later", 3)).toBe("ch");
  expect(commandQuery("run /ch now", 7)).toBe("ch");
});

test("a completed command followed by a space triggers nothing", () => {
  expect(commandQuery("/changelog ")).toBeNull();
  expect(commandQuery("/changelog and then")).toBeNull();
});

// ---- picking splices the token, and nothing else --------------------------

test("picking replaces only the command being typed", () => {
  expect(replaceCommandToken("please run /ch", 14, "/changelog")).toEqual({
    value: "please run /changelog ",
    caret: 22,
  });
});

test("text after the caret survives a pick", () => {
  // The regression this guards: replacing the whole field would delete the
  // words the operator had already written after the command.
  expect(replaceCommandToken("/ch the second one", 3, "/changelog")).toEqual({
    value: "/changelog  the second one",
    caret: 11,
  });
});

test("picking at the very start behaves as it always did", () => {
  expect(replaceCommandToken("/ch", 3, "/changelog")).toEqual({
    value: "/changelog ",
    caret: 11,
  });
});
