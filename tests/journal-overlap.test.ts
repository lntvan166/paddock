import { expect, test } from "bun:test";
import { trimSeen } from "@web/journal-overlap";

/**
 * The first tap of "Show earlier" used to serve content already on screen.
 *
 * `emptyJournal()` starts with `cursor: null`, and the reader treats a null
 * cursor as "from the end of the file" (`src/server/journal/read.ts`) — so page
 * one is the NEWEST turns, which are exactly the ones the live viewport is
 * showing. They were then prepended above it, and the operator read the same
 * passage twice.
 *
 * Measured against a live session before this existed: 47% of page one's
 * eight-word phrases were already on the screen below it.
 *
 * Comparing rendered lines does not find that overlap. The journal serves the
 * harness's stored MARKDOWN, the viewport shows the harness's RENDERING of the
 * same text, and the viewport wraps to its own width — so the identical message
 * is a different string on each path, and an exact line match reports zero
 * duplicates against a screen that is visibly full of them. Every case here
 * exists because of that.
 */

test("a page whose tail is already on screen is cut at the boundary", () => {
  const page = [
    "The migration plan needs one more pass before it can run on staging.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
    "I have finished reading the auth middleware and it extracts cleanly.",
  ];
  const screen = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "",
    "Waiting for input",
  ];
  expect(trimSeen(page, screen)).toEqual([
    "The migration plan needs one more pass before it can run on staging.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ]);
});

test("a page with nothing on screen is returned whole", () => {
  const page = [
    "The migration plan needs one more pass before it can run on staging.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  const screen = ["Profiling the request path now, nothing to report yet."];
  expect(trimSeen(page, screen)).toEqual(page);
});

test("the viewport wrapping the same sentence does not hide the overlap", () => {
  // The journal holds one long line; the terminal wrapped it into three. This
  // is the normal case, not an edge case — every prose line is wrapped.
  const page = [
    "Earlier turns that are genuinely above the screen and must survive.",
    "I have finished reading the auth middleware and it extracts cleanly into its own module.",
  ];
  const screen = [
    "I have finished reading the auth",
    "middleware and it extracts cleanly",
    "into its own module.",
  ];
  expect(trimSeen(page, screen)).toEqual([
    "Earlier turns that are genuinely above the screen and must survive.",
  ]);
});

test("markdown in the journal does not hide the overlap with its rendering", () => {
  // The journal keeps `**bold**` and backticks; the harness rendered them away
  // before the viewport ever saw them.
  const page = [
    "An older turn that is well above the current screen.",
    "The **install URL** change belongs in the next `release notes` file.",
  ];
  const screen = ["The install URL change belongs in the next release notes file."];
  expect(trimSeen(page, screen)).toEqual([
    "An older turn that is well above the current screen.",
  ]);
});

test("blank and short lines inside the seen tail do not break the run", () => {
  const page = [
    "An older turn that is well above the current screen.",
    "I have finished reading the auth middleware and it extracts cleanly.",
    "",
    "agent · 17:45",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  const screen = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "agent · 17:45",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  expect(trimSeen(page, screen)).toEqual([
    "An older turn that is well above the current screen.",
  ]);
});

test("a short line alone is never enough to trim", () => {
  // "Done." appearing on both sides is a coincidence, not a duplicated turn.
  // Trimming on it would silently swallow the real history above it.
  const page = [
    "The migration plan needs one more pass before it can run on staging.",
    "Done.",
  ];
  const screen = ["Done.", "", "Waiting for input"];
  expect(trimSeen(page, screen)).toEqual(page);
});

test("a page entirely on screen trims to nothing", () => {
  // The caller has to notice this and fetch the next page, or the tap does
  // nothing — which is the mislabelled control this repo bans.
  const page = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  const screen = [...page];
  expect(trimSeen(page, screen)).toEqual([]);
});

test("a tool call the viewport draws differently does not end the run", () => {
  // THE case that broke the first version of this, taken from live data. The
  // journal writes `▸ Bash · …` for a tool call; the viewport renders tool
  // calls another way entirely, so that line matches nothing on screen while
  // the prose either side of it matches perfectly. A walk that stopped at the
  // first miss stopped on line two and trimmed nothing at all.
  const page = [
    "A genuinely older turn that is nowhere near the visible screen at all.",
    "I have finished reading the auth middleware and it extracts cleanly.",
    "▸ Bash · Check whether the rollback path is reachable",
    "▸ Bash · Re-read the migration plan from the top",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  const screen = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  expect(trimSeen(page, screen)).toEqual([
    "A genuinely older turn that is nowhere near the visible screen at all.",
  ]);
});

test("a long run of unmatched lines ends the run", () => {
  // The other half of that trade. Tolerating misses cannot mean tolerating any
  // number of them, or a single coincidental match at the top of the page would
  // swallow everything below it.
  const page = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "Older turn one, which is nowhere near the visible screen at all.",
    "Older turn two, which is nowhere near the visible screen at all.",
    "Older turn three, which is nowhere near the visible screen at all.",
    "Older turn four, which is nowhere near the visible screen at all.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  const screen = [
    "I have finished reading the auth middleware and it extracts cleanly.",
    "Rollback is a single DROP INDEX, so the blast radius stays small.",
  ];
  // Cut at the last line still found on screen; the four older turns survive.
  expect(trimSeen(page, screen)).toEqual(page.slice(0, 5));
});

test("ANSI in either source is ignored", () => {
  const page = ["\x1b[1mI have finished reading the auth middleware and it extracts cleanly.\x1b[0m"];
  const screen = ["I have finished reading the auth middleware and it extracts cleanly."];
  expect(trimSeen(page, screen)).toEqual([]);
});

test("an empty screen trims nothing", () => {
  const page = ["The migration plan needs one more pass before it can run on staging."];
  expect(trimSeen(page, [])).toEqual(page);
});
