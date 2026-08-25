import { paneHash } from "@shared/route";
import type { Tab, TreePane } from "@shared/types";
import { paneLabel } from "@web/components/pane-label";
import { RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * One tab as a row, with its panes under it only when it holds more than one.
 *
 * This is the merged-row principle the superseded §6 applied at SPACE level,
 * moved down one. It is what keeps a drill-down affordable on a flat herd:
 * every tab on the machine this was measured against holds exactly one pane,
 * so every tab row is one tap from an agent and no level is spent rendering a
 * single child. Structure appears only where the operator built some.
 *
 * There is no third level. A pane has no children, so a split tab's sub-rows
 * are the end of the tree.
 */
export function TabRow({ tab, onChanged, senders }: {
  tab: Tab;
  /** Re-read the tree. Called after every write, win or lose — §11's no
   *  optimistic updates rule. */
  onChanged: () => void;
  senders?: RowSenders;
}) {
  const split = tab.panes.length > 1;
  // The tab's root pane. A tab with no panes at all is not a shape herdr
  // produces, but reading `[0]` on an empty array would be `undefined` handed
  // to `paneHash` — so the row degrades to a non-link rather than linking to
  // `#/pane/undefined`, the same defect `CreateSheet` guards its navigate on.
  const root: TreePane | null = tab.panes[0] ?? null;

  /**
   * What the row is called.
   *
   * The tab's own label when it has one. When it does not — herdr returns a
   * tab's NUMBER as a string, so null means genuinely unnamed — the ROOT
   * PANE's label stands in, because `tab.tabId` is a herdr coordinate and
   * `docs/gotchas.md` records what those are worth on screen: `w3:t2` is
   * correct and useless.
   */
  const tabName = tab.label ?? (root ? paneLabel(root) : tab.tabId);

  const renames: RenameTarget[] = [
    ...(root !== null && root.harness !== null
      ? [{ kind: "agent", id: root.paneId, current: root.name } as RenameTarget]
      : []),
    { kind: "tab", id: tab.tabId, current: tab.label },
  ];

  return (
    <li data-tab-row data-tab-id={tab.tabId}>
      <div className="tab-head">
        {/* Whatever sits beside this anchor stays a SIBLING of it, never a
            child: a <button> inside an <a> is invalid HTML and unreachable by
            keyboard. */}
        {root !== null ? (
          <a href={paneHash(root.paneId)}>
            {!split && <PaneMarker pane={root} />}
            <span className="tab-heading">
              <span className="tab-name">{tabName}</span>
            </span>
            {split
              ? <span className="tab-count">{tab.panes.length} panes</span>
              : <PaneState pane={root} />}
          </a>
        ) : (
          <span className="tab-heading"><span className="tab-name">{tabName}</span></span>
        )}
        <RowActions
          label={tabName}
          renames={renames}
          // Closing a tab takes its panes with it, which is what the
          // consequence line has to say — counted off the tree already on
          // screen (§10), never fetched.
          close={{ kind: "tab", id: tab.tabId, panes: tab.panes }}
          onChanged={onChanged}
          senders={senders}
        />
      </div>

      {split && (
        <ul className="tab-panes">
          {tab.panes.map((p) => (
            <li key={p.paneId} data-pane-row data-state={p.state ?? "none"}>
              <a href={paneHash(p.paneId)}>
                <PaneMarker pane={p} />
                <span className="pane-heading">
                  <span className="pane-name">{paneLabel(p)}</span>
                </span>
                <PaneState pane={p} />
              </a>
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
