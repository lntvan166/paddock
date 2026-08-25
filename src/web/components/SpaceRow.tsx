import { spaceHash } from "@shared/route";
import type { Space } from "@shared/types";
import { spaceState } from "@web/components/space-sort";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * One space, as a row in the list — and nothing else.
 *
 * It used to carry a `⋯`, a `+`, a chevron, an alias and its panes' sub-rows.
 * Measured at 390px with eleven spaces, that was 33 tap targets on a screen
 * whose eleven rows all fitted without a scroll: the problem was never
 * vertical space, it was that a list had become a control panel. Those
 * controls now live on `#/space/<id>`, where the operator has already chosen
 * what they are managing.
 *
 * Three things, in this order: what it is, how it is doing, how big it is. The
 * count is the cheap honest answer to "is there structure in here" — a `1`
 * opens onto one tab, a `4` is worth the tap.
 */
export function SpaceRow({ space }: { space: Space }) {
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
            explain its own shape. */}
        <span className="space-count">{space.paneCount}</span>
      </a>
    </li>
  );
}
