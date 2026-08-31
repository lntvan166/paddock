/**
 * The controls the site's tour points at.
 *
 * In `shared/` rather than `web/` because BOTH sides need it: the app renders
 * the attributes, and the site's tour queries them across an iframe boundary.
 * A second copy would be a contract with itself.
 *
 * The attributes are rendered UNCONDITIONALLY, in every build. `demo.yml`
 * states the property that keeps the demo honest — "there are no demo branches
 * in any component" — and a conditional attribute would be exactly such a
 * branch. A static string of a few dozen bytes has no code path to drift.
 */
export const TOUR_ANCHORS = [
  "needs-you",
  "answer-options",
  "reply-field",
  "file-frame",
  "space-tree",
  "theme-picker",
] as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[number];
