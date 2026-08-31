import { useState } from "react";
import { Button } from "@web/components/shadcn/button";

/**
 * The question dialog's notes field.
 *
 * TWO SEND BUTTONS, and that is the whole design. Measured on a live agent:
 * with the field open, Enter submits the note ALONE and discards the option the
 * cursor is visibly sitting on; pressing Esc first keeps the note and lets
 * Enter commit both. Those are two different answers the agent receives
 * differently, so the operator picks which one — a single "Send" would have to
 * guess, and guessing wrong throws away the answer they chose while the screen
 * still shows it highlighted.
 *
 * The option button NAMES the option rather than saying "with option": the
 * keypad's cursor may have moved since the operator last looked, and a button
 * that commits an unnamed choice is the mislabelled control this project bans.
 *
 * When no cursor is on screen there is nothing to commit, so only the note-only
 * answer is offered — rather than a button claiming a choice paddock cannot
 * see.
 */
export function NotesField({
  selected,
  busy,
  onSend,
}: {
  /** The option Enter would commit, as the dialog reports it, or null. */
  selected: string | null;
  busy: boolean;
  onSend: (text: string, mode: "note-only" | "with-option") => void;
}) {
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  return (
    <div className="term-notes" role="group" aria-label="Notes">
      <label className="sr-only" htmlFor="term-notes-input">Notes</label>
      <textarea
        id="term-notes-input"
        className="term-notes-field"
        rows={2}
        value={text}
        disabled={busy}
        placeholder="Add a note…"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="term-notes-actions">
        <Button
          type="button"
          variant="outline"
          className="term-notes-send"
          disabled={busy || empty}
          onClick={() => onSend(text, "note-only")}
        >
          Send note only
        </Button>
        {selected !== null && (
          <Button
            type="button"
            className="term-notes-send"
            disabled={busy || empty}
            onClick={() => onSend(text, "with-option")}
          >
            {/* The option's own words, so the operator commits what they read. */}
            Send with {selected}
          </Button>
        )}
      </div>
    </div>
  );
}
