import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

/**
 * How often the Spaces screens re-read the tree while visible.
 *
 * Three seconds, which is the operator's own number. A tree read is one
 * `session.snapshot` against herdr's socket — the same call the dashboard's
 * own poll already makes — so the marginal cost is one local round trip per
 * open Spaces screen, and only while the tab is in front.
 */
const SPACE_POLL_MS = 3_000;

/**
 * The space tree that `Spaces.tsx` and `Space.tsx` both read — the SAME
 * `GET /api/spaces` call, refetched on mount and again whenever the server
 * says the structure moved.
 *
 * Both screens held byte-identical copies of this state pair, this
 * `refresh` callback, and this effect. The branch that hoisted the two-line
 * null-state rule into `ui/StateMarker.tsx` set the standard this follows —
 * ~30 duplicated lines cannot stand on a lower one.
 *
 * `load` is injected so a test can drive this without a network, and so a
 * failure is a value the caller renders rather than a thrown promise.
 */
export function useSpaceTree(
  load: () => Promise<SpaceTree> = fetchSpaceTree,
  /**
   * Whether this tree is the one in front of the operator.
   *
   * `document.hidden` used to be the whole question, and was right while
   * exactly one screen rendered at a time. The pager mounts all three, so the
   * document is visible while this screen sits one swipe away — and two
   * off-screen tabs polling herdr every three seconds is work with no reader.
   *
   * Defaults to `true` so `Space.tsx`, a pushed screen that is always the one
   * in front when it exists, needs no change.
   */
  active = true,
): {
  tree: SpaceTree | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { treeStaleAt } = useStore();
  const [tree, setTree] = useState<SpaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTree(await load());
      setError(null);
    } catch (err) {
      // The last good tree is KEPT. An empty screen and a broken herdr must
      // never look alike — that is the same rule the 502 in the route serves.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  // Refetches on mount and whenever the server says the tree moved. The
  // server sends `tree-stale` for STRUCTURE only, so this does not fire on
  // every agent state change.
  useEffect(() => { void refresh(); }, [refresh, treeStaleAt]);

  /**
   * A poll underneath the event, not instead of it.
   *
   * `tree-stale` is faster and cheaper than any interval and stays the primary
   * signal — this is the FLOOR, for everything the event cannot see. An agent
   * whose state moves from working to blocked changes what a space row says
   * without changing the session's structure, so no `tree-stale` fires and a
   * screen left open would show the old rollup until something else nudged it.
   *
   * Paused while the document is hidden. A phone in a pocket is the common
   * case for a screen like this, and polling herdr every three seconds for a
   * tree nobody is looking at is a cost with no reader.
   */
  // Whether this screen was already in front last time the effect ran. Only a
  // TRANSITION into active is worth a catch-up read; being active at mount is
  // not, because the effect above has just done that exact read. Refreshing
  // unconditionally here made every mount fetch the tree twice — caught by
  // `space-screen.test.tsx`, which counts the reads.
  const wasActive = useRef(active);

  useEffect(() => {
    if (!active) { wasActive.current = false; return; }
    // Arriving on the tab refreshes at once rather than waiting out a full
    // interval with a stale screen in front of the operator — the same
    // reasoning the `visibilitychange` handler below already gives.
    if (!wasActive.current) void refresh();
    wasActive.current = true;
    const tick = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(tick, SPACE_POLL_MS);
    // Catch up immediately on return rather than waiting out a full interval
    // with a stale screen on display — the same reasoning `PaneTerminal`'s
    // own `visibilitychange` handler gives.
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, active]);

  return { tree, error, refresh };
}
