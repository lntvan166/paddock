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

const screens = new Map<string, Screen>();
const histories = new Map<string, History>();

export const screenFor = (agentId: string): Screen | undefined => screens.get(agentId);
export const historyFor = (agentId: string): History | undefined => histories.get(agentId);

export function rememberScreen(agentId: string, screen: Screen): void {
  screens.set(agentId, screen);
}

export function rememberHistory(agentId: string, history: History): void {
  histories.set(agentId, history);
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
}

/** Entry counts, for tests and for anything that wants to report footprint. */
export function cacheSize(): { screens: number; histories: number } {
  return { screens: screens.size, histories: histories.size };
}
