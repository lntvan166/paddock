import type { TourAnchor } from "@shared/tour-anchors";

export type Section = { anchor: TourAnchor; heading: string; body: string };

/**
 * One section per tour step, in the same order and pinned to it by a test.
 *
 * The copy is the README's argument, which is already the right one and already
 * checked for public-repo safety. A second, freely-written set of claims here
 * would be a second thing to keep true.
 */
export const SECTIONS: readonly Section[] = [
  {
    anchor: "needs-you",
    heading: "Triage, not a list",
    body: "Agents are grouped into needs you, working and idle — never alphabetically. The ones that have stopped sit at the top, because those are the only ones walking back to the desk would fix.",
  },
  {
    anchor: "answer-options",
    heading: "Answer with its own words",
    body: "A blocked agent's options are read from its screen and shown with their real labels, and the row Enter would commit is named before you tap it. A mislabelled Approve button is worse than no button.",
  },
  {
    anchor: "reply-field",
    heading: "Or reply properly",
    body: "A field that grows to what you wrote, slash-command autocomplete read from the project's own .claude, and a screenshot attached by pasting it.",
  },
  {
    anchor: "space-tree",
    heading: "The whole herd",
    body: "Every space and every tab, not only the agents that happen to be busy. Rename, close, or start something new from the phone.",
  },
  {
    anchor: "theme-picker",
    heading: "Pick a theme",
    body: "paddock's own light and dark, plus Dracula, Gruvbox and Nord — every one checked against WCAG AA, including the state colours. Red always means an agent has stopped and needs you.",
  },
  {
    anchor: "file-frame",
    heading: "Open what an agent made",
    body: "Tap a path in the output to read an HTML page, a PDF or an image on the phone, or download it — sandboxed twice, so a page an agent wrote can never reach paddock's own API.",
  },
];

/**
 * Which section the phone should follow.
 *
 * The MOST VISIBLE one, not the first intersecting one: two sections share the
 * viewport for most of a scroll, and taking the first changes the phone's
 * screen while the copy beside it still describes the previous one.
 */
export function sectionForScroll(entries: { anchor: string; ratio: number }[]): string | null {
  let best: { anchor: string; ratio: number } | null = null;
  for (const e of entries) {
    if (e.ratio <= 0) continue;
    if (best === null || e.ratio > best.ratio) best = e;
  }
  return best?.anchor ?? null;
}
