import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "@server/journal/claude";

const chunk = readFileSync("tests/fixtures/journal/claude-session.jsonl", "utf8");
const entries = claudeAdapter.parse(chunk);

test("a typed user message becomes a user turn", () => {
  expect(entries[0]).toEqual({
    role: "user", at: "2026-08-20T13:04:00Z", text: "fix the flaky test", tools: [],
  });
});

test("assistant text and its tool call arrive as one turn", () => {
  expect(entries[1]!.role).toBe("assistant");
  expect(entries[1]!.text).toBe("Looking at the timer now.");
  expect(entries[1]!.tools).toEqual(["Bash · run tests"]);
});

test("a tool RESULT is never served", () => {
  // This is where file contents, command output and secrets live. Asserted on
  // the whole parse, because one leak anywhere is the whole failure.
  expect(JSON.stringify(entries)).not.toContain("SECRET_TOKEN");
});

test("a user record whose content is a LIST is not a typed message", () => {
  // Folding these is what stops a session rendering hundreds of fabricated
  // "you" turns: tool-result traffic is written as role user.
  expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
});

test("thinking blocks are dropped", () => {
  expect(JSON.stringify(entries)).not.toContain("private reasoning");
});

test("subagent traffic is dropped", () => {
  expect(JSON.stringify(entries)).not.toContain("subagent chatter");
});

test("bookkeeping records are ignored, not turned into turns", () => {
  expect(entries.every((e) => e.text !== "default")).toBe(true);
});

test("one unparseable line is skipped without losing the file", () => {
  // The record AFTER the broken line must still be present: a private format
  // will grow rows this parser has never seen, and one of them must not cost
  // the operator their whole history.
  expect(entries.at(-1)!.text).toBe("❯ 1. Yes");
});

test("a null element in a content array does not throw, and the record's good part survives", () => {
  // Any content element can be anything valid JSON allows — this is a
  // private, unversioned format. A `null` element must cost nothing: not the
  // record it sits in, and not the file around it.
  const survivor = entries.find((e) => e.text === "survives next to a null part");
  expect(survivor).toBeDefined();
  expect(survivor!.role).toBe("assistant");
  // The record after this one (across the earlier broken line too) is still there.
  expect(entries.at(-1)!.text).toBe("❯ 1. Yes");
});

test("a record with no message at all produces no entry and does not throw", () => {
  expect(entries.some((e) => e.at === "2026-08-20T13:05:50Z")).toBe(false);
});

test("a user record whose content is a number produces no entry and does not throw", () => {
  expect(entries.some((e) => e.at === "2026-08-20T13:05:55Z")).toBe(false);
});

test("the full fixture yields exactly the expected turns, nothing lost or fabricated", () => {
  expect(entries).toHaveLength(5);
});

test("the adapter records the harness version its shape was verified against", () => {
  expect(claudeAdapter.verifiedAgainst).not.toBe("unverified");
});

test("locate refuses a value that is not a session id, before touching disk", async () => {
  expect(await claudeAdapter.locate("../../etc/passwd", ["/nonexistent"])).toBeNull();
});
