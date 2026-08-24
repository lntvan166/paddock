import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ActionResult, Agent } from "@shared/types";
import { acknowledge } from "@web/api";
import { formatElapsed } from "@web/components/elapsed";
import { StatusDot } from "@web/components/AgentRow";

/**
 * Only a finished agent can be dismissed, and only once.
 *
 * Never a blocked agent: dismissing one would hide something that still needs
 * an answer, which is the opposite of what Needs you is for.
 */
export function showAcknowledge(agent: Agent): boolean {
  return agent.state === "done" && agent.acknowledgedAt === null;
}

/** Full card for anything in Needs you. Task text wraps — it must be readable. */
export function AgentCard({
  agent, now, onSelect,
}: {
  agent: Agent;
  now: number;
  /** Opens the detail sheet for this agent. Optional so the card still
   * renders standalone (e.g. in a future context with no sheet to open). */
  onSelect?: () => void;
}) {
  // Same palette as `StatusDot`: red for the one state that needs a person.
  const accent = agent.state === "blocked" ? "var(--danger)" : "var(--ok)";
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
      className="tap mx-2 mb-1.5 rounded-lg p-3"
      style={{ background: "var(--surface)", border: `1px solid ${accent}` }}
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
      <header className="flex items-center gap-2">
        <StatusDot state={agent.state} />
        <h3 className="text-[12.5px] font-semibold">{agent.name}</h3>
        <span className="ml-auto text-[10px]" style={{ color: "var(--fg-dim)" }}>
          {formatElapsed(now - agent.stateSince)}
        </span>
      </header>
      <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--fg-dim)" }}>
        {agent.task}
      </p>
      <p className="mt-2 text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {agent.state === "blocked" ? "Waiting for input" : "Finished"}
      </p>
      {showAcknowledge(agent) && (
        <>
          <button
            type="button"
            className="tap mt-2 rounded px-2 py-1 text-[10px] font-semibold"
            style={{ border: "1px solid var(--fg-dim)", color: "var(--fg-dim)" }}
            disabled={busy}
            onClick={(e) => void dismiss(e)}
            onKeyDown={stopKeyBubble}
          >
            Dismiss
          </button>
          {result && !result.ok && (
            <p className="mt-1 text-[10px]" style={{ color: "var(--danger)" }} role="alert">
              {result.detail ?? "Could not dismiss."}
            </p>
          )}
        </>
      )}
    </article>
  );
}
