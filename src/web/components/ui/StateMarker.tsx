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
 * No `surfaceVar` parameter: every surface this renders on — the spaces list,
 * a tab row, the picker sheet — sits on the page's own ground, so
 * `StatusDot`'s default (`--bg`) is always right here. The one caller that
 * passed `--surface` was wrong (the picker sheet's ground is `--bg`, from
 * `.row-actions-sheet`, not `--surface`), and an unused parameter that a
 * caller can still get wrong is a trap worth removing rather than
 * re-documenting.
 */
export function StateMarker({ state }: {
  state: AgentState | null;
}) {
  if (state === null) return <span className="dot-none" aria-hidden="true" />;
  return <StatusDot state={state} />;
}
