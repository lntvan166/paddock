import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Themes are `:root[data-theme="…"]` blocks, and each one must fully own its
 * palette. See docs/design/2026-08-26-theme-picker-design.md.
 */
const css = readFileSync("src/web/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("system dark applies only when no theme is pinned", () => {
  // The old guard was `:root:not([data-theme="light"])`, which names one
  // special case instead of the actual rule. With named themes it still
  // matches — `dracula` is not `light` — so the system-dark palette would
  // apply underneath every theme, and each theme block would win only by
  // being later in the file. Correctness by source order is not correctness.
  expect(css).toContain(":root:not([data-theme])");
  expect(css).not.toContain(':root:not([data-theme="light"])');
});
