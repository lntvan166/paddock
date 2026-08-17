import {
  compareAgents,
  SECTION_ORDER,
  sectionFor,
  type Agent,
  type Section as SectionKey,
} from "@shared/types";

/**
 * Group into the three triage sections, ordering each with the SHARED
 * comparator — the same one the server sorts its snapshot with.
 *
 * Sorting here is load-bearing, not belt-and-braces. The client merges deltas
 * into a Map keyed by agentId, and setting an existing key keeps that entry's
 * original insertion position, so an agent that becomes blocked long after the
 * snapshot would otherwise render below an agent that has been blocked for ten
 * minutes — spec §6's "within Needs you, most-recently-changed first" would
 * hold only until the first delta arrived.
 */
export function groupAgents(agents: Agent[]): Record<SectionKey, Agent[]> {
  const out = { "needs-you": [], working: [], idle: [] } as Record<SectionKey, Agent[]>;
  for (const a of [...agents].sort(compareAgents)) out[sectionFor(a)].push(a);
  return out;
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
};

export { SECTION_ORDER };

export function SectionHeader({
  title, count, expandable, expanded, onToggle,
}: {
  title: string;
  count: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      <span className="text-[9.5px] font-bold uppercase tracking-[0.09em]">{title}</span>
      <span className="text-[9.5px]"> · {count}</span>
    </>
  );
  if (!expandable) {
    return (
      <div className="px-3 pt-3 pb-1.5" style={{ color: "var(--fg-dim)" }}>
        {label}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="tap w-full px-3 pt-3 pb-1.5 text-left"
      style={{ color: "var(--fg-dim)" }}
    >
      {label} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
    </button>
  );
}
