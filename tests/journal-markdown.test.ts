import { expect, test } from "bun:test";
import { renderMarkdown } from "@server/journal/text";

/**
 * The journal serves the harness's stored MARKDOWN; the live viewport shows the
 * harness's RENDERING of it. Blended together with no divider — which design
 * decision 3 says is deliberate — the same message appeared twice in two
 * different skins, and the journal half read as raw source: literal asterisks
 * and backticks under prose that was styled a line earlier.
 *
 * The codes below are MEASURED, not chosen. Captured from a live Claude Code
 * viewport through `/api/agents/:id/output`:
 *
 *   **bold**   ->  ESC[0m ESC[1m … ESC[0m
 *   `code`     ->  ESC[38;2;177;185;249m … ESC[0m
 *   - item     ->  the dash is kept, literally
 *
 * Emitting the same codes means the journal flows through the ANSI renderer the
 * live screen already uses, so the two halves match without the client knowing
 * a journal exists.
 */
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const CODE = "\x1b[38;2;177;185;249m";
const OFF = "\x1b[0m";

test("bold becomes the weight the viewport uses", () => {
  expect(renderMarkdown("the **install URL** changed")).toBe(
    `the ${BOLD}install URL${OFF} changed`,
  );
});

test("inline code becomes the colour the viewport uses", () => {
  expect(renderMarkdown("see `read.ts` for the cursor")).toBe(
    `see ${CODE}read.ts${OFF} for the cursor`,
  );
});

test("italic becomes an italic", () => {
  expect(renderMarkdown("a *scrollback* reconstruction")).toBe(
    `a ${ITALIC}scrollback${OFF} reconstruction`,
  );
});

test("markdown inside a code span stays literal", () => {
  // A code span is quoted material. Styling its contents would rewrite what the
  // agent actually said, and `**` is ordinary text inside one.
  expect(renderMarkdown("run `echo **not bold**` first")).toBe(
    `run ${CODE}echo **not bold**${OFF} first`,
  );
});

test("a fenced block is left entirely alone", () => {
  // Fences hold code. Bolding inside one would corrupt what it quotes.
  const src = ["```bash", "make test  # **not bold**", "```"].join("\n");
  expect(renderMarkdown(src)).toBe(src);
});

test("a list keeps its dash, because the viewport keeps it too", () => {
  expect(renderMarkdown("- **Show earlier** on an agent")).toBe(
    `- ${BOLD}Show earlier${OFF} on an agent`,
  );
});

test("underscores are never italics", () => {
  // A coding transcript is full of snake_case. Treating `_` as emphasis would
  // eat identifiers, which is a worse failure than a missed italic.
  const src = "the agent_not_idle refusal, measured";
  expect(renderMarkdown(src)).toBe(src);
});

test("an unmatched marker is left as typed", () => {
  const src = "2 * 3 is not emphasis, and neither is a lone ** here";
  expect(renderMarkdown(src)).toBe(src);
});

test("bold wins over italic where both could match", () => {
  expect(renderMarkdown("**bold** and *thin*")).toBe(
    `${BOLD}bold${OFF} and ${ITALIC}thin${OFF}`,
  );
});

test("text with no markdown is returned untouched", () => {
  const src = "Rollback is a single DROP INDEX, with no data loss.";
  expect(renderMarkdown(src)).toBe(src);
});

test("bold that wraps a code span is still bold", () => {
  // Found in a live journal page: `**Send with \`<the option>\`**` came out
  // with its asterisks intact, because code spans were pulled out BEFORE
  // emphasis ran and the `**` pair was split across two fragments that no
  // longer matched each other.
  const out = renderMarkdown("- **Send with `<the option>`** → the note");
  expect(out, "the asterisks survived").not.toContain("**");
  expect(out).toContain(BOLD);
  expect(out).toContain(`${CODE}<the option>`);
});

test("a code span inside bold still keeps its own markers literal", () => {
  const out = renderMarkdown("**run `echo **hi**` now**");
  expect(out).toContain("echo **hi**");
});
