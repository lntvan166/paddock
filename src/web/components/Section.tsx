import { SECTION_ORDER, sectionFor, type Agent, type Section as SectionKey } from "@shared/types";

export function groupAgents(agents: Agent[]): Record<SectionKey, Agent[]> {
  const out = { "needs-you": [], working: [], idle: [] } as Record<SectionKey, Agent[]>;
  for (const a of agents) out[sectionFor(a.state)].push(a);
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
