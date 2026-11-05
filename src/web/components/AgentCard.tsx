import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ActionResult, Agent } from "@shared/types";
import { acknowledge } from "@web/api";
import { elapsedLabel } from "@web/components/elapsed";
import { IconTile } from "@web/components/ui/IconTile";
import { StateWord } from "@web/components/ui/StateWord";

/**
 * Only a finished agent can be dismissed, and only once.
 *
 * Never a blocked agent: dismissing one would hide something that still needs
 * an answer, which is the opposite of what Needs you is for.
 */
export function showAcknowledge(agent: Agent): boolean {
  return agent.state === "done" && agent.acknowledgedAt === null;
}

/**
 * Full card for anything in **Needs you** or **Ready** — both attention
 * sections, not just the first. Task text wraps — it must be readable.
 *
 * A neutral panel. It used to be a full-bleed band with a red or green wash
 * and a 2px edge; the data-terminal redesign spends a state's colour ONCE per
 * agent, on the state word in the header, so a blocked card is told apart by
 * what it says and by sitting first, not by painting the whole band red.
 */
export function AgentCard({
  agent, now, onSelect, children,
}: {
  agent: Agent;
  now: number;
  /** Opens the detail sheet for this agent. Optional so the card still
   * renders standalone (e.g. in a future context with no sheet to open). */
  onSelect?: () => void;
  /** Rendered under the task: the blocked prompt's own options, when the
   *  dashboard has them. */
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  // acknowledge() never throws — a failed dismissal (e.g. a 409 because the
  // agent stopped being done in the meantime) must stay visible on the card,
  // not vanish silently. Nothing here hides the card locally: it leaves
  // Needs you only when the server's delta arrives and sectionFor re-routes
  // it, so every open browser agrees.
  const [result, setResult] = useState<ActionResult | null>(null);

  async function dismiss(e: MouseEvent<HTMLButtonElement>) {
    // The button lives inside a clickable card (onSelect opens the detail
    // sheet). Without stopping propagation, tapping Dismiss would also open
    // the sheet for the agent being dismissed.
    e.stopPropagation();
    setBusy(true);
    setResult(await acknowledge(agent.agentId));
    setBusy(false);
  }

  // The card's own onKeyDown (below) reacts to any Enter/Space keydown that
  // bubbles up to it, regardless of which element it started on — so without
  // this, tabbing to Dismiss and pressing Enter/Space would ALSO open the
  // detail sheet via the card's handler, independently of the button's click.
  function stopKeyBubble(e: KeyboardEvent<HTMLButtonElement>) {
    e.stopPropagation();
  }

  return (
    <article
      // Full-bleed, and the accent is a LEFT EDGE rather than a border on all
      // four sides — see `.agent-card` in styles.css for why. The two colours
      // are handed over as custom properties because the state-to-colour rule
      // belongs here, with the state, while the geometry belongs there.
      className="tap agent-card"
      data-state={agent.state}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
    >
      <header className="agent-card-head">
        {/* The harness tile: which runtime is asking is part of deciding how
            to answer it, and these are the two sections where a person
            actually decides. */}
        <IconTile harness={agent.harness} />
        <h3 className="ident row-name min-w-0 flex-1 truncate">{agent.name}</h3>
        <StateWord
          state={agent.state}
          suffix={`· ${elapsedLabel(now - agent.stateSince, agent.stateSinceExact)}`}
          surfaceVar="--surface"
        />
      </header>
      <p className="row-task card-indent">{agent.task}</p>
      {children}
      {showAcknowledge(agent) && (
        <div className="card-foot-row card-indent">
          <button
            type="button"
            className="tap btn"
            disabled={busy}
            onClick={(e) => void dismiss(e)}
            onKeyDown={stopKeyBubble}
          >
            Dismiss
          </button>
          {/* The card itself opens the terminal, but nothing on it SAID so: a
              finished agent's next step is usually to read what it did, and
              the only visible control was the one that throws that away. */}
          {onSelect && (
            <button
              type="button"
              className="tap link-btn"
              onClick={(e) => { e.stopPropagation(); onSelect(); }}
              onKeyDown={stopKeyBubble}
            >
              Review output
            </button>
          )}
          {result && !result.ok && (
            <p style={{ fontSize: "var(--t-md)", color: "var(--danger)" }} role="alert">
              {result.detail ?? "Could not dismiss."}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
