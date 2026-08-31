import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The tour overlay lays down its OWN dark ground and then writes on it.
 *
 * Nothing else in the suite covers this. `tests/themes.test.ts` measures
 * `src/web/styles.css`, and these tokens are deliberately not there: the
 * overlay renders in the SITE's document, which never loads the app's
 * stylesheet. Tokens defined there resolved to nothing, and an undefined
 * custom property inside a box-shadow or outline invalidates the whole
 * declaration — the first build of this page ran the tour with no scrim and no
 * spotlight at all, and nothing failed.
 */
const css = readFileSync("src/site/tour/overlay.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function tokensIn(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = (m[2] ?? "").trim();
  return out;
}

const at = css.indexOf(":root {");
const tokens = tokensIn(css.slice(at, css.indexOf("}", at)));

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function ratio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const AA = 4.5;

test("every colour the overlay uses is actually defined", () => {
  // The failure this exists for: a var() that resolves to nothing does not fall
  // back, it invalidates the declaration. The scrim and the spotlight outline
  // both vanish, silently, and the tour still "runs".
  const used = new Set([...css.matchAll(/var\((--tour-[\w-]+)\)/g)].map((m) => m[1]!));
  expect(used.size, "the overlay uses no tour tokens at all").toBeGreaterThan(0);
  for (const u of used) {
    expect(Object.keys(tokens), `${u} is used but never defined`).toContain(u);
  }
});

test("callout text and controls stay AA on the panel they sit on", () => {
  for (const fg of ["--tour-text", "--tour-accent"]) {
    const r = ratio(tokens[fg]!, tokens["--tour-panel"]!);
    expect(
      r,
      `${fg} (${tokens[fg]}) on --tour-panel (${tokens["--tour-panel"]}) is ${r.toFixed(2)}, below AA ${AA}`,
    ).toBeGreaterThanOrEqual(AA);
  }
});

test("the spotlight cuts rather than travels under reduced motion", () => {
  const raw = readFileSync("src/site/tour/overlay.css", "utf8");
  expect(raw).toContain("prefers-reduced-motion");
  const block = raw.slice(raw.indexOf("prefers-reduced-motion"));
  expect(block).toContain("transition: none");
});
