import type { AgentState } from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * What a surface calls something with no agent in it.
 *
 * One string, because three surfaces say it — a tab's panes, a space row, and
 * the space picker — and "No agent" against "no agent" is exactly the kind of
 * drift nothing in the suite would catch.
 */
export const NO_AGENT = "no agent";

/**
 * The dot for something that MAY have a triage state.
 *
 * `StatusDot`'s whole contract is that a dot means one of four states, so a
 * null state cannot go through it. It gets `.dot-none` instead — a complete
 * square, which cannot be mistaken for `idle`'s hollow ring.
 *
 * Takes a STATE rather than a pane, because the callers do not agree on what
 * they hold: a tab row and a pane sub-row have a `TreePane`, while a space row
 * and the space picker have a rollup computed by `space-sort.ts`. A
 * pane-shaped signature would serve one caller and force the others to invent
 * a pane they do not have.
 *
 * `surfaceVar` is passed straight through: a ring dot fills its interior with
 * that variable, so a dot on a sheet has to name the sheet's own ground or the
 * ring reads as a notch cut out of it.
 */
export function StateMarker({ state, surfaceVar }: {
  state: AgentState | null;
  surfaceVar?: string;
}) {
  if (state === null) return <span className="dot-none" aria-hidden="true" />;
  return <StatusDot state={state} surfaceVar={surfaceVar} />;
}
