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
 * In MULTI-select that row gets a text field instead, which is a different
 * capability: the server moves the cursor onto the row, verifies from a re-read
 * that it arrived, and only then sends the characters. In SINGLE-select there is
 * no field either, because the row ignores characters entirely in that mode —
 * so the arrows and the agent's own screen remain, which is the honest floor
 * this project keeps for every prompt it cannot fully drive.
 *
 * The tab labels are display, not navigation. Tapping one by name would mean
 * sending a computed run of arrow presses — the riskiest machinery in this
 * feature, for a move the two end buttons already make in one tap each. Knowing
 * WHERE YOU ARE was the thing the raw screen never told you at a glance, and
 * that half is safe.
 */
export function AskDialogView({ dialog, busy, onToggle, onArrow, onAdvance, onType }: {
  dialog: AskDialog;
  busy: boolean;
  onToggle: (key: string) => void;
  onArrow: (key: "left" | "right") => void;
  onAdvance: () => void;
  onType: (text: string) => void;
}) {
  const answerable = dialog.options.filter((o) => !o.freeText);
  const freeText = dialog.options.find((o) => o.freeText);
  // The one genuinely local piece of state in this component: what the operator
  // has typed and not yet sent. Everything else is read off the screen.
  const [draft, setDraft] = useState("");
  // What is already in the row, so the field can show it rather than looking
  // empty over text the agent is holding. After a send the row's label IS the
  // text, which is why this is a label test rather than a stored value.
  const already = freeText !== undefined && !/^Type something\.?$/.test(freeText.label)
    ? freeText.label
    : "";
  // The Submit tab is a tab, not a question: one question plus Submit is a
  // strip with nothing to move between.
  const realQuestions = dialog.questions.filter((q) => !q.isSubmit).length;

  return (
    <section className="dialog" aria-label="Question">
      {realQuestions > 1 && (
        <div className="dialog-tabs" role="group" aria-label="Questions">
          <Button
            type="button" variant="outline" className="dialog-prev-q"
            disabled={busy} aria-label="Previous question"
            onClick={() => onArrow("left")}
          >
            ◀
          </Button>
          <ol className="dialog-tab-list">
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
          <Button
            type="button" variant="outline" className="dialog-next-q"
            disabled={busy} aria-label="Next question"
            onClick={() => onArrow("right")}
          >
            ▶
          </Button>
        </div>
      )}

      <p className="dialog-question">{dialog.question}</p>

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
            {o.detail !== undefined && (
              <span className="dialog-option-detail">{o.detail}</span>
            )}
          </Button>
        ))}
      </div>

      {freeText !== undefined && dialog.mode === "multi" && (
        <div className="dialog-text-row">
          <input
            className="dialog-text"
            type="text"
            value={draft}
            placeholder={already === "" ? "Type your own answer" : already}
            aria-label="Your own answer"
            disabled={busy}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <Button
            type="button" variant="outline" className="dialog-text-send"
            disabled={busy || draft.trim() === ""}
            onClick={() => { onType(draft); setDraft(""); }}
          >
            Add
          </Button>
        </div>
      )}

      {freeText !== undefined && dialog.mode === "single" && (
        <p className="dialog-note">
          To write your own answer, use the arrow keys below and the agent's own
          screen above — this question takes one choice, and answering it with
          empty text cancels the whole question.
        </p>
      )}

      {dialog.advance !== null && (
        <Button
          type="button" variant="outline" className="dialog-advance"
          disabled={busy} onClick={onAdvance}
        >
          {dialog.advance}
        </Button>
      )}
    </section>
  );
}
