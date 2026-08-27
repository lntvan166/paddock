import { useEffect, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { fetchSpaceTree } from "@web/api";
import { CreateSheet, type CreateSenders } from "@web/components/CreateSheet";
import { treeCwds } from "@web/components/space-sort";
import { AgentsIcon, TerminalIcon } from "@web/components/ui/icons";
import type { SpaceTree } from "@shared/types";

/**
 * Start something from the dashboard.
 *
 * The dashboard had no create control at all: the only one lived on Spaces, so
 * starting an agent meant leaving the screen you were on — and the empty state
 * ("No agents detected.") was a dead end offering nothing.
 *
 * WHY A DIAL RATHER THAN ONE BUTTON. A speed dial is usually a way to hide
 * several loosely-related shortcuts behind one control, which is worse than a
 * menu. It earns itself here because its two entries are a distinction paddock
 * ALREADY draws: the create sheet's first field is `plain shell — no agent`
 * versus a harness kind. So the dial does not invent a choice, it pre-answers
 * one, and the sheet opens a field shorter. Hold any future third entry to
 * that test.
 *
 * WHY RADIX'S DropdownMenu. `radix-ui` is already a direct dependency, so this
 * costs nothing to add — and Escape, an outside tap, `aria-expanded`, focus
 * moving into the items and back to the trigger on close, roving arrow keys
 * and scroll locking all come from the primitive. Hand-rolling those is
 * exactly what `CLAUDE.md` keeps shadcn around to avoid: "it earns its weight
 * on the primitives that are genuinely hard to get right … focus traps, scroll
 * locking, escape handling."
 *
 * WHAT IT CREATES. A SPACE, both times. From the dashboard there is no tab to
 * add to — that is what the space screen's own "New tab" row is for — so the
 * natural target is a fresh space holding the new pane.
 */
export function QuickAdd({ onChanged, senders, navigate, load = fetchSpaceTree }: {
  onChanged: () => void;
  senders?: CreateSenders;
  navigate?: (hash: string) => void;
  /** Injected for the same reason `Spaces` injects it: a test drives this
   *  without a network. */
  load?: () => Promise<SpaceTree>;
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<"shell" | "agent" | null>(null);
  const [cwds, setCwds] = useState<string[]>([]);

  /**
   * The folder quick picks, read when a choice is made.
   *
   * Reported from a phone: the folder field is hard, "user doesn't have their
   * machine when they click that and doesn't remember the structure". Typing a
   * path from memory on a phone keyboard is the worst input this app asks for,
   * and the dial shipped with an EMPTY pick list, which made it the only
   * create control with no help at all.
   *
   * It has to come from the TREE and cannot come from the agent store, which
   * is what the dashboard already holds: `toSpaceTree` tilde-ises a pane's cwd
   * (`~/project`) while the adapter leaves an agent's raw (`/home/…/project`).
   * The field round-trips the tilde-ised form — `expandHome` is its exact
   * inverse on the way back — so raw paths here would both look wrong and
   * come back wrong.
   *
   * Read on CHOICE, not on mount: this is a tree fetch on a screen that
   * renders no tree, so it is owed only once the operator has said they are
   * creating something. A failure leaves the list empty, which is exactly
   * where this started — the field still takes anything typed, and blank still
   * asks herdr for its own default.
   */
  useEffect(() => {
    if (sheet === null) return;
    let live = true;
    void load()
      .then((tree) => { if (live) setCwds(treeCwds(tree)); })
      .catch(() => { if (live) setCwds([]); });
    return () => { live = false; };
  }, [sheet, load]);

  const start = (preset: "shell" | "agent") => {
    // Close the dial first. Leaving it open behind the sheet would put two
    // dismissible layers on screen, and Escape would then close the wrong one.
    setOpen(false);
    setSheet(preset);
  };

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger className="quick-add-fab tap" aria-label={open ? "Close" : "New"}>
          {/* ONE glyph rotated, never two swapped: the rotation is what says
              these are the same control in two states. `data-state` is stamped
              by Radix; `styles.css` turns it 135° into an ×. */}
          <svg
            className="quick-add-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
            fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="quick-add-menu"
            side="top"
            align="end"
            // Clears the trigger with the same gap the items use between
            // themselves, so the stack reads as one column.
            sideOffset={8}
          >
            <DropdownMenu.Item className="quick-add-item" onSelect={() => start("agent")}>
              <AgentsIcon className="quick-add-item-glyph" />
              Agent
            </DropdownMenu.Item>
            <DropdownMenu.Item className="quick-add-item" onSelect={() => start("shell")}>
              <TerminalIcon className="quick-add-item-glyph" />
              Terminal
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Mounted only while a choice is live, so the sheet's own open/close
          effects — the keyboard inset among them — do not run for a dial that
          was merely opened and dismissed. */}
      {sheet !== null && (
        <CreateSheet
          target={{ kind: "space" }}
          preset={sheet}
          openWhen
          onOpenChange={(next) => { if (!next) setSheet(null); }}
          cwds={cwds}
          onChanged={onChanged}
          senders={senders}
          navigate={navigate}
        />
      )}
    </>
  );
}
