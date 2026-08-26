import { useCallback, useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

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
export function useSpaceTree(load: () => Promise<SpaceTree> = fetchSpaceTree): {
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

  return { tree, error, refresh };
}
