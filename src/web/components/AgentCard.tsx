import { useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { ActionResult, Agent } from "@shared/types";
import { acknowledge } from "@web/api";
import { elapsedLabel } from "@web/components/elapsed";
import { StatusDot } from "@web/components/AgentRow";
import { IconTile } from "@web/components/ui/IconTile";
import { StateIcon } from "@web/components/ui/StateIcon";

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
 * `accent` below is `--danger` for a blocked agent and `--ok` for
 * everything else this card renders (a `done`, unacknowledged agent in
 * Ready), which is what keeps the two attention sections visually
 * distinguishable from each other even though both use this same
 * component.
 */
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
  // Edge AND fill for a blocked agent. The edge alone is a thin signal on a
  // phone held at arm's length, and this is the only card that means "work has
  // stopped until you answer".
  const surface = agent.state === "blocked" ? "var(--danger-wash)" : "var(--surface)";
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
      style={{ "--card-ground": surface, "--card-accent": accent } as CSSProperties}
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
      <header className="flex items-center gap-3">
        {/* The harness tile, which this card did NOT carry.
            `AgentRow` had it and `AgentCard` did not, so the claude mark and
            the `CO` initials appeared on the working and idle rows — the ones
            you are not being asked to do anything about — and were absent from
            Needs you and Ready. Which runtime is asking is part of deciding
            how to answer it, and these are the two sections where a person
            actually decides. The StatusDot rides on the tile here exactly as it
            does in a row, so the two representations of an agent agree. */}
        <IconTile harness={agent.harness} badge={<StatusDot state={agent.state} />} />
        <h3 className="ident row-name min-w-0 flex-1 truncate">{agent.name}</h3>
        <span className="ident row-meta shrink-0">
          {elapsedLabel(now - agent.stateSince, agent.stateSinceExact)}
        </span>
      </header>
      <p className="row-task">{agent.task}</p>
      {/* Shape, colour and word together. The card is already red or green and
          already says which — the icon is the channel that survives when the
          other two do not, and red-and-green is the pair this palette spends on
          exactly these two states. */}
      <p className="row-state flex items-center gap-1">
        <StateIcon state={agent.state} />
        {agent.state === "blocked" ? "Waiting for input" : "Finished"}
      </p>
      {showAcknowledge(agent) && (
        <>
          <button
            type="button"
            className="tap self-start rounded px-3 py-2 font-semibold"
            style={{
              fontSize: "var(--t-md)",
              border: "1px solid var(--fg-dim)", color: "var(--fg-dim)",
            }}
            disabled={busy}
            onClick={(e) => void dismiss(e)}
            onKeyDown={stopKeyBubble}
          >
            Dismiss
          </button>
          {result && !result.ok && (
            <p style={{ fontSize: "var(--t-md)", color: "var(--danger)" }} role="alert">
              {result.detail ?? "Could not dismiss."}
            </p>
          )}
        </>
      )}
    </article>
  );
}
