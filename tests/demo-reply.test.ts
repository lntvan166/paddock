import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The hosted demo's reply field used to accept text and do nothing.
 *
 * `/text` returned `ok: true` with the screen unchanged, so an operator typed a
 * reply, pressed send, and watched the transcript not move. That is the
 * mislabelled control `CLAUDE.md` bans, in the one place people look at paddock
 * without running it — and it was there independently of the tour.
 *
 * The demo already SIMULATES the other writes rather than refusing them: `key`
 * moves the cursor and Enter answers, `answer` unblocks the agent. Rendering
 * the reply is the same kind of honesty, not a new licence: the refusal that
 * `demo-actions.ts` holds is about writes paddock cannot perform, and this one
 * it can — the transcript is synthetic and appending to it is the truth.
 *
 * Source-read rather than executed, for the reason demo-backend-spaces.test.ts
 * gives: importing backend.ts installs itself over the global `fetch`.
 */
const src = readFileSync("src/web/demo/backend.ts", "utf8");

test("a reply reaches the screen the demo shows", () => {
  const branch = src.slice(src.indexOf('route === "text"'));
  const body = branch.slice(0, branch.indexOf('route === "answer"'));
  expect(body, "the reply is accepted and dropped").toContain("screens[");
});

test("the reply is echoed as the operator typed it", () => {
  const branch = src.slice(src.indexOf('route === "text"'));
  const body = branch.slice(0, branch.indexOf('route === "answer"'));
  expect(body).toContain("body.text");
});

test("an empty reply changes nothing", () => {
  // The real routes refuse blank text; a demo that appended an empty line to
  // its transcript would be showing something no operator could produce.
  const branch = src.slice(src.indexOf('route === "text"'));
  const body = branch.slice(0, branch.indexOf('route === "answer"'));
  expect(body).toMatch(/trim\(\)/);
});

/**
 * The blocked pane's transcript could never change.
 *
 * `screenFor` returned `blockedScreen(cursor)` for `d1:p1` UNCONDITIONALLY, so
 * that the ❯ marker tracks up and down — which is right while it is blocked and
 * wrong the moment it is not. `answer()` writes `screens[id] = WORKING_SCREEN`
 * and that write was never read: the hosted demo answered the prompt, dropped
 * the option buttons, and went on showing the permission prompt for ever. The
 * reply echo landed in the same dead slot.
 */
test("the blocked screen is regenerated only while the agent is blocked", () => {
  const fn = src.slice(src.indexOf("function screenFor"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  expect(body, "the blocked pane can never show anything else").toContain("blocked");
  expect(body).toContain("state");
});

test("an answered agent shows the screen that was stored for it", () => {
  const fn = src.slice(src.indexOf("function screenFor"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  expect(body).toContain("screens[id]");
});
