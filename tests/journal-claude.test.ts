import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "@server/journal/claude";
import { MAX_TEXT_CHARS } from "@server/journal/text";

const chunk = readFileSync("tests/fixtures/journal/claude-session.jsonl", "utf8");
const entries = claudeAdapter.parse(chunk);

/**
 * A second fixture, for the ONE rule that "a string is a person typing" got
 * wrong: the harness (and any hook or plugin) injects its own blocks into that
 * same field. Invented content throughout, per house rule 2 — the SHAPES are
 * real, every byte between the tags is made up, and the absolute paths are
 * `/path/to/…` placeholders (a literal home path in a fixture is what
 * `make check-clean` exists to catch).
 */
const injectedChunk = readFileSync("tests/fixtures/journal/claude-injected.jsonl", "utf8");
const injected = claudeAdapter.parse(injectedChunk);
const injectedText = JSON.stringify(injected);

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

/**
 * Every injected block shape, asserted on the whole parse — one leak anywhere
 * is the whole failure, exactly like the `SECRET_TOKEN` assertion above.
 *
 * The BODIES are what matter, so each is given a distinctive invented marker
 * in the fixture rather than being checked by tag name: a test that only
 * asserted the tags were gone would pass on an implementation that stripped
 * the angle brackets and served the text between them.
 */
test("no injected block body reaches the output, whatever shape it arrived in", () => {
  for (const leak of [
    "TOKEN_IN_RESULT",                 // <result> — subagent / tool result text
    "/path/to/private",                // an absolute path carried inside a block
    "ONLY_A_RESULT_BLOCK",             // a record that is nothing but a result
    "NOTIFICATION_PAYLOAD",            // <output-file> inside <task-notification>
    "REMINDER_INJECTED_BY_HARNESS",    // <system-reminder>
    "STDOUT_OF_A_LOCAL_COMMAND",       // <local-command-stdout>
    "COMMAND_MESSAGE_TEXT",            // <command-message>
    "COMMAND_ARGS_TEXT",               // <command-args>
    "flaky-test-fix",                  // <command-name>
    "PLUGIN_INJECTED_OBSERVATION",     // a plugin's own block, not on the list
    "TRUNCATED_RESULT_BODY",           // an OPENED block the harness never closed
  ]) {
    expect(injectedText).not.toContain(leak);
  }
});

test("the typed message a block was appended to still arrives, minus the block", () => {
  // The whole reason stripping beats dropping the record: the operator really
  // did type this, and it is the only thing in the record worth showing.
  const kept = injected.filter((e) => e.role === "user").map((e) => e.text.trim());
  expect(kept).toContain("please rerun the schema-migration suite");
  expect(kept).toContain("and now the docs-cleanup one");
  expect(kept).toContain("start here");
});

test("a record that was ONLY an injected block is dropped, not served as a blank turn", () => {
  // Five of the fixture's nine records are pure injection. None may survive
  // as an empty "you" row above the live screen, so four turns remain.
  expect(injected.every((e) => e.text.trim() !== "")).toBe(true);
  expect(injected).toHaveLength(4);
});

test("markup a PERSON wrote survives — the strip is not a blanket tag filter", () => {
  // `<span>` and `<AgentRow>` are HTML and JSX names: single lowercase word,
  // or PascalCase. Only kebab/snake-cased names are treated as injected, so a
  // message quoting real markup is not silently eaten.
  const kept = injected.find((e) => e.text.includes("the padding is wrong"));
  expect(kept).toBeDefined();
  expect(kept!.text).toContain("<span>this</span>");
  expect(kept!.text).toContain("<AgentRow>");
});

test("a subagent result reaching top level without isSidechain is still dropped", () => {
  // `isSidechain` is a TOP-LEVEL flag; none of these records carry it. A
  // `<result>` block is exactly how a subagent's output arrives in a record
  // the flag cannot see, which is why the flag alone was never sufficient.
  expect(injectedChunk).not.toContain("isSidechain");
  expect(injectedText).not.toContain("TOKEN_IN_RESULT");
});

test("the adapter strips BEFORE the text cap, not after — pinned at the call site", () => {
  /**
   * The ordering assertion has to live here, where `toEntry` chooses when to
   * call `stripInjected`. Asserted in journal-text.test.ts it proves nothing
   * about the adapter: that test picks the call order itself, so an adapter
   * clamping first sails through it.
   *
   * The shape is chosen so the two orders diverge VISIBLY. A block wider than
   * the cap sits FIRST, with the typed message after it:
   *
   *   strip → clamp  (correct): the whole block goes, the message remains.
   *   clamp → strip  (broken):  the clamp cuts inside the block, taking the
   *                             closing tag and the message with it; the
   *                             truncated opener then strips to nothing and
   *                             the record is dropped — the operator's own
   *                             words gone, and the record silently absent.
   */
  const huge = "y".repeat(MAX_TEXT_CHARS * 2);
  const line = JSON.stringify({
    type: "user",
    timestamp: "2026-08-21T10:00:00Z",
    message: { role: "user", content: `<result>OVERSIZE_RESULT_BODY${huge}</result>the typed message` },
  });
  const parsed = claudeAdapter.parse(line);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]!.text).toBe("the typed message");
  expect(parsed[0]!.text).not.toContain("OVERSIZE_RESULT_BODY");
});
