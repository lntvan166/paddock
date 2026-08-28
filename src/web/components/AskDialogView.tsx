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
 * WHAT IS NOT OFFERED is as deliberate as what is. There is no button for the
 * free-text row in EITHER mode, because measurement says a digit sent to it
 * cannot do anything the operator wants: in single-select it picks that row with
 * empty text, which declines the whole dialog and throws away every answer
 * already given ("User declined to answer questions", verbatim from the
 * transcript); in multi-select it ticks a row with no text in it, which answers
 * nothing. The arrows and the agent's own screen remain, which is the honest
 * floor this project keeps for every prompt it cannot fully drive.
 *
 * The tab labels are display, not navigation. Tapping one by name would mean
 * sending a computed run of arrow presses — the riskiest machinery in this
 * feature, for a move the two end buttons already make in one tap each. Knowing
 * WHERE YOU ARE was the thing the raw screen never told you at a glance, and
 * that half is safe.
 */
export function AskDialogView({ dialog, busy, onToggle, onArrow, onAdvance }: {
  dialog: AskDialog;
  busy: boolean;
  onToggle: (key: string) => void;
  onArrow: (key: "left" | "right") => void;
  onAdvance: () => void;
}) {
  const answerable = dialog.options.filter((o) => !o.freeText);
  const hasFreeText = dialog.options.some((o) => o.freeText);
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

      {hasFreeText && (
        <p className="dialog-note">
          To write your own answer, use the arrow keys below and the agent's own
          screen above.
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
