import { spaceHash } from "@shared/route";
import type { Space } from "@shared/types";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { spaceState } from "@web/components/space-sort";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * One space, as a row in the list.
 *
 * Three things and one control, in this order: what it is, how it is doing,
 * how big it is, and a `⋯`. The count is the cheap honest answer to "is there
 * structure in here" — a `1` opens onto one tab, a `4` is worth the tap.
 *
 * THE `⋯` IS BACK, AND THIS IS THE SECOND TIME THIS ROW HAS CHANGED SHAPE.
 *
 * It originally carried a `⋯`, a `+`, a chevron, an alias and its panes'
 * sub-rows: 33 tap targets across eleven spaces at 390px, on a screen whose
 * eleven rows all fitted without a scroll. The problem was never vertical
 * space — a list had become a control panel — so everything went to
 * `#/space/<id>`, where the operator has already chosen what they are
 * managing.
 *
 * Then the operator used it and asked for the `⋯` back. That is not a
 * reversal of the measurement, it is the measurement meeting a fact it could
 * not see: renaming or closing a space is common enough that a drill-down to
 * reach it is a tax on the common case. The `+` stays gone, which is the half
 * that mattered — an eleven-times-repeated control for something done rarely.
 *
 * So the row is 2 targets, not 1 and not 3. The guard in
 * `tests/spaces-screen.test.tsx` was amended deliberately alongside this, and
 * the spec's §5.1 with it; loosening the assertion quietly would have been the
 * defect, not the change itself.
 */
export function SpaceRow({ space, onChanged, senders }: {
  space: Space;
  /** Re-read the tree after a write, win or lose — §11's no optimistic
   *  updates rule. The list re-reads rather than editing the tree in hand. */
  onChanged: () => void;
  senders?: RowSenders;
}) {
  // Falls back to the id so the row says something. A space can be unnamed; a
  // row cannot be blank. This is the fallback that must NEVER be passed on to
  // anything that writes — handing it to a create sheet made a herdr
  // coordinate an agent's suggested name.
  const label = space.label ?? space.spaceId;
  const state = spaceState(space);

  return (
    <li data-space-row data-space-id={space.spaceId} data-state={state ?? "none"}>
      <a href={spaceHash(space.spaceId)}>
        {/* `StateMarker` carries the null-state rule for every surface that
            shows one — see `ui/StateMarker.tsx`. */}
        <StateMarker state={state} />
        <span className="space-name">{label}</span>
        {/* Colour is never the only channel: StatusDot is aria-hidden, and this
            palette spends red and green on the two states that matter most. */}
        <span className="space-state">{state ?? NO_AGENT}</span>
        {/* A bare number, in mono, because it is a quantity to compare down a
            column rather than a sentence to read. The pluralised
            "2 tabs"/"1 pane" phrasing went with the merged row that needed to
            explain its own shape. `aria-label` carries the unit for a screen
            reader — a bare numeral read aloud is "docs-cleanup, working, 2":
            two of what? — without changing what a sighted operator sees. */}
        <span className="space-count" aria-label={`${space.paneCount} panes`}>{space.paneCount}</span>
      </a>
      {/* A SIBLING of the anchor, never a child: a <button> inside an <a> is
          invalid HTML and unreachable by keyboard — the trap `RowActions` and
          `TabRow` both carry notes about.

          Space-scoped only. Renaming a TAB or an agent still belongs to
          `#/space/<id>`, where the row you tap is the tab you mean; offering
          them here would put a control on the list whose target the list does
          not show, which is how this screen became a control panel the first
          time. */}
      <RowActions
        label={label}
        renames={[{ kind: "space", id: space.spaceId, current: space.label } as RenameTarget]}
        close={{ kind: "space", id: space.spaceId, panes: space.tabs.flatMap((t) => t.panes) }}
        onChanged={onChanged}
        senders={senders}
      />
    </li>
  );
}
