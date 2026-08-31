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

test("a real phone opening the demo directly is untouched", () => {
  // It is under 760px too, and it must keep the dynamic viewport units the
  // keyboard inset depends on. Nothing may key the embedded rules on width.
  const beforeQuery = css.slice(0, css.indexOf("@media (min-width: 760px)"));
  const block = beforeQuery.slice(beforeQuery.indexOf('[data-demo-embedded="on"]'));
  expect(block, "the embedded rules would catch a real phone too")
    .not.toContain("max-width");
});

/**
 * And the construct the first fix LEFT IN PLACE, which is why the phone was
 * still white after it shipped.
 *
 * Giving `#root` a transform made it the containing block for the app's fixed
 * shells, and that is correct per spec — but `position: fixed` inside a
 * transformed, `overflow: hidden` ancestor inside an IFRAME is the single most
 * Safari-hostile arrangement in CSS, and the app stacks it three deep:
 * `.app-shell` fixed, `.screen`/`.term` fixed inside it, `.detail` and
 * `.quick-add-fab` fixed on top. Chromium composites it; Safari painted
 * nothing, which is a white rectangle.
 *
 * So the embedded demo does not USE fixed positioning. `#root` becomes an
 * ordinary positioned ancestor and every fixed shell becomes `absolute`
 * against it — identical geometry, and a path every engine has agreed on for
 * twenty years. Nothing here changes the app a real phone loads directly.
 */
const APP_CSS = readFileSync("src/web/styles.css", "utf8");

/** Every selector in the app whose own block declares `position: fixed`. */
function fixedSelectors(css: string): string[] {
  const out: string[] = [];
  let selector = "";
  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (line.endsWith("{") && !line.startsWith("@")) selector = line.slice(0, -1).trim();
    // `position: fixed` inside a comment is prose about the rule, not the rule.
    else if (/^position:\s*fixed/.test(line) && selector) out.push(selector);
  }
  return [...new Set(out.flatMap((s) => s.split(",").map((p) => p.trim())))];
}

test("the guard can actually see the app's fixed shells", () => {
  // A parser that matches nothing would pass every assertion below in silence.
  const found = fixedSelectors(APP_CSS);
  expect(found, "the fixed-position scan found nothing").toContain(".app-shell");
  expect(found.length).toBeGreaterThan(3);
});

test("an embedded demo positions the shells against #root, not the viewport", () => {
  const embedded = css.slice(css.indexOf('[data-demo-embedded="on"]'));
  for (const sel of fixedSelectors(APP_CSS)) {
    expect(
      embedded,
      `${sel} is still position: fixed when embedded — the arrangement Safari would not paint`,
    ).toContain(`[data-demo-embedded="on"] ${sel}`);
  }
  expect(embedded).toMatch(/position:\s*absolute/);
});

test("#root is an ordinary positioned ancestor, not a transformed one", () => {
  // The transform was the compositing trick; with nothing fixed left inside,
  // it buys nothing and is the layer Safari mishandled.
  const rootRule = css.slice(
    css.indexOf('[data-demo-embedded="on"] #root'),
    css.indexOf("@media (min-width: 760px)"),
  );
  // Declarations only. The block explains WHY the transform is gone, and a scan
  // that reads prose as code reports the thing it just removed.
  const declarations = rootRule.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(declarations).toMatch(/position:\s*relative/);
  expect(declarations, "the transformed containing block is still there").not.toMatch(
    /transform:\s*translate\(0\)/,
  );
});
