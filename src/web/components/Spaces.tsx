import { useCallback, useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import type { RowSenders } from "@web/components/RowActions";
import { SpaceRow } from "@web/components/SpaceRow";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

const COLLAPSED_KEY = "paddock.spaces.collapsed";

/**
 * `load` is injected so the tests can drive this without a network, and so a
 * failure is a value this component renders rather than a thrown promise.
 */
export function Spaces({ onBack, load = fetchSpaceTree, senders, createSenders, navigate }: {
  onBack: () => void;
  load?: () => Promise<SpaceTree>;
  /** The row actions' five writes, injected for the same reason `load` is:
   *  a component test drives a rename or a close without a network. */
  senders?: RowSenders;
  /** The create sheet's writes, injected for the same reason. */
  createSenders?: CreateSenders;
  /** How the create sheet leaves for the pane it just made. Injected so a
   *  test can observe the navigation instead of mutating the hash. */
  navigate?: (hash: string) => void;
}) {
  const { treeStaleAt, spacesAvailable } = useStore();
  const [tree, setTree] = useState<SpaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

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

  // The "as of" label ticks locally; the server is not asked for time.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const toggle = (spaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) next.delete(spaceId); else next.add(spaceId);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
      return next;
    });
  };

  /**
   * Every working directory already in the tree, once each, in a stable order.
   *
   * The create sheet's quick picks (§9.3). Computed here rather than in the
   * sheet because the HEADER's sheet needs the whole tree's cwds and a row's
   * sheet needs the same list — one expression, two consumers, and the tree is
   * already in hand. Sorted so the list does not reshuffle between renders of
   * the same tree.
   */
  const cwds = tree === null
    ? []
    : [...new Set(tree.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.cwd))))].sort();

  /**
   * Whether the create controls exist at all.
   *
   * The SAME capability the Spaces entry point in `App.tsx` is gated on
   * (`spacesAvailable`, set from the server's own snapshot frame), for the same
   * reason: with no herdr session `POST /api/spaces` 404s honestly, so a `+`
   * would be a control that always errors — which `routes.ts` records as a
   * defect class on `/ack`'s Dismiss button. A capability, never a demo flag,
   * never a hostname, never `import.meta.env`, never a device check.
   */
  const canCreate = spacesAvailable;

  return (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="spaces-head">
        {/* Shared treatment (§16.4): this was the one back control in the
            app not using it. Labelled for its actual destination — the
            dashboard, which is all `onBack` here has ever pointed at. */}
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to agents">
          ‹ Agents
        </button>
        <h2>Spaces</h2>
        {/* §16.7: the `+` that makes a SPACE lives in the header of the screen
            that lists them. Position is what says what it makes, which is why
            it carries no text label — and why the one on each row below,
            which makes a tab in that row's space, looks identical. */}
        {canCreate && (
          <CreateSheet
            target={{ kind: "space" }}
            cwds={cwds}
            onChanged={() => void refresh()}
            senders={createSenders}
            navigate={navigate}
          />
        )}
      </header>

      {error !== null && <p className="error" role="alert">{error}</p>}

      {tree !== null && (
        <ul className="spaces">
          {tree.spaces.map((s) => (
            <SpaceRow
              key={s.spaceId}
              space={s}
              // Defaults to OPEN, for the reason App.tsx gives for idleOpen: a
              // collapsed group shows a count where it could show its
              // contents, and revealing structure is this screen's whole job.
              open={!collapsed.has(s.spaceId)}
              onToggle={() => toggle(s.spaceId)}
              // Every write refetches, win or lose (§11) — no optimistic
              // update, because this screen's value is being accurate about
              // someone else's state rather than about what was asked for.
              onChanged={() => void refresh()}
              senders={senders}
              cwds={cwds}
              canCreate={canCreate}
              createSenders={createSenders}
              navigate={navigate}
            />
          ))}
        </ul>
      )}

      {tree !== null && (
        <footer className="spaces-foot">
          <span>{tree.spaces.length} spaces</span>
          {/* Says WHEN it read, because this screen is on-demand and an
              implied-live one would be a guess rendered as a fact. */}
          <button type="button" onClick={() => void refresh()}>
            as of {Math.max(0, Math.round((now - tree.readAt) / 1000))}s ago ⟳
          </button>
        </footer>
      )}
    </main>
  );
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
