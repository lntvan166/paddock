import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { WIDE_QUERY } from "@web/layout";

/**
 * The wide layout is decided in two places — `useWide()` decides whether App
 * renders the split at all, and styles.css lays it out — so the two widths
 * must be the same width. If they drift, a band of screen sizes either mounts
 * the list behind the terminal with no CSS to place it, or styles a split
 * that was never rendered.
 */
const css = readFileSync("src/web/styles.css", "utf8");

test("the JS query and the stylesheet's wide block name the same width", () => {
  expect(css).toContain(`@media ${WIDE_QUERY} {`);
});

test("the query is a WIDTH query, never a device check", () => {
  // CLAUDE.md: width media queries for layout; no device or UA detection.
  expect(WIDE_QUERY).toMatch(/^\(min-width: [\d.]+rem\)$/);
});
