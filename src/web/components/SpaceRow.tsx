import { paneHash } from "@shared/route";
import type { Space, TreePane } from "@shared/types";
import { CreateSheet, slug, type CreateSenders } from "@web/components/CreateSheet";
import { paneIdentity, paneLabel } from "@web/components/pane-label";
import { plural, RowActions, type RenameTarget, type RowSenders } from "@web/components/RowActions";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/*
 * THE `⋯` AND WHY IT LOOKS LIKE THIS.
 *
 * Every row carried a `disabled` `⋯` with `aria-label="Actions for X"` once,
 * rendered ahead of the sheet that would fill it. Those were removed:
 * announcing an action that cannot happen, on every row, is a mislabelled
 * control, and `CLAUDE.md` rates that worse than none. They were also already
 * diverging — the sub-row's label read `name ?? paneId` while the row read
 * `name ?? title ?? paneId`, so a shell announced `w3:p1` under visible text
 * saying "bash".
 *
 * The `⋯` is back, with the sheet that fills it, and the two requirements the
 * removal note carried forward hold here and must keep holding:
 *
 * 1. It is VISIBLE at rest and enabled. Never an unhinted long-press — that
 *    is the touch equivalent of a hover-only affordance, which the UI rules
 *    ban, and §6.1 names it as the first thing paddock does differently from
 *    Collie.
 * 2. Its accessible name carries the row's FULL VISIBLE LABEL, and that label
 *    is the one `pane-label.ts` computes (§16.6's rule has one home). Which is
 *    why the label is built here, once per row shape, and handed to
 *    `RowActions` rather than derived again inside it.
 */

/**
 * One space, and its panes only when there is something to show.
 *
 * "Structured" means more than one pane or more than one tab. A space with
 * one tab and one pane has neither, so it renders as a SINGLE row with no
 * chevron — there is nothing to expand, and offering a control that reveals
 * nothing is worse than offering none. Most spaces are that shape.
 */
/**
 * Are these two strings the same label, allowing for herdr's own slugging?
 *
 * §14.7 measured that herdr initialises an agent's `name` to the SLUG of its
 * workspace label. A literal comparison therefore reports a difference that is
 * not one — `"api refactor"` vs `"api-refactor"` — and the first version of
 * this screen printed every merged row's title twice, once de-spaced. §16.1.
 *
 * Deliberately loose. A false negative hides an alias on a row whose labels
 * differ only in punctuation, which costs nothing. A false positive is visible
 * noise on nearly every row, which is the defect this replaces.
 *
 * `slug` is imported rather than spelled again here. It was a private helper
 * inside this function until the create sheet needed the SAME rule to pre-fill
 * an agent's name from its space's label — the same §14.7 measurement, read
 * from the other direction. Two copies of it would be free to drift, and the
 * defect §16.1 records is exactly what one copy drifting looks like.
 */
function sameLabel(a: string, b: string): boolean {
  return slug(a) === slug(b);
}

export function SpaceRow({
  space, open, onToggle, onChanged, senders,
  cwds = [], canCreate = false, createSenders, navigate,
}: {
  space: Space;
  open: boolean;
  onToggle: () => void;
  /** Re-read the tree. Called after every write, win or lose — §11's no
   *  optimistic updates rule, which is why this is a refetch and not a
   *  local edit of the tree that is already here. */
  onChanged: () => void;
  senders?: RowSenders;
  /** The cwds already in the WHOLE tree, for the create sheet's quick picks.
   *  Computed once in `Spaces`, not per row: a row's sheet offers every folder
   *  in use, not only the ones in its own space. */
  cwds?: string[];
  /** Whether the `+` exists at all — the tree-reading capability, decided in
   *  `Spaces` from the store. Defaults to false so a caller that does not pass
   *  it gets no control rather than one that errors. */
  canCreate?: boolean;
  createSenders?: CreateSenders;
  navigate?: (hash: string) => void;
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
  //
  // `paneIdentity` is the shared rule (`pane-label.ts`), the same one the pane
  // sub-rows below and the terminal header in `App.tsx` use — the three had
  // drifted into three expressions.
  const alias = only ? paneIdentity(only) : null;
  const showAlias = alias !== null && !sameLabel(alias, spaceLabel);

  // Why this row is structured at all, said in the unit that explains it.
  //
  // This read `${space.tabCount} tabs`, which was wrong in both halves. A
  // space reaches this branch on EITHER count, so a single tab split into
  // several panes (`pane.split` is an ordinary thing to do) rendered
  // "1 tabs" — a number that does not explain the sub-rows under it, and a
  // plural that does not agree with it.
  const countLabel = space.tabCount === 1
    ? plural(space.paneCount, "pane")
    : plural(space.tabCount, "tab");

  // The row's full visible label, for the `⋯`'s accessible name — everything
  // the row shows, in the order it shows it. On a merged row that includes the
  // alias, because the alias is on screen: a button announcing only half of
  // what its row says is the divergence this file's opening note records.
  const rowLabel = showAlias ? `${spaceLabel} (${alias})` : spaceLabel;

  // What this row's sheet can reach. A structured space's row is the space and
  // nothing else — its panes and their tabs are reached from the sub-rows
  // below. A merged row IS the space AND its single pane, so it also offers
  // that pane's agent, when it has one.
  //
  // It deliberately does NOT offer the tab: a 1:1:1 space shows no tab label
  // anywhere, so renaming it would produce no visible change on this screen —
  // the same "control that appears to do nothing" defect §7.1 gives as the
  // reason paddock refuses `pane.rename`.
  const spaceRenames: RenameTarget[] = [
    { kind: "space", id: space.spaceId, current: space.label },
    ...(only !== null && only.harness !== null
      ? [{ kind: "agent", id: only.paneId, current: only.name } as RenameTarget]
      : []),
  ];

  // Built once and rendered from either branch: the space's label is the same
  // on both row shapes, and two copies of it would be free to drift.
  const heading = (
    <div className="space-heading">
      <span className="space-name">{spaceLabel}</span>
      {showAlias && <span className="space-alias">{alias}</span>}
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

            Whatever gets added beside this anchor stays a SIBLING of it,
            never a child: a <button> inside an <a> is invalid HTML and
            unreachable by keyboard. */}
        {only ? (
          <a href={paneHash(only.paneId)}>
            <StateMarker state={only.state} />
            {heading}
            <PaneState pane={only} />
          </a>
        ) : (
          <>
            {heading}
            <span className="space-count">{countLabel}</span>
          </>
        )}
        {/* §16.7's second `+`: on the space row, so its position says it makes
            a tab IN THIS SPACE. A SIBLING of the anchor above, never a child —
            a <button> inside an <a> is invalid HTML and unreachable by
            keyboard, which is the same trap `RowActions` carries a note about.

            The space's cwd is its FIRST pane's. `Space` carries none of its
            own, and herdr's own workspace cwd is not in the tree; the pane the
            operator can see is the honest answer to "where is this space",
            and a null one asks herdr for its default rather than guessing. */}
        {canCreate && (
          <CreateSheet
            target={{
              kind: "tab",
              spaceId: space.spaceId,
              // `space.label`, NOT the `spaceLabel` the heading uses: that one
              // falls back to the id so the row has something to show, and
              // handing the fallback on made a herdr coordinate the agent's
              // suggested name. The sheet does its own falling back, per
              // consumer — see `CreateTarget`.
              spaceLabel: space.label,
              spaceCwd: panes[0]?.cwd ?? null,
            }}
            cwds={cwds}
            onChanged={onChanged}
            senders={createSenders}
            navigate={navigate}
          />
        )}
        <RowActions
          label={rowLabel}
          renames={spaceRenames}
          close={{ kind: "space", id: space.spaceId, panes }}
          onChanged={onChanged}
          senders={senders}
        />
      </div>

      {structured && open && (
        <ul className="space-tabs">
          {space.tabs.map((t) => (
            <li key={t.tabId}>
              <ul>
                {t.panes.map((p) => (
                  <li key={p.paneId} data-pane-row data-state={p.state ?? "none"}>
                    <a href={paneHash(p.paneId)}>
                      <StateMarker state={p.state} />
                      <span className="pane-heading">
                        <span className="pane-name">{paneLabel(p)}</span>
                        {/* A tab label is a CAPTION on the pane it labels, not
                            a heading above a group of panes — a bare uppercase
                            `<h3>` between rows read as a section header for
                            the whole list (§16.2). An unnamed tab ("1") has no
                            caption at all: repeating the row below is noise. */}
                        {t.label !== null && <span className="pane-tab">{t.label}</span>}
                      </span>
                      <PaneState pane={p} />
                    </a>
                    {/* A pane sub-row reaches its own agent and the TAB that
                        holds it — the tab has no row of its own on this
                        screen, and its caption is right here. Its close takes
                        the whole tab, which is what the consequence line has
                        to say and why the tab's panes go with it. */}
                    <RowActions
                      label={paneLabel(p)}
                      renames={[
                        ...(p.harness !== null
                          ? [{ kind: "agent", id: p.paneId, current: p.name } as RenameTarget]
                          : []),
                        { kind: "tab", id: t.tabId, current: t.label },
                      ]}
                      close={{ kind: "tab", id: t.tabId, panes: t.panes }}
                      onChanged={onChanged}
                      senders={senders}
                    />
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

/** Colour is never the only channel — `StateMarker` is aria-hidden, so the
 *  state has to be readable as text right here. */
function PaneState({ pane }: { pane: TreePane }) {
  return <span className="pane-state">{pane.state ?? NO_AGENT}</span>;
}
