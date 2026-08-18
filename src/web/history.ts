/**
 * Accumulating a scrollback transcript from viewport snapshots.
 *
 * paddock cannot stream output: herdr exposes snapshots of a fixed-size
 * viewport and no byte stream (there is no output-changed event either — all
 * 27 subscribable kinds were checked). So history has to be RECONSTRUCTED by
 * noticing what scrolled off the top between one snapshot and the next.
 *
 * The naive version — append whatever is new — is badly wrong, because the
 * bottom of a coding agent's screen is rewritten constantly by spinners and
 * elapsed-time counters. Measured across 23 consecutive snapshots of a live
 * agent, 22 changed ONLY their tail and none was a clean whole-screen scroll.
 * Appending on any difference would paste the same timer line into history
 * dozens of times.
 *
 * What that measurement does show is that the TOP is stable, which is exactly
 * what makes the scroll offset findable: match a window of lines from the top
 * of the new snapshot against the previous one, and the offset where they line
 * up is how far the view scrolled. Only lines above that offset have provably
 * left the screen, and only those are committed.
 *
 * Pure, and deliberately free of React, the DOM and ANSI. This is the piece
 * most likely to need tuning against a new agent TUI, and that tuning should
 * be a change to one file with tests rather than a change to a component.
 */

/**
 * Lines of reconstructed scrollback kept per agent, oldest trimmed first.
 *
 * Sized for the case it exists to serve: re-reading an agent's analysis while
 * deciding how to answer it. That decision happens while the agent is BLOCKED,
 * and herdr refuses every scrollback source in that state (`agent_not_idle`,
 * measured) — so whatever is not already held here cannot be fetched at the
 * moment it is wanted. The cap is the entire budget for that.
 *
 * At ~75 characters per line with colour, 4000 lines is roughly 300 KB per
 * agent, and `pane-cache.ts` evicts an agent's copy as soon as it disappears,
 * so the total tracks the agents that actually exist rather than every one
 * ever opened.
 */
export const HISTORY_CAP = 4_000;

/**
 * Lines that must line up before a scroll is believed.
 *
 * Too small and a screen padded with blanks matches at any offset, inventing
 * scrolls and duplicating real content. Too large and it exceeds the stable
 * region, so a genuine scroll is never recognised and history stays empty.
 * Twelve sits inside the ~60% of the viewport measured as stable while still
 * being far too specific to match by accident.
 */
const MATCH_WINDOW = 12;

export interface History {
  /** Lines that have scrolled off screen, oldest first. */
  settled: string[];
  /** Times reconciliation failed and history is therefore not continuous. */
  gaps: number;
  /** The snapshot this history was last reconciled against. */
  last?: string[];
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * How far `next` scrolled relative to `prev`, or null if it cannot be told.
 *
 * Returns the SMALLEST offset that fits. A viewport full of blank lines
 * matches itself at many offsets, and taking the largest would report a scroll
 * that never happened, committing lines that are still on screen.
 */
function scrollOffset(prev: string[], next: string[]): number | null {
  // Capped at half the screen, because after scrolling by k the overlap is
  // only `len - k` lines: a window wider than the overlap can never match, and
  // sizing it to the full screen would mean no scroll was ever recognised.
  // The corollary is deliberate — if the view scrolls by MORE than half a
  // screen between polls, there is not enough overlap to place it, and that
  // is reported as a gap rather than guessed at.
  const window = Math.min(MATCH_WINDOW, Math.floor(prev.length / 2), next.length);
  if (window === 0) return null;
  const head = next.slice(0, window);
  for (let k = 0; k + window <= prev.length; k++) {
    let hit = true;
    for (let i = 0; i < window; i++) {
      if (prev[k + i] !== head[i]) { hit = false; break; }
    }
    if (hit) return k;
  }
  return null;
}

/**
 * Fold a new snapshot into the history.
 *
 * The first snapshot settles nothing: every line of it is still on screen, and
 * history is only what has LEFT the screen. Committing it here would duplicate
 * the whole first screen the moment anything scrolled.
 */
export function mergeSnapshot(history: History, snapshot: string[]): History {
  const prev = history.last;
  if (!prev) return { ...history, last: snapshot };

  // Identical snapshots are skipped outright rather than left to the offset
  // search. `apply` is reached from four places — the opening load, the poll,
  // a key press and a reply — so the same screen genuinely arrives more than
  // once, and re-running the search on it is both wasted work and one more
  // chance to commit something twice.
  if (sameLines(prev, snapshot)) return history;

  const k = scrollOffset(prev, snapshot);
  if (k === null) {
    // A full repaint, or several scrolls missed between polls. Appending the
    // old screen would duplicate; appending the new one would lie about
    // ordering. Record the discontinuity and carry on.
    return { settled: history.settled, gaps: history.gaps + 1, last: snapshot };
  }
  if (k === 0) return { ...history, last: snapshot };

  const settled = [...history.settled, ...prev.slice(0, k)];
  return {
    settled: settled.length > HISTORY_CAP ? settled.slice(settled.length - HISTORY_CAP) : settled,
    gaps: history.gaps,
    last: snapshot,
  };
}
