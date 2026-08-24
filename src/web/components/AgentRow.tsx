import type { Agent } from "@shared/types";
import { elapsedLabel } from "@web/components/elapsed";
import { IconTile } from "@web/components/ui/IconTile";
import { StatusDot } from "@web/components/ui/StatusDot";

/** Re-exported for the card and the terminal header, which imported it from
 *  here before the primitive layer existed. */
export { StatusDot };

/** Dense row. Task text truncates to keep the list scannable.
 *
 * Every row is bare: the two sections that need attention (`needs-you`,
 * `ready-unseen`) render `AgentCard` instead, which carries its own border
 * and accent — a row never needs to escalate itself. */
export function AgentRow({
  agent, now, onSelect,
}: {
  agent: Agent;
  now: number;
  /** Opens the detail sheet for this agent. Optional so the row still
   * renders standalone. */
  onSelect?: () => void;
}) {
  return (
    <div
      className="tap row flex items-center gap-2.5 px-3 py-2.5"
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
      <IconTile harness={agent.harness} badge={<StatusDot state={agent.state} />} />
      <span className="sr-only">{agent.state}</span>
      <div className="min-w-0 flex-1">
        {/* `ident` because an agent name is an identifier you match, not prose
            you read — see the two-voices block in styles.css. */}
        <div className="ident row-name truncate">{agent.name}</div>
        <div className="row-task truncate">{agent.task}</div>
      </div>
      <span className="ident row-meta shrink-0">{elapsedLabel(now - agent.stateSince, agent.stateSinceExact)}</span>
    </div>
  );
}

/**
 * The collapsed form of an idle agent.
 *
 * It opens the terminal like every other representation of an agent. It used
 * to be an inert `<span>`, which made the Idle section — five of six agents on
 * a typical screen — completely untappable: the operator taps a name, nothing
 * happens, and there is no way to tell a dead control from a slow one. Every
 * place an agent's name appears is a way in.
 *
 * A real `<button>` rather than a div with a click handler, so it is
 * focusable, keyboard-activatable and announced as a control for free.
 */
export function AgentChip({ agent, onSelect }: { agent: Agent; onSelect?: () => void }) {
  return (
    <button
      type="button"
      className="ident tap rounded-full px-2.5 py-1"
      style={{
        fontSize: "var(--t-md)", background: "var(--surface)",
        border: "1px solid var(--border)", color: "var(--fg-dim)",
      }}
      onClick={onSelect}
    >
      {agent.name}
    </button>
  );
}
