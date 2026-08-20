import { expect, test } from "bun:test";
import {
  clamp, MAX_TEXT_CHARS, stripAnsi, stripInjected, stripMenu, summariseTool,
  summariseTools, toLines,
} from "@server/journal/text";

test("ansi escapes are removed", () => {
  expect(stripAnsi("[1;36mhello[0m")).toBe("hello");
});

test("a cursor marker is stripped from journal text", () => {
  // THE hazard. A journal turn can carry an ALREADY ANSWERED menu, and blended
  // straight above the live screen it reads as the question being asked now.
  // `prompt-parse.ts` records this exact failure. Only the live screen may
  // render a selectable menu.
  expect(stripMenu("❯ 1. Yes")).toBe("");
  expect(stripMenu("  ❯ 2. No, keep it")).toBe("");
});

test("a numbered option row is stripped even without a cursor", () => {
  expect(stripMenu("  2. No")).toBe("");
  expect(stripMenu("1. Approve this change")).toBe("");
});

test("a real multi-line menu is stripped down to its question", () => {
  // THE decisive case. A real prompt is a question plus two or more option
  // lines, not one bare option line on its own — an anchored ^...$ match
  // against the WHOLE turn text only ever fires on the single-line toy case.
  expect(
    stripMenu("Do you want to proceed?\n❯ 1. Yes\n  2. No, tell it what to do differently"),
  ).toBe("Do you want to proceed?");
});

test("an ASCII > cursor is treated like ❯", () => {
  expect(stripMenu("> 1. Yes")).toBe("");
});

test("a ) separator is accepted alongside .", () => {
  expect(stripMenu("2) No")).toBe("");
});

test("an option row survives no matter how long its label is", () => {
  // Length must not decide whether a row is an option: a long real option is
  // still an option.
  expect(
    stripMenu("❯ 1. Yes, and also run the full regression suite before merging"),
  ).toBe("");
});

test("a cursor sitting on ordinary prose is kept, not stripped", () => {
  // A cursor glyph quoting a shell prompt is not the hazard this guards —
  // deleting it would silently eat real content, the worse failure.
  expect(stripMenu("❯ npm install")).toBe("❯ npm install");
});

test("a lettered option is stripped only when a cursor marks it", () => {
  expect(stripMenu("❯ a. Yes")).toBe("");
  expect(stripMenu("a. done")).toBe("a. done");
});

test("ordinary prose that merely starts with a number survives", () => {
  // Over-stripping would silently eat real content, which is worse than the
  // hazard it guards: "2. " here is prose the agent wrote, not an option row.
  expect(stripMenu("2026 was the year")).toBe("2026 was the year");
  expect(stripMenu("I found 3 failures")).toBe("I found 3 failures");
});

test("a tool call becomes a name and a short hint, never its output", () => {
  expect(summariseTool("Bash", { command: "bun test", description: "run tests" }))
    .toBe("Bash · run tests");
  expect(summariseTool("Read", { file_path: "/srv/project/src/timer.ts" }))
    .toBe("Read · timer.ts");
  expect(summariseTool("Write", {})).toBe("Write");
});

test("a tool hint never carries a whole command line", () => {
  // The hint is orientation, not a transcript. An unbounded command would put
  // arbitrary shell text — and anything interpolated into it — on the wire.
  const long = "x".repeat(500);
  expect(summariseTool("Bash", { description: long }).length).toBeLessThanOrEqual(80);
});

test("clamp truncates to AT MOST max characters, ellipsis included", () => {
  // The ellipsis counts. A clamp that returns max+1 makes every caller's cap
  // a lie by one character, which is how `summariseTool` would exceed its own.
  expect(clamp("abcdef", 3)).toBe("ab…");
  expect(clamp("abcdef", 3).length).toBe(3);
  expect(clamp("abc", 10)).toBe("abc");
});

test("toLines renders a turn with a speaker and folds its tools", () => {
  const lines = toLines([
    { role: "user", at: "2026-08-20T13:04:00Z", text: "fix the flaky test", tools: [] },
    { role: "assistant", at: "2026-08-20T13:05:00Z", text: "Found it: the timer resets.", tools: ["Bash ×3", "Read timer.ts"] },
  ]);
  expect(lines).toEqual([
    "you · 13:04",
    "fix the flaky test",
    "",
    "agent · 13:05",
    "▸ Bash ×3 · Read timer.ts",
    "Found it: the timer resets.",
    "",
  ]);
});

test("toLines drops a turn left empty by stripping", () => {
  // A turn that was only a menu must not leave a bare speaker line behind.
  expect(toLines([{ role: "assistant", at: null, text: "", tools: [] }])).toEqual([]);
});

test("the text cap is bounded", () => {
  expect(MAX_TEXT_CHARS).toBe(4_000);
});

test("a search pattern is never used as a hint", () => {
  // A pattern is operator-supplied text that routinely embeds the very thing
  // being searched for. Design decision 4 bounds this route at the SOURCE, so
  // the field is not on the hint allow-list at all — a bare tool name is the
  // whole orientation this line owes anyone.
  expect(summariseTool("Grep", { pattern: "AKIA_SECRET_KEY_SHAPE" })).toBe("Grep");
  expect(summariseTool("Grep", { pattern: "x" })).not.toContain("x");
});

test("a run of the same tool collapses to one ×N token", () => {
  // `src/server/journal/types.ts` and the design's §4 both promise `Bash ×3`.
  // Un-aggregated, three calls rendered as `Bash · x · Bash · y · Bash · z` —
  // the promise false, and the longest possible line on the narrowest screen.
  expect(summariseTools([
    { name: "Bash", input: { description: "one" } },
    { name: "Bash", input: { description: "two" } },
    { name: "Bash", input: { description: "three" } },
    { name: "Read", input: { file_path: "/srv/project/src/timer.ts" } },
  ])).toEqual(["Bash ×3", "Read · timer.ts"]);
});

test("aggregation keeps call order rather than totalling", () => {
  // A sequence of what happened, not a frequency table: two separate runs of
  // the same tool stay two tokens, in the order they were called.
  expect(summariseTools([
    { name: "Read", input: {} },
    { name: "Bash", input: {} },
    { name: "Bash", input: {} },
    { name: "Read", input: {} },
  ])).toEqual(["Read", "Bash ×2", "Read"]);
});

test("a single call still carries its hint", () => {
  expect(summariseTools([{ name: "Bash", input: { description: "run tests" } }]))
    .toEqual(["Bash · run tests"]);
});

test("journal times are the host's local clock, not UTC", () => {
  // These lines sit inches above the live screen, which shows whatever clock
  // the agent's terminal printed — local. Two clocks an inch apart, differing
  // by the machine's UTC offset, is a reader mis-ordering their own session.
  //
  // The timezone is SET here rather than inherited: `bun test` runs with TZ
  // pinned to UTC, so a test that merely read the ambient zone would pass
  // identically against the `getUTCHours` this replaced — a guard that cannot
  // fail is not a guard.
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo"; // UTC+9, no DST, so the arithmetic is fixed
    expect(toLines([
      { role: "user", at: "2026-08-20T13:04:00Z", text: "hello", tools: [] },
    ])[0]).toBe("you · 22:04");
  } finally {
    process.env.TZ = saved;
  }
});

test("every named injected block is removed, body and all", () => {
  for (const [tag, body] of [
    ["result", "SUBAGENT_RESULT_BODY"],
    ["task-notification", "NOTIFICATION_BODY"],
    ["output-file", "OUTPUT_FILE_BODY"],
    ["system-reminder", "REMINDER_BODY"],
    ["local-command-stdout", "STDOUT_BODY"],
    ["command-name", "COMMAND_NAME_BODY"],
    ["command-message", "COMMAND_MESSAGE_BODY"],
    ["command-args", "COMMAND_ARGS_BODY"],
  ] as const) {
    const out = stripInjected(`typed prose <${tag}>${body}</${tag}> more prose`);
    expect(out).not.toContain(body);
    expect(out).toContain("typed prose");
    expect(out).toContain("more prose");
  }
});

test("an injected block the harness never closed takes the rest of the record", () => {
  // A truncated block is still block content. Keeping the tail because the
  // writer did not close its own tag would leak exactly what pass 1 removes.
  expect(stripInjected("typed prose <result>UNCLOSED_BODY and on and on"))
    .not.toContain("UNCLOSED_BODY");
});

test("a closing tag with no opener takes everything before it", () => {
  // The mirror case: that text was inside the block.
  expect(stripInjected("ORPHANED_BODY</result> tail")).not.toContain("ORPHANED_BODY");
});

test("a block shape nobody has listed yet is still removed, by its NAME's shape", () => {
  // A list only covers injectors somebody has already seen; hooks and plugins
  // write into the same field with vocabularies of their own. Kebab- and
  // snake-cased names are machine-written; HTML and JSX names are not.
  expect(stripInjected("<some-future-hook>HOOK_BODY</some-future-hook>"))
    .not.toContain("HOOK_BODY");
  expect(stripInjected("<observed_from_session>PLUGIN_BODY</observed_from_session>"))
    .not.toContain("PLUGIN_BODY");
});

test("markup a person wrote is left alone", () => {
  // The false positive worth avoiding: over-stripping here deletes something
  // an operator typed. `<div>`, `<span>`, `<AgentRow>` are never touched.
  const typed = "the <div><span>row</span></div> under <AgentRow> is misaligned";
  expect(stripInjected(typed)).toBe(typed);
});

test("stripping removes a block wider than the text cap rather than truncating it", () => {
  // The unit half of the ordering rule. The half that actually pins the ORDER
  // is in tests/journal-claude.test.ts, at the call site — asserting it here,
  // where the test itself chooses when to call `stripInjected`, cannot fail on
  // an adapter that clamps first.
  const huge = "x".repeat(MAX_TEXT_CHARS * 2);
  const out = stripInjected(`hello<result>${huge}</result>`);
  expect(out).toBe("hello");
});

test("an angle-bracket placeholder in typed prose is not a block, and survives whole", () => {
  // Introduced by the shape rule and caught in review: an unbalanced kebab- or
  // snake-cased bracket in a typed message is overwhelmingly a PLACEHOLDER,
  // which is ordinary developer prose. Truncating at the opener deleted the
  // operator's actual instruction — "replace ", "run `git push origin ",
  // "if a" — and the design says over-stripping real prose is the worse of the
  // two failures.
  for (const typed of [
    "replace <old-name> with <new-name> everywhere",
    "run `git push origin <your-branch-name>` and then open the PR",
    "if a<b_c and c>d then continue with the next step",
  ]) {
    expect(stripInjected(typed)).toBe(typed);
  }
});

test("a shape-matched element is still removed when it is BALANCED", () => {
  // The concession above is scoped to unbalanced brackets only. A matched pair
  // is still machine output by its name's shape, and still goes — along with
  // everything between the tags.
  expect(stripInjected("keep me <some-future-hook>HOOK_BODY</some-future-hook> and me"))
    .toBe("keep me  and me");
  expect(stripInjected("<observed_from_session>PLUGIN_BODY</observed_from_session>tail"))
    .toBe("tail");
});

test("a NAMED block the harness truncated still takes the remainder", () => {
  // The asymmetry, stated as a test: the named list may take an opener's whole
  // remainder, because a truncated `<result>` really does mean the rest of the
  // record is machine output. The shape rule may not.
  expect(stripInjected("typed prose <result>TRUNCATED_BODY and on and on"))
    .toBe("typed prose ");
});
