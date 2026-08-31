import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The demo, embedded in the site's phone, and the zero-height document that
 * made Safari render it as a white rectangle.
 *
 * MEASURED inside the live iframe: `.app-shell` is `position: fixed; inset: 0`
 * and 591px tall, while `html`, `body` and `#root` are ALL 0. The shell is out
 * of flow, so nothing gives the document a height. Chromium paints a fixed
 * element against the iframe's viewport regardless; Safari, handed a
 * zero-height iframe document, painted nothing at all.
 *
 * `frame.css` already solves this for a laptop — it sizes `#root` and gives it
 * `transform: translate(0)` so the fixed shell has a containing block, and its
 * own comment calls that "load-bearing, and the reason a frame is possible at
 * all". But every one of those rules sits inside `@media (min-width: 760px)`,
 * and the site's phone is 390px wide, so the embedded case got none of them.
 *
 * Keyed on being EMBEDDED rather than on the width, deliberately. A real phone
 * opening the demo directly is also under 760px and must keep the viewport
 * units it has: `.term` tracks the DYNAMIC viewport there, which is what makes
 * the keyboard inset work, and a `height: 100%` containing block would pin it
 * to the large viewport instead.
 */
const css = readFileSync("src/web/demo/frame.css", "utf8");
const entry = readFileSync("src/web/demo/frame.ts", "utf8");
const site = readFileSync("src/site/main.ts", "utf8");

test("the site asks for the embedded demo, not the bare one", () => {
  expect(site, "the iframe requests the unembedded app").toMatch(/\/app\/\?embed/);
});

test("the entry flags embedding from the query it was asked with", () => {
  expect(entry).toContain("embed");
  expect(entry).toContain("demoEmbedded");
});

test("the embedded rules are OUTSIDE the width query", () => {
  // The whole defect: the rules that give the document a height existed, and
  // applied only from 760px up. Everything before the media query applies at
  // every width.
  const beforeQuery = css.slice(0, css.indexOf("@media (min-width: 760px)"));
  expect(beforeQuery, "the embedded rules are still gated by width")
    .toContain('[data-demo-embedded="on"]');
});

test("an embedded demo gives its document a real height", () => {
  const beforeQuery = css.slice(0, css.indexOf("@media (min-width: 760px)"));
  const block = beforeQuery.slice(beforeQuery.indexOf('[data-demo-embedded="on"]'));
  expect(block).toMatch(/height:\s*100%/);
});

test("an embedded demo gives the fixed shell a containing block", () => {
  // Without this the shell resolves against the iframe's viewport, which is the
  // construct Safari would not paint. `translate(0)` is what makes `#root` the
  // containing block for fixed descendants — the same trick the 760px frame
  // already relies on, and for the same stated reason.
  const beforeQuery = css.slice(0, css.indexOf("@media (min-width: 760px)"));
  const rootRule = beforeQuery.slice(beforeQuery.indexOf('[data-demo-embedded="on"] #root'));
  expect(rootRule).toMatch(/transform:\s*translate\(0\)/);
});

test("a real phone opening the demo directly is untouched", () => {
  // It is under 760px too, and it must keep the dynamic viewport units the
  // keyboard inset depends on. Nothing may key the embedded rules on width.
  const beforeQuery = css.slice(0, css.indexOf("@media (min-width: 760px)"));
  const block = beforeQuery.slice(beforeQuery.indexOf('[data-demo-embedded="on"]'));
  expect(block, "the embedded rules would catch a real phone too")
    .not.toContain("max-width");
});
