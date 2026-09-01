import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The landing page's own palette, checked the way the app's themes are.
 *
 * `tests/themes.test.ts` measures `src/web/styles.css` and never looks here;
 * `tests/tour-contrast.test.ts` measures the overlay's four tokens and stops
 * there. The page around them had no check at all, which mattered little while
 * it was near-black text on near-white — and matters now that it commits to one
 * dark ground with a warm grey doing most of the talking.
 *
 * ONE palette on purpose. There is no `prefers-color-scheme` block to check,
 * because the page declares `color-scheme: dark` and paints every colour
 * explicitly rather than inheriting a ground from the browser.
 */
const css = readFileSync("src/site/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const at = css.indexOf(":root {");
const tokens: Record<string, string> = {};
for (const m of css.slice(at, css.indexOf("}", at)).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  tokens[m[1]!] = (m[2] ?? "").trim();
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

const ratio = (a: string, b: string): number => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const AA = 4.5;
/** Large text — the display face at 800 well above 24px — may sit at 3:1. */
const AA_LARGE = 3;

test("the scan found a palette to check", () => {
  for (const t of ["--site-bg", "--site-raise", "--site-fg", "--site-dim", "--site-accent", "--site-ghost"]) {
    expect(tokens[t], `${t} is missing`).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("body text and secondary text are AA on both grounds", () => {
  // Both, because the install box, the facts band and the closing section all
  // sit on --site-raise while the page sits on --site-bg. A grey tuned against
  // one and read against the other is how this drops below AA unnoticed.
  for (const ground of ["--site-bg", "--site-raise"]) {
    for (const fg of ["--site-fg", "--site-dim"]) {
      const r = ratio(tokens[fg]!, tokens[ground]!);
      expect(
        r,
        `${fg} (${tokens[fg]}) on ${ground} (${tokens[ground]}) is ${r.toFixed(2)}, below AA ${AA}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  }
});

test("the accent is AA on both grounds, because it is used as link text", () => {
  // Not merely as a border or a wash: `a { color: var(--site-accent) }`, so it
  // has to clear body-text contrast rather than large-text contrast.
  for (const ground of ["--site-bg", "--site-raise"]) {
    const r = ratio(tokens["--site-accent"]!, tokens[ground]!);
    expect(
      r,
      `--site-accent on ${ground} is ${r.toFixed(2)}, below AA ${AA}`,
    ).toBeGreaterThanOrEqual(AA);
  }
});

test("the two grounds are distinguishable from each other", () => {
  // --site-raise is meant to read as a panel ON the page. Too close and every
  // border is doing the work alone; too far and the page becomes stripes.
  const r = ratio(tokens["--site-raise"]!, tokens["--site-bg"]!);
  expect(r, `the panel ground is invisible against the page (${r.toFixed(2)})`).toBeGreaterThan(1.05);
  expect(r, `the panel ground reads as a separate section (${r.toFixed(2)})`).toBeLessThan(1.9);
});

test("the ghost numeral clears AA for the size it is set at", () => {
  // It is text a screen reader announces, not decoration, so it gets a floor —
  // the large-text one, since it is set at 44px/800. It was briefly
  // `--site-line`, a hairline colour, which would have made it unreadable to
  // everyone who can see it while still being read aloud.
  const r = ratio(tokens["--site-ghost"]!, tokens["--site-bg"]!);
  expect(r, `--site-ghost is ${r.toFixed(2)}, below AA-large ${AA_LARGE}`).toBeGreaterThanOrEqual(
    AA_LARGE,
  );
  // And quieter than the prose beside it, or it stops being a ghost.
  expect(r).toBeLessThan(ratio(tokens["--site-dim"]!, tokens["--site-bg"]!));
});

test("the hairline is visible without becoming a rule", () => {
  const r = ratio(tokens["--site-line"]!, tokens["--site-bg"]!);
  expect(r, `--site-line is invisible (${r.toFixed(2)})`).toBeGreaterThan(1.1);
  expect(r, `--site-line is louder than the text it separates (${r.toFixed(2)})`).toBeLessThan(AA_LARGE);
});
