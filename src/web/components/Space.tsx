import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { SpacePicker } from "@web/components/SpacePicker";
import { treeCwds } from "@web/components/space-sort";
import { TabRow } from "@web/components/TabRow";
import { useSpaceTree } from "@web/components/use-space-tree";
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
  /** Leaves for the list. Unconditional rather than origin-aware, because the
   *  picker (`SpacePicker.tsx`) moves SIDEWAYS between spaces — `#/space/w1`
   *  to `#/space/w2` — rather than nesting one on top of another, so there is
   *  no stack of prior spaces to pop back through. See `App.tsx`. */
  onBack: () => void;
  /** Injected for the same reason `Spaces` injects it: a test drives this
   *  without a network, and a failure is a value this renders rather than a
   *  thrown promise. */
  load?: () => Promise<SpaceTree>;
  senders?: RowSenders;
  createSenders?: CreateSenders;
  navigate?: (hash: string) => void;
}) {
  const { spacesAvailable } = useStore();
  const { tree, error, refresh } = useSpaceTree(load);

  const space = tree?.spaces.find((s) => s.spaceId === spaceId) ?? null;

  // Every cwd in the WHOLE tree, for the create sheet's quick picks (§9.3) —
  // not just this space's. A new tab commonly goes where another space already
  // is. `treeCwds` so this and the spaces list agree on the rule.
  const cwds = treeCwds(tree);

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
   * The back control takes no target because it needs none: the picker
   * (`SpacePicker.tsx`) is a second route into this screen, but it switches
   * spaces SIDEWAYS rather than nesting one on top of another, so there is
   * never a stack of prior spaces for back to pop.
   */
  const screen = (headerExtra: React.ReactNode, body: React.ReactNode) => (
    // `screen`, not a flowing column — Back must stay reachable at any scroll
    // position. See the `.screen, .term` block in styles.css. That this shell
    // was already defined once, for all four states, is why the change is one
    // edit here rather than four.
    <main className="screen">
      <header className="space-screen-head screen-chrome">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back to spaces">
          ‹ Spaces
        </button>
        {headerExtra}
      </header>
      <div className="screen-body">{body}</div>
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
