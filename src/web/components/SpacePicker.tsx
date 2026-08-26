import { useState } from "react";
import { spaceHash } from "@shared/route";
import type { Space } from "@shared/types";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "@web/components/shadcn/sheet";
import { sortSpaces, spaceState } from "@web/components/space-sort";
import { NO_AGENT, StateMarker } from "@web/components/ui/StateMarker";

/**
 * Switching space, from the space screen's own header title.
 *
 * Not Collie's chip rail, and the reason is a measurement rather than a
 * preference: at 390px a chip carrying a dot and a label runs about 110px, so
 * three of the eleven spaces measured on the development machine would be
 * visible and eight would sit behind a sideways scroll with nothing saying they
 * exist — and the rail costs about 48px of height permanently. A sheet shows
 * all eleven, and would show forty.
 *
 * The title is the trigger because the title is what names the thing being
 * switched. It is a real `<button>`, not a tappable heading: an affordance an
 * operator has to guess at is the same defect as a hover-only one.
 */
export function SpacePicker({ spaces, currentId, navigate = (hash) => { location.hash = hash; } }: {
  spaces: Space[];
  currentId: string;
  /** Injected so a test can observe the navigation instead of mutating the
   *  document's hash — the same reason `CreateSheet` takes it. */
  navigate?: (hash: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = spaces.find((s) => s.spaceId === currentId) ?? null;
  // Falls back to the id so the header says something. A space can be unnamed;
  // a header cannot be blank.
  const currentLabel = current?.label ?? currentId;

  const choose = (space: Space) => {
    setOpen(false);
    // No navigation to where you already are. It would push an identical hash,
    // which fires no `hashchange` and so leaves the sheet's close as the only
    // visible effect — a control that appears to do nothing.
    if (space.spaceId === currentId) return;
    navigate(spaceHash(space.spaceId));
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger data-space-picker className="space-picker-btn">
        <span className="space-picker-name">{currentLabel}</span>
        {/* The chevron says this is a control. `aria-hidden` because the
            button's own text already names it. */}
        <span aria-hidden="true" className="space-picker-caret">▾</span>
      </SheetTrigger>
      <SheetContent side="bottom" className="row-actions-sheet space-picker-sheet" showCloseButton={false}>
        <SheetHeader className="row-actions-head">
          <SheetTitle className="row-actions-title">Switch space</SheetTitle>
          <SheetDescription className="row-actions-scope">
            Every space in this herdr session.
          </SheetDescription>
        </SheetHeader>
        <ul className="space-picker-list">
          {sortSpaces(spaces).map((s) => {
            const state = spaceState(s);
            const here = s.spaceId === currentId;
            return (
              <li key={s.spaceId}>
                <button
                  type="button"
                  data-picker-row
                  // `aria-current`, not a visual tick alone: the marking has to
                  // reach a screen reader too.
                  aria-current={here ? "true" : undefined}
                  onClick={() => choose(s)}
                >
                  {/* `StateMarker`, not a local null-check: the rule that a
                      null state gets `.dot-none` rather than a `StatusDot`
                      lives in one place now (`ui/StateMarker.tsx`), because
                      this picker, the space rows and the tab rows all need it
                      and three copies would be three things free to drift. */}
                  <StateMarker state={state} surfaceVar="--surface" />
                  <span className="space-name">{s.label ?? s.spaceId}</span>
                  {/* Colour is never the only channel: StatusDot is
                      aria-hidden, so the state is said in words here. */}
                  <span className="space-state">{state ?? NO_AGENT}</span>
                  <span className="space-count">{s.paneCount}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
