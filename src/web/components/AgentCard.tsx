import type { Agent } from "@shared/types";
import { formatElapsed } from "@web/components/elapsed";
import { StateDot } from "@web/components/AgentRow";

/** Full card for anything in Needs you. Task text wraps — it must be readable. */
export function AgentCard({ agent, now }: { agent: Agent; now: number }) {
  const accent = agent.state === "blocked" ? "var(--warn)" : "var(--ok)";
  return (
    <article
      className="mx-2 mb-1.5 rounded-lg p-3"
      style={{ background: "var(--surface)", border: `1px solid ${accent}` }}
    >
      <header className="flex items-center gap-2">
        <StateDot state={agent.state} />
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
    </article>
  );
}
