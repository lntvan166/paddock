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
export function AgentRow({ agent, now }: { agent: Agent; now: number }) {
  return (
    <div
      className="tap flex items-center gap-2.5 px-3 py-2.5"
      style={{ borderTop: "1px solid var(--border)" }}
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

export function AgentChip({ agent }: { agent: Agent }) {
  return (
    <span
      className="rounded-full px-2.5 py-1 text-[10px]"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--fg-dim)" }}
    >
      {agent.name}
    </span>
  );
}
