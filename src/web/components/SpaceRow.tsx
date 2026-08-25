import { paneHash } from "@shared/route";
import type { Space, TreePane } from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * One space, and its panes only when there is something to show.
 *
 * "Structured" means more than one pane or more than one tab. A space with
 * one tab and one pane has neither, so it renders as a SINGLE row with no
 * chevron — there is nothing to expand, and offering a control that reveals
 * nothing is worse than offering none. Most spaces are that shape.
 */
export function SpaceRow({ space, open, onToggle }: {
  space: Space;
  open: boolean;
  onToggle: () => void;
}) {
  const panes = space.tabs.flatMap((t) => t.panes);
  const structured = panes.length > 1 || space.tabs.length > 1;
  const only = !structured ? panes[0] ?? null : null;

  // The SPACE's own label, unconditionally — same as a structured row. A
  // merged row used to show the pane's identity here instead, which hid the
  // space's label on six spaces out of seven (most spaces are 1:1:1). A later
  // plan adds workspace.rename, which writes exactly this field: on a shell
  // pane (no name, no matching title) renaming the space would have produced
  // no visible change at all — the same "control that appears to do
  // nothing" defect the design doc cites as the reason paddock refuses
  // pane.rename (§7.1), recreated in mirror image.
  const spaceLabel = space.label ?? space.spaceId;
  // The merged pane's own identity, shown as a SECONDARY string and only
  // when it says something the space label does not. Most merged rows have
  // an agent whose name matches its space, so this stays silent for the
  // common case; a bare shell (no name) is identified by its title, which is
  // the one case this exists for.
  const paneIdentity = only ? (only.name ?? only.title) : null;
  const showAlias = paneIdentity !== null && paneIdentity !== spaceLabel;
  // The visible label, in full, so the ⋯ button's accessible name never
  // diverges from what the row actually shows — WCAG's "label in name": an
  // aria-label built from spaceLabel alone would go accessible-name-only
  // silent on the very identity the alias exists to surface.
  const actionsLabel = showAlias ? `${spaceLabel} (${paneIdentity})` : spaceLabel;

  // Built once and rendered from either branch: the space's label is the same
  // on both row shapes, and two copies of it would be free to drift.
  const heading = (
    <div className="space-heading">
      <span className="space-name">{spaceLabel}</span>
      {showAlias && <span className="space-alias">{paneIdentity}</span>}
    </div>
  );

  return (
    <li
      data-space-row
      data-space-id={space.spaceId}
      // A merged row (only !== null) IS both the space and its single pane —
      // there is no separate sub-row to carry `data-pane-row`, so this row
      // carries both attributes. A structured space's row never gets
      // `data-pane-row`: its panes each carry their own below, and a rollup
      // here would say the same thing twice.
      {...(only ? { "data-pane-row": true, "data-state": only.state ?? "none" } : {})}
    >
      <div className="space-head">
        {structured && (
          <button
            data-expand
            type="button"
            aria-expanded={open}
            onClick={onToggle}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="sr-only">{open ? "Collapse" : "Expand"} {spaceLabel}</span>
          </button>
        )}
        {/* A merged row IS its single pane, so the whole row opens it — the
            same `paneHash` link a structured space's sub-rows already carry.
            Without it the commonest space shape (six in seven are 1:1:1) had
            no route into the terminal at all: a pane you could see, name and
            read a state off, and not open.

            A merged row also shows the single pane's state and marker inside
            the link; a structured one shows neither here, because its panes
            each carry their own below and a rollup would say the same thing
            twice.

            The ⋯ button stays a SIBLING of the anchor, never a child: a
            <button> inside an <a> is invalid HTML and unreachable by
            keyboard. */}
        {only ? (
          <a href={paneHash(only.paneId)}>
            <PaneMarker pane={only} />
            {heading}
            <PaneState pane={only} />
          </a>
        ) : (
          <>
            {heading}
            <span className="space-count">{space.tabCount} tabs</span>
          </>
        )}
        {/* Inert here. Plan 2 opens the actions sheet from it. Rendered now so
            the row's layout is settled and the affordance is VISIBLE — an
            unhinted long-press is the touch equivalent of a hover-only
            control, which the UI rules ban. */}
        <button type="button" className="row-more" disabled aria-label={`Actions for ${actionsLabel}`}>⋯</button>
      </div>

      {structured && open && (
        <ul className="space-tabs">
          {space.tabs.map((t) => (
            <li key={t.tabId}>
              {/* An unnamed tab has no heading of its own: "1" is not a name,
                  and a heading that repeats the row below is noise. */}
              {t.label !== null && <h3 className="tab-name">{t.label}</h3>}
              <ul>
                {t.panes.map((p) => (
                  <li key={p.paneId} data-pane-row data-state={p.state ?? "none"}>
                    <a href={paneHash(p.paneId)}>
                      <PaneMarker pane={p} />
                      <span className="pane-name">{p.name ?? p.title ?? p.paneId}</span>
                      <PaneState pane={p} />
                    </a>
                    <button type="button" className="row-more" disabled aria-label={`Actions for ${p.name ?? p.paneId}`}>⋯</button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A shell has no state, so it gets no StatusDot — that component's whole
 *  contract is that a dot MEANS one of four states. */
function PaneMarker({ pane }: { pane: TreePane }) {
  if (pane.state === null) return <span className="dot-none" aria-hidden="true" />;
  return <StatusDot state={pane.state} />;
}

/** Colour is never the only channel — StatusDot is aria-hidden, so the state
 *  has to be readable as text right here. */
function PaneState({ pane }: { pane: TreePane }) {
  return <span className="pane-state">{pane.state ?? "no agent"}</span>;
}
