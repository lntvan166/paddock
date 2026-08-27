import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The hosted demo's Spaces screen.
 *
 * `/api/spaces` had no route at all, so it fell through to the agent regex and
 * answered 404 — the Spaces tab rendered an error on GitHub Pages, which is
 * the one place people look at paddock without running it. The pager did not
 * reveal that so much as make it constant: all three tabs are mounted now, so
 * the error was there whether or not anyone opened Spaces.
 *
 * The tree is DERIVED from the same `agents` array the dashboard reads, so the
 * two screens cannot disagree about how many agents exist. These tests read
 * the source rather than execute it, because `backend.ts` installs itself over
 * the global `fetch` on import and there is no way to ask it a question
 * without taking the process's networking with it.
 */
const src = readFileSync("src/web/demo/backend.ts", "utf8");

test("the demo answers /api/spaces", () => {
  expect(src, "the Spaces screen has no route and will 404").toContain('path.endsWith("/api/spaces")');
});

test("the tree is derived from the agents, not written out by hand", () => {
  // Two hand-written fixtures drift, and the drift shows as a dashboard and a
  // Spaces screen disagreeing about how many agents exist — in a screenshot.
  const branch = src.slice(src.indexOf('path.endsWith("/api/spaces")'));
  expect(branch.slice(0, 800)).toContain("agents.map(");
});

test("a create is refused, not quietly resolved", () => {
  // `CLAUDE.md` is explicit: a write that resolved would make every control
  // look live and do nothing, silently, with no test able to notice because a
  // resolved promise is what success looks like. `demo-actions.ts` holds this
  // line server-side; the browser demo has to hold it too.
  expect(src).toContain("const refuse = ()");
  const branch = src.slice(src.indexOf('path.endsWith("/api/spaces")'));
  expect(branch.slice(0, 200), "POST /api/spaces is not refused").toContain("refuse()");
});

test("space and tab management is refused too", () => {
  // Rename and close reach /api/spaces/:id/... and /api/tabs/:id/..., which
  // the agent regex never matched either.
  expect(src).toMatch(/api\\\/\(spaces\|tabs\)/);
  expect(src).toContain("refuse()");
});

test("the refusal says the same thing the server-side demo says", () => {
  // One sentence, two implementations. An operator who meets both should not
  // have to work out whether they are different limitations.
  const server = readFileSync("src/server/demo-actions.ts", "utf8");
  // From the THROWN string, not from prose: the file explains itself in
  // comments that quote the phrase, and matching those compares a sentence
  // fragment against nothing in particular.
  const sentence = /new Error\("([^"]+)"\)/.exec(server)?.[1];
  expect(sentence, "the server-side demo's refusal has moved").toBeDefined();
  expect(src, "the two demos refuse in different words").toContain(sentence!);
});

test("the harness list is answered, so the create sheet is not empty", () => {
  // An empty picker reads as broken rather than restricted.
  expect(src).toContain('path.endsWith("/api/harnesses")');
});

test("the method is threaded through, since /api/spaces is both a read and a write", () => {
  // GET is the tree; POST creates. Answering both the same way would either
  // break the screen or fake a create.
  expect(src).toContain("function handle(url: string, body: Record<string, unknown>, method: string)");
  expect(src).toContain('method === "POST"');
});
