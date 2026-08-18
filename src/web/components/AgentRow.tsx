import type { Agent } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";

const DOT: Record<Agent["state"], string> = {
  blocked: "var(--warn)",
  done: "var(--ok)",
  working: "var(--accent)",
  idle: "var(--fg-dim)",
};

export function StateDot({ state }: { state: Agent["state"] }) {
  return (
    <span
      aria-hidden="true"
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: DOT[state] }}
    />
  );
}

/** Dense row. Task text truncates to keep the list scannable. */
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
      className="tap flex items-center gap-2.5 px-3 py-2.5"
      style={{ borderTop: "1px solid var(--border)" }}
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
      <StateDot state={agent.state} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{agent.name}</div>
        <div className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
          {agent.task}
        </div>
      </div>
      <span className="shrink-0 text-[10px]" style={{ color: "var(--fg-dim)" }}>
        {formatElapsed(now - agent.stateSince)}
      </span>
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
      className="tap rounded-full px-2.5 py-1 text-[10px]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg-dim)" }}
      onClick={onSelect}
    >
      {agent.name}
    </button>
  );
}
