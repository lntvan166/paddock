/**
 * The controls the site's tour points at.
 *
 * In `shared/` rather than `web/` because BOTH sides need it: the app renders
 * the attributes, and the site's tour queries them across an iframe boundary.
 * A second copy would be a contract with itself.
 *
 * The attributes are rendered UNCONDITIONALLY, in every build. `CLAUDE.md`
 * states the property that keeps the demo honest — "there are no demo branches
 * in any component" — and a conditional attribute would be exactly such a
 * branch. A static string of a few dozen bytes has no code path to drift.
 */
export const TOUR_ANCHORS = [
  "needs-you",
  "answer-options",
  "reply-field",
  "space-tree",
  "theme-picker",
  // LAST, and deliberately. Leaving a file view sends the hash back to the pane
  // the file was opened from (`App.tsx`'s FileScreen `onBack`), which is right
  // when a person taps Back and wrong for a tour that navigates onward — it
  // bounced the two steps that used to follow it. Nothing follows it now.
  "file-frame",
] as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[number];
