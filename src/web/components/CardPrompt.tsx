import { useEffect, useState } from "react";
import type { ActionResult, Agent, ParsedPrompt } from "@shared/types";
import { answerWithKey, fetchPrompt } from "@web/api";

/**
 * A blocked agent's prompt, answerable from the dashboard.
 *
 * paddock exists to answer a stopped agent from a phone, and the dashboard
 * used to say only "Waiting for input": the answer was always one screen away,
 * behind the terminal. The original design (§6) drew the options on the card;
 * this is that, under the data-terminal redesign.
 *
 * The same rules as the terminal's own option list, and no new ones:
 *
 * - Buttons ONLY for a prompt the parser read (`options` non-null) that is
 *   answered by its DIGIT (`commit` is not `"cursor"`) and is not a recognised question
 *   dialog. A question dialog is deliberative — preview, notes, a cursor that
 *   must be walked — and is answered in the terminal, never by a one-tap
 *   button here. Anything else gets the question, if there is one, and the
 *   way into the terminal. A mislabelled Approve button is worse than none.
 * - Labels are the agent's own, verbatim, with its own digit.
 * - The `❯` marks where Enter would land as information, never with the accent
 *   fill: that once made "1. Yes" read as the recommended answer directly above
 *   the option that grants a permission for good.
 * - "remembered" tags the persistent grant, matched on the harness's wording.
 *
 * Fetched per state change (keyed on `stateSince`), exactly as the terminal
 * fetches it, so a new question on the same agent is re-read rather than
 * answered with the last question's buttons.
 */
export function CardPrompt({ agent, onOpen }: { agent: Agent; onOpen?: () => void }) {
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ActionResult | null>(null);

  useEffect(() => {
    let live = true;
    setPrompt(null);
    setFailed(null);
    void fetchPrompt(agent.agentId)
      .then((p) => { if (live) setPrompt(p); })
      // A failed read leaves the card as it was before this existed: the
      // question is unknown, and "Open terminal" is still there.
      .catch(() => { if (live) setPrompt(null); });
    return () => { live = false; };
  }, [agent.agentId, agent.stateSince]);

  // `commit !== "cursor"` rather than `=== "digit"`, and `!dialog` rather
  // than `=== null`: the SAME reading the terminal's option list uses, where
  // an absent field (an older server, the browser demo) means the permission
  // prompt every server before those fields answered by digit.
  const answerable =
    prompt !== null && !prompt.dialog && prompt.commit !== "cursor"
    && !!prompt.options && prompt.options.length > 0;

  return (
    <div className="card-prompt card-indent" onClick={(e) => e.stopPropagation()}>
      {prompt?.question && <p className="card-question">{prompt.question}</p>}
      {answerable && (
        <div className="card-options" role="group" aria-label={`Answer ${agent.name}`}>
          {prompt!.options!.map((o) => (
            <button
              key={o.key}
              type="button"
              className="tap card-option"
              data-prompt-option={o.key}
              disabled={busy}
              aria-pressed={o.selected}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={() => {
                setBusy(true);
                setFailed(null);
                void answerWithKey(agent.agentId, o.key)
                  .then((r) => { if (!r.ok) setFailed(r); })
                  .finally(() => setBusy(false));
              }}
            >
              <span aria-hidden="true" className="card-option-cursor">{o.selected ? "❯" : ""}</span>
              <span aria-hidden="true" className="card-option-key">{o.key}</span>
              <span className="card-option-label">{o.label}</span>
              {/don['’]t ask again/i.test(o.label) && (
                <span className="card-option-note">remembered</span>
              )}
            </button>
          ))}
        </div>
      )}
      {failed && (
        <p className="card-prompt-error" role="alert">{failed.detail ?? "Could not answer."}</p>
      )}
      {onOpen && (
        <button
          type="button"
          className="tap link-btn self-start"
          onKeyDown={(e) => e.stopPropagation()}
          onClick={onOpen}
        >
          Open terminal
        </button>
      )}
    </div>
  );
}
