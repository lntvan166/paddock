import type { TourAnchor } from "@shared/tour-anchors";

/**
 * What pressing Next demonstrates, if anything.
 *
 * A NAME rather than a function, so this file stays data: performing one needs
 * the iframe, which the site owns. The demo is synthetic throughout, so these
 * do not have to be "real" in any deeper sense than the demo itself is — what
 * matters is that the visitor sees the state the control produces.
 */
export type TourAct = "answer-option" | "send-reply";

export type TourStep = {
  anchor: TourAnchor;
  /** The demo's hash for this step. Routing is hash-only, so this is the whole
   *  of "navigate the app" — see src/web/route.ts. */
  hash: string;
  title: string;
  body: string;
  /** Performed as the visitor presses Next, so the demo moves with the story. */
  act?: TourAct;
  /** The line `send-reply` types. Present only on that step. */
  reply?: string;
};

/** Invented, like every other fixture here. See CLAUDE.md. `d1:p1` is the
 *  demo's blocked agent, encoded because pane ids contain a colon. */
const BLOCKED_AGENT = "d1%3Ap1";
const DEMO_FILE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    anchor: "needs-you",
    hash: "#/",
    title: "Grouped by what wants you",
    body: "Not alphabetically. Agents that have stopped and need an answer sit at the top, so triage is a glance rather than a search.",
  },
  {
    anchor: "answer-options",
    hash: `#/pane/${BLOCKED_AGENT}`,
    title: "Its own words, not a guess",
    body: "These are the agent's real option labels, read from its screen — never invented. The row Enter would commit is named before you tap it. Next answers it.",
    act: "answer-option",
  },
  {
    anchor: "reply-field",
    hash: `#/pane/${BLOCKED_AGENT}`,
    title: "Or answer properly",
    body: "A field that grows to what you wrote, with slash-commands read from the project's own .claude — and a screenshot attached by pasting it. Next sends one.",
    act: "send-reply",
    reply: "hold off on staging until the backfill finishes",
  },
  {
    anchor: "space-tree",
    hash: "#/spaces",
    title: "Every space, every tab",
    body: "The whole herd, not just the agents that happen to be busy. Rename, close, or start something new from here.",
  },
  {
    anchor: "theme-picker",
    hash: "#/settings",
    title: "Five themes, all legible",
    body: "paddock's own light and dark, plus Dracula, Gruvbox and Nord — each checked against WCAG AA, including the state colours. Red always means an agent has stopped.",
  },
  {
    anchor: "file-frame",
    hash: `#/file/${DEMO_FILE}`,
    title: "Open what it made",
    body: "Tap a path in the output and the page, PDF or image opens here — sandboxed twice, so a page an agent wrote can never reach paddock's own API.",
  },
];
