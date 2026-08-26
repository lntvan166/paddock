import { plural } from "@web/format";
import { useId, useState } from "react";
import { useKeyboardInset } from "@web/keyboard-inset";
import type { TreePane } from "@shared/types";
import { closeSpace, closeTab, renameAgent, renameSpace, renameTab } from "@web/api";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@web/components/shadcn/sheet";

/**
 * The `⋯` a row carries, and the sheet it opens.
 *
 * The visibility of the control is the requirement, not a style choice: the
 * note at the top of `SpaceRow.tsx` and §6.1 both name an unhinted long-press
 * — Collie's way in — as the touch equivalent of a hover-only affordance,
 * which paddock's UI rules ban. So the `⋯` is on the row, at rest, enabled,
 * and its accessible name carries the row's full visible label. That label is
 * computed by the CALLER, from `paneLabel`/the space's own label, because
 * §16.6's labelling rule has exactly one home (`pane-label.ts`) and the
 * removed first attempt at this control is what happens when a second
 * expression grows next to it: a shell row read `bash` while its button
 * announced `w3:p1`.
 *
 * shadcn's `Sheet` rather than a hand-rolled one — the case `CLAUDE.md`
 * sanctions it for exactly (focus trap, scroll lock, escape handling), and a
 * bottom sheet on a phone is where getting those wrong is felt.
 */

/** A rename this row can reach. The three are independent (§7.1): an
 *  `agent.rename` override survives a `workspace.rename`, and neither writes
 *  the other's field, so they are presented as separate edits. */
export interface RenameTarget {
  kind: "space" | "tab" | "agent";
  id: string;
  /** What herdr holds now, prefilled into the field. Null when unnamed. */
  current: string | null;
}

/** The close this row can reach, carrying the panes it would take with it.
 *  The panes come from the tree ALREADY ON SCREEN (§10) — the consequence
 *  line is counted off them, never fetched, so what the operator confirms is
 *  what they were looking at. */
export interface CloseTarget {
  kind: "tab" | "space";
  id: string;
  panes: TreePane[];
}

/**
 * The five writes, injected — same reason `load` is injected into `Spaces`
 * and `PaneTerminal`: a component test drives this without a network, and a
 * failure is a value this component renders rather than a thrown promise.
 */
export interface RowSenders {
  renameAgent(id: string, name: string | null): Promise<unknown>;
  renameTab(id: string, label: string): Promise<unknown>;
  renameSpace(id: string, label: string): Promise<unknown>;
  closeTab(id: string): Promise<unknown>;
  closeSpace(id: string): Promise<unknown>;
}

/** The real clients from `api.ts`. Wrapped rather than passed by reference so
 *  the optional `fetch` parameter each one carries stays out of this
 *  interface — a sender here takes exactly what the UI knows. */
export const LIVE_SENDERS: RowSenders = {
  renameAgent: (id, name) => renameAgent(id, name),
  renameTab: (id, label) => renameTab(id, label),
  renameSpace: (id, label) => renameSpace(id, label),
  closeTab: (id) => closeTab(id),
  closeSpace: (id) => closeSpace(id),
};

/** Re-exported so existing importers keep working; defined in `web/format`. */
export { plural } from "@web/format";

/**
 * What closing this actually does, said as a sentence (§10).
 *
 * Arm-then-confirm is taken from Collie; stating the consequence is the part
 * paddock adds, because "tap again to close" asks for a confirmation without
 * telling the operator what they are confirming. The count is of AGENTS, not
 * panes — a pane closing costs nothing, an agent being killed does — and how
 * many of them are working is said separately, since that is the number that
 * measures the loss.
 */
export function consequence(kind: "tab" | "space", panes: TreePane[]): string {
  // `harness` is the only discriminator between an agent pane and a shell
  // (`types.ts` says so on the field); `state` is null for exactly the same
  // panes, so either would do and this uses the documented one.
  const agents = panes.filter((p) => p.harness !== null);
  const working = agents.filter((p) => p.state === "working").length;
  const head = `Close ${kind} — `;
  if (agents.length === 0) {
    return `${head}${plural(panes.length, "pane")} will close, no agent running.`;
  }
  if (working === agents.length) {
    return `${head}${plural(working, "working agent")} will be killed.`;
  }
  if (working === 0) {
    return `${head}${plural(agents.length, "agent")} will be killed, none of them working.`;
  }
  return `${head}${plural(agents.length, "agent")} will be killed, ${working} of them working.`;
}

/** What this sheet's actions reach, so the operator knows the scope before
 *  tapping one. A pane row's close takes its whole tab, which is not obvious
 *  from a row that shows one pane. */
/** What the sheet says it acts on. `undefined` is the terminal header, where
 *  the sheet reaches one agent and nothing structural. */
function scopeOf(kind: "tab" | "space" | undefined): string {
  if (kind === undefined) return "This agent.";
  return kind === "space"
    ? "This space, and every tab, pane and agent in it."
    : "This pane, and the tab that holds it.";
}

type Mode =
  | { view: "menu" }
  | { view: "rename"; target: RenameTarget }
  /** Armed. Reaching this view IS the first of the two taps (§10): the
   *  consequence is stated here and the confirm button is the second. */
  | { view: "close" };

export function RowActions({ label, renames, close, onChanged, senders = LIVE_SENDERS }: {
  label: string;
  renames: RenameTarget[];
  /**
   * OPTIONAL, and absent in exactly one place: the terminal header.
   *
   * A close needs the tab or space that would be closed, plus the panes it
   * would take with it so the consequence line can be counted off the tree
   * already on screen (§10). The terminal knows a PANE — it never reads the
   * tree for an agent — so it has neither. Offering a close there would mean
   * fetching a tree to answer a question the operator has not asked yet, or
   * stating a consequence paddock has not counted, and §10 exists to forbid
   * the second.
   *
   * So the terminal's menu renames and nothing else, which is the action a
   * person looking at one agent actually wants. Closing stays where the
   * structure is visible: the tab and space rows.
   */
  close?: CloseTarget;
  onChanged: () => void;
  senders?: RowSenders;
}) {
  const [open, setOpen] = useState(false);
  // Hold the sheet above the on-screen keyboard while it is open. Tracked only
  // while open — see the hook's note on why a page-lifetime listener would be
  // wrong. Absent `visualViewport`, this does nothing at all.
  useKeyboardInset(open);
  const [mode, setMode] = useState<Mode>({ view: "menu" });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consequenceId = useId();

  const show = (next: boolean) => {
    setOpen(next);
    // The sheet always reopens on its menu, never mid-edit and never still
    // armed: an armed close surviving a close-and-reopen would make the
    // second of the two taps reachable without the first.
    if (!next) { setMode({ view: "menu" }); setDraft(""); setError(null); }
  };

  /**
   * Run one write, then refetch — win or lose.
   *
   * NO optimistic update (§11). This screen's value is being accurate about
   * someone else's state, so the tree is re-read and what lands on screen is
   * what herdr holds, not what was asked for. A failure keeps the sheet open
   * carrying the server's own `detail`, because a management screen that
   * quietly fails to rename something is worse than one with no rename.
   */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      show(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitRename = (target: RenameTarget) => {
    const value = draft.trim();
    // Refused HERE, before the request. The routes refuse an empty or
    // whitespace-only label too (400), but a control that lets you submit
    // something guaranteed to fail is a bad control. And it cannot be
    // forwarded as a "clear": §17 measured that herdr STORES the empty
    // string for a tab or space rather than unsetting the label.
    //
    // No length ceiling is checked here on purpose. That bound is paddock
    // policy with one home (`MAX_LABEL_LEN` in `routes.ts`); a copy of the
    // number in the client is a second home for it, and an over-long label
    // arrives back as the server's own detail either way.
    if (value === "") return;
    if (target.kind === "agent") return run(() => senders.renameAgent(target.id, value));
    if (target.kind === "tab") return run(() => senders.renameTab(target.id, value));
    return run(() => senders.renameSpace(target.id, value));
  };

  const confirmClose = () => {
    // Unreachable without `close`: the menu entry that arms this view is
    // guarded on it. Stated rather than assumed, because a `!` here would be
    // the compiler being told to stop checking the one path that deletes
    // someone's work.
    if (close === undefined) return;
    return run(() => close.kind === "tab" ? senders.closeTab(close.id) : senders.closeSpace(close.id));
  };

  // The one real clear (§7.2, §17): `agent.rename {name: null}` removes the
  // field. There is none for a tab or a space, because herdr models no unset
  // state for either. Offered only when there is a name to clear — on an
  // already-unnamed agent it would be a control that does nothing.
  const clearable = renames.find((r) => r.kind === "agent" && r.current !== null);

  return (
    <Sheet open={open} onOpenChange={show}>
      <SheetTrigger
        data-row-actions
        className="row-actions-btn"
        // The row's full visible label, computed by the caller. Not rebuilt
        // here: see this file's opening note.
        aria-label={`Actions for ${label}`}
      >
        <span aria-hidden="true">⋯</span>
      </SheetTrigger>
      {/* The home-indicator inset lives in `.row-actions-sheet`'s own
          padding-bottom, not in a second `.safe-bottom` class beside it: two
          rules at equal specificity setting `padding-bottom` is how that
          inset gets silently dropped. */}
      {/* No shadcn close button. Its default is `true`, and it renders an
          absolutely positioned 16px `XIcon` at `top-4 right-4` with no
          `min-width`/`min-height` — in a feature whose CSS sets `2.75rem` on
          every one of its other controls. `.row-actions-title` is mono with
          `overflow-wrap: anywhere`, so a long label wrapped UNDER it. Back,
          Cancel, Escape and the scrim all already close this sheet; a twelfth
          control doing the same thing at a third of the tap size is the worse
          of the two fixes. */}
      <SheetContent side="bottom" className="row-actions-sheet" showCloseButton={false}>
        <SheetHeader className="row-actions-head">
          <SheetTitle className="row-actions-title">{label}</SheetTitle>
          <SheetDescription className="row-actions-scope">{scopeOf(close?.kind)}</SheetDescription>
        </SheetHeader>

        {error !== null && <p className="error" role="alert">{error}</p>}

        {mode.view === "menu" && (
          <div className="row-actions-menu">
            {renames.map((target) => (
              <button
                key={`${target.kind}:${target.id}`}
                type="button"
                onClick={() => { setDraft(target.current ?? ""); setMode({ view: "rename", target }); }}
              >
                Rename {target.kind}
              </button>
            ))}
            {clearable !== undefined && (
              // NOT "reset to default" (§7.2). Clearing does not restore a
              // herdr-derived name — herdr does not re-derive one — so the
              // agent falls to paddock's own `basename(cwd)` fallback, which
              // is a DIFFERENT label. The control says what happens.
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => senders.renameAgent(clearable.id, null))}
              >
                Clear name — paddock will label it from its folder.
              </button>
            )}
            {close !== undefined && (
              <button
                type="button"
                className="row-actions-danger"
                onClick={() => setMode({ view: "close" })}
              >
                Close {close.kind}
              </button>
            )}
          </div>
        )}

        {mode.view === "rename" && (
          <form
            className="row-actions-rename"
            onSubmit={(e) => { e.preventDefault(); void submitRename(mode.target); }}
          >
            <label>
              <span>New {mode.target.kind} name</span>
              <input
                type="text"
                value={draft}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <div className="row-actions-row">
              <button type="button" onClick={() => setMode({ view: "menu" })}>Back</button>
              {/* Disabled on an empty or whitespace-only draft: the request it
                  would send is one the route refuses (§17), so the control
                  says so instead of sending it. */}
              <button type="submit" disabled={busy || draft.trim() === ""}>Save</button>
            </div>
          </form>
        )}

        {mode.view === "close" && close !== undefined && (
          <div className="row-actions-close">
            <p id={consequenceId} className="row-actions-consequence">
              {consequence(close.kind, close.panes)}
            </p>
            <div className="row-actions-row">
              <button type="button" onClick={() => setMode({ view: "menu" })}>Cancel</button>
              {/* The second tap. Never disabled on a count of one space:
                  whether herdr permits closing the last one is deliberately
                  UNMEASURED (§17 probe 3), and a disabled button here would
                  encode a guess about herdr's policy as a fact. The route
                  relays herdr's refusal and the error above shows it. */}
              <button
                type="button"
                className="row-actions-danger"
                aria-describedby={consequenceId}
                disabled={busy}
                onClick={() => void confirmClose()}
              >
                Close {close.kind}
              </button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
