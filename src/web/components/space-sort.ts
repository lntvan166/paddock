import type { AgentState, Space } from "@shared/types";

/**
 * How bad a state is, for picking a space's rollup.
 *
 * `Space` carries no state of its own — herdr's snapshot describes panes — so
 * the list and the picker both have to derive one, and deriving it twice is
 * how two screens come to disagree about the same space.
 */
const SEVERITY: Record<AgentState, number> = {
  blocked: 0, working: 1, done: 2, idle: 3,
};

/**
 * Which bucket a space sorts into, which is NOT the same question.
 *
 * §5.1 asks for blocked, then working, then everything else, then spaces with
 * no agent. `done` and `idle` therefore rank EQUAL here while ranking
 * differently in `SEVERITY` above: the rollup has to choose between them, the
 * order does not care. Collapsing them also buys something specific — see the
 * stability note on `sortSpaces`.
 */
const BUCKET: Record<AgentState, number> = {
  blocked: 0, working: 1, done: 2, idle: 2,
};
const NO_AGENT_BUCKET = 3;

/**
 * The worst state any pane in this space is in, or null when none of them has
 * one.
 *
 * Null is not `idle` and must not become it. A space holding only shells has
 * no triage state at all — the same discipline `TreePane.state` documents, and
 * the reason `.dot-none` exists as a separate marker.
 */
export function spaceState(space: Space): AgentState | null {
  let worst: AgentState | null = null;
  for (const tab of space.tabs) {
    for (const pane of tab.panes) {
      if (pane.state === null) continue;
      if (worst === null || SEVERITY[pane.state] < SEVERITY[worst]) worst = pane.state;
    }
  }
  return worst;
}

/**
 * The spaces in the order the list and the picker both show them.
 *
 * A NEW array: the tree this reads from is React state, and sorting in place
 * would mutate it.
 *
 * `Array.prototype.sort` is stable, and `done`/`idle` sharing a bucket is what
 * makes that matter — two spaces the operator sees as equally quiet keep
 * herdr's own order between them across a re-read, so a refetch does not
 * reshuffle rows under a thumb.
 */
export function sortSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort((a, b) => bucketOf(a) - bucketOf(b));
}

function bucketOf(space: Space): number {
  const state = spaceState(space);
  return state === null ? NO_AGENT_BUCKET : BUCKET[state];
}
