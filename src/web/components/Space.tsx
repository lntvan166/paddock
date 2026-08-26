import { useCallback, useEffect, useState } from "react";
import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { SpacePicker } from "@web/components/SpacePicker";
import { TabRow } from "@web/components/TabRow";
import { useStore } from "@web/store";
import type { SpaceTree } from "@shared/types";

/**
 * One space: its tabs, and the controls that act on them.
 *
 * This is the level the superseded §6 argued against, on a measurement that
 * counted children per space. What it did not count was controls per row —
 * eleven spaces each carrying a link, a `⋯` and a `+` put 33 tap targets on
 * one viewport while fitting every row without a scroll. This screen is where
 * those controls belong: you have already chosen what you are managing.
 *
 * It reads the SAME `GET /api/spaces` tree the list does and selects its own
 * space out of it. No per-space endpoint, because the tree is one call and
 * this screen also needs every other space for its picker.
 */
export function Space({
  spaceId, onBack, load = fetchSpaceTree, senders, createSenders, navigate,
}: {
  spaceId: string;
  /** Leaves for the list. There is only one route into this screen, so this
   *  takes no target — see `App.tsx`. */
  onBack: () => void;
  /** Injected for the same reason `Spaces` injects it: a test drives this
   *  without a network, and a failure is a value this renders rather than a
   *  thrown promise. */
  load?: () => Promise<SpaceTree>;
  senders?: RowSenders;
  createSenders?: CreateSenders;
  navigate?: (hash: string) => void;
}) {
  const { treeStaleAt, spacesAvailable } = useStore();
  const [tree, setTree] = useState<SpaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTree(await load());
      setError(null);
    } catch (err) {
      // The last good tree is KEPT. An empty screen and a broken herdr must
      // never look alike.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  // Refetches on mount and whenever the server says the tree MOVED. The server
  // sends `tree-stale` for structure only, so this does not fire on every
  // agent state change.
  useEffect(() => { void refresh(); }, [refresh, treeStaleAt]);

  const space = tree?.spaces.find((s) => s.spaceId === spaceId) ?? null;

  // Every cwd in the WHOLE tree, for the create sheet's quick picks (§9.3) —
  // not just this space's. A new tab commonly goes where another space already
  // is.
  const cwds = tree === null
    ? []
    : [...new Set(tree.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.cwd))))].sort();

  // The same capability the entry point is gated on, never a demo flag and
  // never a device check: with no herdr session the create routes 404 honestly,
  // so a `+` would be a control that always errors.
  const canCreate = spacesAvailable;

  /*
   * The screen's shell, defined once and used by every branch below.
   *
   * All four states — read failed with nothing held, space gone, still
   * loading, and the space itself — render the same `<main>`, the same
   * `<header>`, and the same back control. Only the header's EXTRA content and
   * the body differ, so those are the two parameters. An earlier draft
   * inlined the wrapper again for the normal state, which left two literal
   * copies of it and a comment claiming there was one.
   *
   * There is only one route into this screen, so the back control takes no
   * target.
   */
  const screen = (headerExtra: React.ReactNode, body: React.ReactNode) => (
    <main className="dash mx-auto max-w-2xl safe-bottom">
      <header className="space-screen-head">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to spaces">
          ‹ Spaces
        </button>
        {headerExtra}
      </header>
      {body}
    </main>
  );

  // The read failed and nothing is held from a previous one. Said, never
  // rendered as a space that happens to have no tabs.
  if (error !== null && tree === null) {
    return screen(null, <p className="error" role="alert">{error}</p>);
  }

  // Tree read, no such space. Said explicitly rather than rendered as a space
  // with no tabs, which is indistinguishable from a real one that has none.
  if (tree !== null && space === null) {
    return screen(null, (
      <>
        <p className="empty">That space is gone.</p>
        {/* Both facts, when both are true. The gone-ness was confirmed by a
            good read, and a LATER read failing does not make it less true —
            but a failed refetch that renders nothing is the swallowed error
            this project's rules forbid. */}
        {error !== null && <p className="error" role="alert">{error}</p>}
        <p><a href="#/spaces">All spaces</a></p>
      </>
    ));
  }

  // Still loading: no tree yet, and no error to show.
  if (tree === null || space === null) return screen(null, null);

  const spaceRenames: RenameTarget[] = [
    { kind: "space", id: space.spaceId, current: space.label },
  ];
  const panes = space.tabs.flatMap((t) => t.panes);

  return screen(
    <>
      <SpacePicker spaces={tree.spaces} currentId={space.spaceId} navigate={navigate} />
      {/* The SPACE's actions. Its position — in the header, beside the
          space's own name — is what separates it from the `⋯` on each tab
          row below. */}
      <RowActions
        label={space.label ?? space.spaceId}
        renames={spaceRenames}
        close={{ kind: "space", id: space.spaceId, panes }}
        onChanged={() => void refresh()}
        senders={senders}
      />
    </>,
    <>
      {error !== null && <p className="error" role="alert">{error}</p>}

      <ul className="tabs">
        {space.tabs.map((t) => (
          <TabRow
            key={t.tabId}
            tab={t}
            // Every write refetches, win or lose (§11) — no optimistic
            // update, because this screen's value is being accurate about
            // someone else's state.
            onChanged={() => void refresh()}
            senders={senders}
          />
        ))}
        {canCreate && (
          <li className="tab-create">
            <CreateSheet
              variant="row"
              target={{
                kind: "tab",
                spaceId: space.spaceId,
                // `space.label`, NOT the id fallback: handing the fallback on
                // made a herdr COORDINATE an agent's suggested name.
                spaceLabel: space.label,
                // The space's cwd is its FIRST pane's. Null asks herdr for its
                // default rather than guessing a path.
                spaceCwd: panes[0]?.cwd ?? null,
              }}
              cwds={cwds}
              onChanged={() => void refresh()}
              senders={createSenders}
              navigate={navigate}
            />
          </li>
        )}
      </ul>
    </>,
  );
}
