import type { History } from "@web/history";

/**
 * Per-agent render caches, and the one place they are evicted.
 *
 * Both live for the page, not the component: `AgentTerminal` is remounted per
 * agent (and on every navigation), so anything held inside it would be thrown
 * away exactly when it is most useful — reopening the agent you just left.
 *
 * Deliberately in memory rather than in localStorage or IndexedDB. Terminal
 * output is an operator's real work, and keeping it off the device's disk is
 * worth losing it on reload. A new browser tab therefore starts with no
 * history at all, which is the intended behaviour and not a bug.
 *
 * They were previously two Maps inside the component file with NO eviction at
 * all: `store.ts` prunes agents that disappear, but nothing told the caches,
 * so they grew by one entry per agent ever opened rather than per agent that
 * exists. At up to ~300 KB of reconstructed scrollback each (HISTORY_CAP is 4000
 * lines), fifty agents across a long session held about 15 MB that no
 * reload-free path could reclaim. `prunePanes` closes that by reusing the signal the agent list
 * already computes.
 */

export interface Screen {
  lines: string[];
  digest: string | null;
}

/**
 * Everything "Show earlier" has learned about an agent's JOURNAL history.
 *
 * Held here for exactly the reason the two caches above are: this used to be
 * four `useState`s inside `AgentTerminal`, which is remounted per agent AND on
 * every navigation. Six taps of history — six round trips, and pages the
 * operator scrolled — were therefore thrown away the moment they went back to
 * the list and reopened the pane, and the only way to see them again was six
 * more taps and six more POSTs. The reconstructed path this replaces does not
 * lose its scrollback on that journey, so losing it here was a REGRESSION for
 * the agents the feature was built for.
 *
 * `cursor` and `done` matter as much as `lines`: without them the reopened
 * pane would re-fetch page one and prepend it to nothing, and `fellBack` is
 * the pane's permanent answer to "does this agent have a journal at all" —
 * re-asking the server on every navigation is the retry that decision 18 says
 * must happen once.
 */
export interface JournalState {
  /** Journal-sourced lines, oldest first. */
  lines: string[];
  /** Opaque cursor for the NEXT (older) page, or null at the beginning. */
  cursor: string | null;
  /** No more journal pages — a genuine `hasMore: false`. */
  done: boolean;
  /** This pane has permanently handed over to the reconstructed path. */
  fellBack: boolean;
}

export const emptyJournal = (): JournalState => ({
  lines: [], cursor: null, done: false, fellBack: false,
});

const screens = new Map<string, Screen>();
const histories = new Map<string, History>();
const journals = new Map<string, JournalState>();

export const screenFor = (agentId: string): Screen | undefined => screens.get(agentId);
export const historyFor = (agentId: string): History | undefined => histories.get(agentId);
export const journalFor = (agentId: string): JournalState | undefined => journals.get(agentId);

export function rememberScreen(agentId: string, screen: Screen): void {
  screens.set(agentId, screen);
}

export function rememberHistory(agentId: string, history: History): void {
  histories.set(agentId, history);
}

/**
 * Read-modify-write in one call, returning the new value.
 *
 * The CACHE is the single source of truth and the component's state is only a
 * mirror that makes React re-render. Patching through a function of the
 * previous CACHED value — rather than of the previous rendered value — is what
 * keeps those two from drifting when an update is applied from a promise
 * callback that closed over an older render.
 */
export function updateJournal(
  agentId: string,
  patch: (prev: JournalState) => JournalState,
): JournalState {
  const next = patch(journals.get(agentId) ?? emptyJournal());
  journals.set(agentId, next);
  return next;
}

/**
 * Drop everything held for agents that no longer exist.
 *
 * Driven by the live agent list rather than by a timer or a size limit, so
 * eviction happens for exactly the reason it should: the agent is gone. An
 * agent still in the list keeps its scrollback however often this runs, which
 * matters because it runs on every change to the list.
 */
export function prunePanes(liveIds: Set<string>): void {
  for (const id of [...screens.keys()]) if (!liveIds.has(id)) screens.delete(id);
  for (const id of [...histories.keys()]) if (!liveIds.has(id)) histories.delete(id);
  for (const id of [...journals.keys()]) if (!liveIds.has(id)) journals.delete(id);
}

/** Entry counts, for tests and for anything that wants to report footprint. */
export function cacheSize(): { screens: number; histories: number; journals: number } {
  return { screens: screens.size, histories: histories.size, journals: journals.size };
}
