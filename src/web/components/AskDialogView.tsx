import { useState } from "react";
import type { AskDialog } from "@shared/types";
import { Button } from "@web/components/shadcn/button";

/**
 * Claude Code's question dialog, as controls a thumb can reach.
 *
 * EVERY PIECE OF STATE HERE COMES FROM THE SCREEN. The checkbox marks, which
 * question is current, which option is picked — all parsed from what the agent
 * rendered, never tracked locally. A local mirror would drift the moment
 * someone answered at the machine instead of on the phone, and a checkbox that
 * disagrees with the agent is a control that lies.
 *
 * Hook-free: the caller owns every action and the re-read that follows it.
 *
 * WHAT IS NOT OFFERED is as deliberate as what is. There is no BUTTON for the
 * free-text row in either mode, because measurement says a digit sent to it
 * cannot do anything the operator wants: in single-select it picks that row with
 * empty text, which declines the whole dialog and throws away every answer
 * already given ("User declined to answer questions", verbatim from the
 * transcript); in multi-select it ticks a row with no text in it, which answers
 * nothing.
 *
 * That row gets a text FIELD instead, in both modes: the server moves the cursor
 * onto it, verifies from a re-read that it arrived, and only then sends the
 * characters. An earlier version withheld the field in single-select on a
 * measurement that turned out to be wrong — see `dialog-type.ts` — and shipped
 * a note telling the operator to do it a way that did not work either, which is
 * the worse half of that mistake.
 *
 * Typing never commits. In multi-select it ticks the row; in single-select the
 * operator presses Enter, and the note says so — because Enter on an EMPTY row
 * declines the whole dialog, so the send stays disabled until there is
 * something to send.
 *
 * The tab labels are display, not navigation. Tapping one by name would mean
 * sending a computed run of arrow presses — the riskiest machinery in this
 * feature, for a move the two end buttons already make in one tap each. Knowing
 * WHERE YOU ARE was the thing the raw screen never told you at a glance, and
 * that half is safe.
 *
 * NO DESCRIPTIONS, AND NO NEXT BUTTON, both from using it on a phone.
 *
 * The descriptions were duplicating the agent's own screen three inches above,
 * and measured, they were most of the panel's height: with them the transcript
 * got 239px of an 844px phone and the controls got 357. The label is kept
 * because a bare digit only says what it does while the screen behind it stays
 * still — and the screen scrolls. The sentence under it is the part you can read
 * above; the word on the button is the part you cannot.
 *
 * The Next button is gone because `▶` already reaches every tab including
 * Submit. Two controls doing one job was one more surface for the bug that
 * control actually shipped with: Enter acts on the cursor's row, so it unticked
 * an option instead of advancing.
 */
export function AskDialogView({ dialog, busy, onToggle, onArrow, onType }: {
  dialog: AskDialog;
  busy: boolean;
  onToggle: (key: string) => void;
  onArrow: (key: "left" | "right") => void;
  onType: (text: string) => void;
}) {
  const answerable = dialog.options.filter((o) => !o.freeText);
  const freeText = dialog.options.find((o) => o.freeText);
  // The one genuinely local piece of state in this component: what the operator
  // has typed and not yet sent. Everything else is read off the screen.
  const [draft, setDraft] = useState("");
  // What is already in the row, from the PARSER rather than re-matched here:
  // the typed text replaces the label on screen, and duplicating that test in
  // the UI is how the two would drift.
  const already = freeText?.typed ?? "";
  // Whether Enter would commit the TEXT ROW, which is the only time it chooses
  // your own answer. Enter acts on the cursor's row, and the cursor moves
  // whenever anything else in this panel is tapped — so this is a fact about
  // the screen right now, not a general instruction.
  const enterTakesText = freeText !== undefined
    && dialog.cursor?.kind === "option"
    && dialog.cursor.key === freeText.key;
  // The Submit tab is a tab, not a question: one question plus Submit is a
  // strip with nothing to move between.
  const realQuestions = dialog.questions.filter((q) => !q.isSubmit).length;

  return (
    <section className="dialog" aria-label="Question">
      {/* ONE header row, not two. The strip used to be its own 44px band above
          the question — measured, the panel took 305px of an 844px phone
          against the transcript's 291, and half of that band was empty space
          either side of three short words. The arrows flank the question
          instead, and where you are becomes a one-line eyebrow above it. */}
      {realQuestions > 1 && (
        <ol className="dialog-tab-list" aria-label="Questions">
          {dialog.questions.map((q) => (
            <li
              key={q.label}
              className="dialog-tab"
              aria-current={q.current ? "step" : undefined}
            >
              {q.label}{q.answered && " ☒"}
            </li>
          ))}
        </ol>
      )}

      <div className="dialog-head">
        {realQuestions > 1 && (
          <Button
            type="button" variant="outline" className="dialog-prev-q"
            disabled={busy} aria-label="Previous question"
            onClick={() => onArrow("left")}
          >
            ◀
          </Button>
        )}
        <p className="dialog-question">{dialog.question}</p>
        {realQuestions > 1 && (
          <Button
            type="button" variant="outline" className="dialog-next-q"
            disabled={busy} aria-label="Next question"
            onClick={() => onArrow("right")}
          >
            ▶
          </Button>
        )}
      </div>

      {/* `data-mode` because the two modes MEAN different things on a tap: multi
          toggles and stays, single picks and advances. The styling says so, and
          a test asserts it, so the difference cannot quietly disappear. */}
      <div className="dialog-options" role="group" aria-label="Answer" data-mode={dialog.mode}>
        {answerable.map((o) => (
          <Button
            key={o.key}
            type="button"
            variant="outline"
            className="dialog-option"
            data-dialog-option={o.key}
            disabled={busy}
            aria-pressed={o.checked ?? o.picked ?? false}
            onClick={() => onToggle(o.key)}
          >
            {/* The agent's OWN digit, which is exactly what tapping this sends.
                Rendering it makes a five-option prompt scannable at arm's
                length instead of five similar sentences. */}
            <span aria-hidden="true" className="dialog-option-key">{o.key}</span>
            <span className="dialog-option-label">{o.label}</span>
          </Button>
        ))}
      </div>

      {freeText !== undefined && (
        <div className="dialog-text-row">
          <input
            className="dialog-text"
            type="text"
            value={draft}
            placeholder={already === "" ? "Type your own answer" : already}
            /* Sending REPLACES what is in the row, so the placeholder is the
               current answer and typing over it corrects rather than appends. */
            aria-label="Your own answer"
            disabled={busy}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <Button
            type="button" variant="outline" className="dialog-text-send"
            disabled={busy || draft.trim() === ""}
            onClick={() => { onType(draft); setDraft(""); }}
          >
            {already === "" ? "Add" : "Replace"}
          </Button>
        </div>
      )}

      {freeText !== undefined && dialog.mode === "single" && (
        <p className="dialog-note">
          {enterTakesText
            ? "Press Enter to choose your own answer."
            : "Your own answer is written but not chosen — ↓ to it, then Enter."}
        </p>
      )}

    </section>
  );
}
