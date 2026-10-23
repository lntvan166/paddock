import { expect, test } from "bun:test";
import { toLines } from "@server/journal/text";
import type { JournalEntry } from "@server/journal/types";
import { hasTag, newTag, REMOTE_PREFIX, replyAfter } from "@server/mcp/reply";

const user = (text: string, at: string | null = "2026-10-24T10:00:00+07:00"): JournalEntry =>
  ({ role: "user", at, text, tools: [] });
const agentSays = (text: string, tools: string[] = [], at: string | null = "2026-10-24T10:01:00+07:00"): JournalEntry =>
  ({ role: "assistant", at, text, tools });

// Built with the real renderer, so a change to the header format breaks here
// rather than silently turning every wait into still_working.
test("replyAfter finds the reply after the tagged line", () => {
  const lines = toLines([
    user("earlier"), agentSays("earlier reply"),
    user(`${REMOTE_PREFIX("abc123")}report docker compose ps`),
    agentSays("All **six** services up.", ["Bash"]),
  ]);
  expect(replyAfter(lines, "abc123")).toEqual(["▸ Bash", "All six services up."]);
});

test("null before any agent header follows the tag", () => {
  const lines = toLines([agentSays("earlier"), user(`${REMOTE_PREFIX("abc123")}go`)]);
  expect(replyAfter(lines, "abc123")).toBeNull();
  expect(hasTag(lines, "abc123")).toBe(true);
});

test("null for an absent tag", () => {
  const lines = toLines([user("hello"), agentSays("hi")]);
  expect(replyAfter(lines, "abc123")).toBeNull();
  expect(hasTag(lines, "abc123")).toBe(false);
});

test("only the agent group after the tag, up to the next user turn", () => {
  const lines = toLines([
    user(`${REMOTE_PREFIX("abc123")}go`), agentSays("first"), agentSays("second"),
    user("the operator, later", "2026-10-24T10:05:00+07:00"), agentSays("not ours", [], "2026-10-24T10:06:00+07:00"),
  ]);
  expect(replyAfter(lines, "abc123")).toEqual(["first", "", "second"]);
});

test("the tag survives the markdown renderer literally", () => {
  expect(toLines([user(`${REMOTE_PREFIX("k3f9z0")}x`)]).join("\n")).toContain("[from remote #k3f9z0]");
});

test("newTag is six base-36 characters and varies", () => {
  const tags = new Set(Array.from({ length: 50 }, newTag));
  for (const t of tags) expect(t).toMatch(/^[0-9a-z]{6}$/);
  expect(tags.size).toBeGreaterThan(45);
});
