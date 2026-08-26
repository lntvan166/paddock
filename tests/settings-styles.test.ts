import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Touch-target and layout guards for the settings form, checked against the
 * stylesheet source.
 *
 * happy-dom implements no layout (tests/support/dom.ts says so, and makes
 * `scrollTo` throw rather than silently answer zero), so a rendered-DOM test
 * cannot measure a control's height or notice that a `<legend>` has become a
 * flex item. Reading the rule out of `styles.css` is the same approach
 * `tests/block-styles.test.ts` already takes for a defect that shipped once:
 * it cannot prove the pixels, but it does stop the declaration being deleted
 * by someone who does not know why it is there.
 */
// Comments stripped first: they sit between rules, so a naive selector match
// would read "/* … */ .term-pane" as the selector and find nothing.
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of EVERY rule whose selector list contains this selector
 *  exactly, concatenated — so a later override is seen as well as the first. */
function ruleBody(selector: string): string {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").map((x) => x.trim()).includes(selector))
    .map((m) => m[2] ?? "");
  if (bodies.length === 0) throw new Error(`no CSS rule for "${selector}"`);
  return bodies.join("\n");
}

function declaration(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`).exec(ruleBody(selector));
  if (!m) throw new Error(`"${selector}" declares no ${prop}`);
  return (m[1] ?? "").trim();
}

// 2.75rem at the 16px root the app never overrides. The app's own convention
// (`.tap`, `.term-keys`, `.detail header .controls button`) is 44px / 2.75rem.
const TOUCH_TARGET = "2.75rem";

test("the trigger box is still visible at the size the native one was", () => {
  // The native checkbox this replaced was sized here at 1.35rem. shadcn's
  // Checkbox defaults to 16px, which is smaller — and the rule that used to
  // hold the old size, `.settings-triggers input[type="checkbox"]`, now matches
  // no element at all, so guarding it would pass against nothing. This guards
  // the replacement instead. Tappability is the ROW's job and is asserted
  // below; this is only about seeing the tick.
  expect(declaration(".trigger-box", "width")).toBe("1.35rem");
  expect(declaration(".trigger-box", "height")).toBe("1.35rem");
});

test("the trigger checkboxes sit in a 44px row, not a bare 22px box", () => {
  // "Notify on: Blocked / Done" is the control this whole feature exists to
  // configure, on a dashboard whose premise is a phone. A 1.35rem checkbox is
  // a ~22px target; the label row is what the operator actually taps.
  expect(declaration(".settings-triggers label", "min-height")).toBe(TOUCH_TARGET);
});

test("a labelled row inside a card clears the touch target", () => {
  // Was `.settings-field-row`. The vocabulary changed; the 44px floor it
  // existed to guarantee did not.
  expect(declaration(".card-row", "min-height")).toBe(TOUCH_TARGET);
});

test("a text field inside a card looks like a field, and is a full touch target", () => {
  // Deleting `.settings-field input` left every settings field borderless,
  // transparent and 19px tall — indistinguishable from static text. The old
  // rule's border and height were never guarded, only its sibling row's,
  // which is why nothing failed when they went.
  const sel = '.card-row input:not([type="checkbox"])';
  expect(declaration(sel, "min-height")).toBe(TOUCH_TARGET);
  expect(declaration(sel, "border")).toContain("var(--border)");
});

test("the triggers legend is not laid out inline with its options", () => {
  // `.settings-triggers` is a `fieldset` with `display: flex`, which makes its
  // `<legend>` a flex item — "Notify on" then rendered on the same line as the
  // checkboxes and read as a third option. The fieldset wraps and the legend
  // claims the whole first line, which puts the label back above the group
  // without needing a wrapper element.
  expect(declaration(".settings-triggers", "flex-wrap")).toBe("wrap");
  expect(declaration(".settings-triggers legend", "flex")).toBe("0 0 100%");
});

test("the terminal font size still falls back to the responsive clamp", () => {
  // `src/web/prefs.ts` defaults `fontPx` to null and `AgentTerminal` writes
  // `--term-font-px` only when a preference exists — which is only worth
  // anything while this rule still HAS a fallback. A rule that hardcoded a
  // size, or dropped the second argument to `var()`, would make the whole
  // fix inert without failing any DOM test.
  expect(declaration(".term-pane", "font-size"))
    .toBe("var(--term-font-px, clamp(0.62rem, 2.3vw, 0.78rem))");
});

test("the bottom-most chrome clears the home indicator", () => {
  // The guarantee is unchanged — nothing tappable may sit under the iOS
  // gesture bar — but it moved with the layout. The save bar used to be
  // `position: fixed` at the viewport bottom and carried the inset itself.
  // `TabBar` is now the bottom-most element on every top-level screen, so the
  // inset belongs to it; two elements both padding for the home indicator is
  // how you get a double gap.
  expect(declaration(".tab-bar", "padding-bottom")).toContain("env(safe-area-inset-bottom");
});

test("the save bar cannot overlap the tabs, and reserves nothing to avoid it", () => {
  // This replaces a test that asserted a 5.5rem reservation on the scroller.
  // That reservation existed because the bar was `position: fixed` at
  // `bottom: 0` — which, once `TabBar` exists, puts it directly ON the tabs.
  // Two pinned bars at the same edge is not something padding can fix.
  //
  // So the bar is a flex sibling now: scroller, save bar, tabs, stacked. The
  // guarantee the old test protected — the bar never covers the last field —
  // holds by construction rather than by arithmetic, and the 88px that used to
  // be reserved unconditionally (on top of the bar's own height, on a screen
  // that is usually clean) is given back.
  const body = ruleBody(".settings-save-bar");
  expect(body).not.toContain("position: fixed");
  expect(body).toContain("flex: none");

  // And nothing is reserved for it any more. A stale reservation would be
  // silent dead space at the bottom of every Settings screen.
  expect(() => ruleBody(".settings > .screen-body")).toThrow();
});

test("the save bar's button is a full touch target", () => {
  expect(declaration(".settings-save-bar button", "min-height")).toBe(TOUCH_TARGET);
});

test("the empty toast region takes up no space", () => {
  // The live region is mounted before it has anything to say (see Toast.tsx),
  // so `.settings-toast` is in the DOM on a page with no message on it. Without
  // this rule that is a visible empty box with a green border under the header.
  // `display: none` is deliberately NOT the fix — it would take the region back
  // out of the accessibility tree, which is the whole reason it is pre-mounted.
  expect(declaration(".settings-toast:empty", "padding")).toBe("0");
  expect(declaration(".settings-toast:empty", "border")).toBe("0");
  expect(ruleBody(".settings-toast:empty")).not.toContain("display");
});

test("the mute buttons are full touch targets", () => {
  expect(declaration(".settings-mute button", "min-height")).toBe(TOUCH_TARGET);
});
