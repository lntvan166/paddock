import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Two radii, named — plus a pill. Not ten.
 *
 * `shadcn init` introduced `--radius: 0.75rem`, and `@theme inline` derives the
 * whole `--radius-*` scale from it, so every `rounded-lg` in JSX resolved to
 * 12px. Meanwhile 22 hand-written rules rounded at `0.4rem` — 6.4px — with
 * 0.25 / 0.3 / 0.35 / 0.45 / 0.5 / 0.6 / 0.75rem scattered between them. Ten
 * values, four of them inside 1.6px of each other, which is a huddle rather
 * than a scale.
 *
 * The two the app actually used, 6.4px and 12px, are within rounding distance
 * of Primer's `medium` and `large` — GitHub ships three plus a pill for an app
 * far larger than this one. So the split was never wrong about WHICH two sizes
 * it wanted; it was wrong that neither was named and the boundary between them
 * was accidental. That is what let `--radius` (12px, on cards) sit directly
 * above `.host-settings-btn` (6.4px) in the same header and disagree.
 *
 * This is the same collision class as the `--border` / `--accent` incident
 * `styles.css` already records, and it survived for the same reason: nothing
 * asserted a computed radius.
 */
const raw = readFileSync("src/web/styles.css", "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

test("the radius steps are tokens on bare :root", () => {
  const at = css.indexOf("\n:root {");
  const block = css.slice(at, css.indexOf("}", at));
  for (const token of ["--r-sm:", "--r-md:", "--r-full:"]) {
    expect(block, `${token} must be defined on bare :root`).toContain(token);
  }
});

test("shadcn's --radius is an ALIAS of ours, never its own value", () => {
  // `init` wrote its own `--border` and `--accent` straight over paddock's and
  // turned the interaction colour near-white; the bridge block exists so that
  // cannot happen again. `--radius` is the same hazard: left with a literal it
  // silently governs every `rounded-*` utility in the app.
  const at = css.indexOf("\n:root {");
  const block = css.slice(at, css.indexOf("}", at));
  const m = /--radius\s*:\s*([^;]+);/.exec(block);
  expect(m, "no --radius in :root").not.toBeNull();
  expect(m![1]!.trim()).toBe("var(--r-md)");
});

test("every radius is a step, a pill, or an explicitly-cornered sheet", () => {
  const ALLOWED = new Set([
    "var(--r-sm)",
    "var(--r-md)",
    "var(--r-full)",
    // A sheet rounds its top corners only, and says so per-corner.
    "var(--r-md) var(--r-md) 0 0",
    // Hairline: the 1.5px stroke on a StatusDot ring, which is a shape rather
    // than a surface. `tests/tokens.test.ts` guards that dot's geometry.
    "1.5px",
  ]);
  const offenders: string[] = [];
  for (const m of css.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
    const v = (m[1] ?? "").trim();
    if (!ALLOWED.has(v)) offenders.push(v);
  }
  expect(
    offenders,
    "use var(--r-sm|--r-md|--r-full); a new literal is how ten values happened",
  ).toEqual([]);
});

test("the two steps are far enough apart to read as different", () => {
  const at = css.indexOf("\n:root {");
  const block = css.slice(at, css.indexOf("}", at));
  const rem = (name: string) => {
    const m = new RegExp(`${name}\\s*:\\s*([\\d.]+)rem`).exec(block);
    if (!m) throw new Error(`${name} is not a rem value`);
    return parseFloat(m[1]!) * 16;
  };
  // The type scale's test fails on any two steps closer than 1.5px, for the
  // reason its comment gives: a step nobody can see is not a step. The same
  // rule, on the same grounds, applied to shape.
  expect(rem("--r-md") - rem("--r-sm")).toBeGreaterThanOrEqual(4);
});
