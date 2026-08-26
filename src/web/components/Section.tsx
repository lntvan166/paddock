import {
  compareAgents,
  SECTION_ORDER,
  sectionFor,
  type Agent,
  type AgentState,
  type Section as SectionKey,
} from "@shared/types";
import { StatusDot } from "@web/components/ui/StatusDot";

/**
 * Group into the four triage sections, ordering each with the SHARED
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
  const out = {
    "needs-you": [], "ready-unseen": [], working: [], idle: [],
  } as Record<SectionKey, Agent[]>;
  for (const a of [...agents].sort(compareAgents)) out[sectionFor(a)].push(a);
  return out;
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  "needs-you": "Needs you",
  "ready-unseen": "Ready",
  working: "Working",
  idle: "Idle",
};

/**
 * The state whose dot stands for each section.
 *
 * A static map rather than a lookup over the agents in the section, because a
 * section's members do not all share one state: `idle` holds both genuinely
 * idle agents and finished ones the operator has already dismissed (`done`
 * with a non-null `acknowledgedAt`). Deriving the dot from any single member
 * would paint the Idle header green whenever a dismissed agent happened to
 * sort first.
 */
export const SECTION_DOT: Record<SectionKey, AgentState> = {
  "needs-you": "blocked",
  "ready-unseen": "done",
  working: "working",
  idle: "idle",
};

export { SECTION_ORDER };

export function SectionHeader({
  title, count, dotState, expandable, expanded, onToggle,
}: {
  title: string;
  count: number;
  /** The state this section collects, shown as a dot beside the label. */
  dotState?: AgentState;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      {dotState ? <StatusDot state={dotState} /> : null}
      <span className="sec-label">{title}</span>
      {/* The count is a reading off the list, so it takes the machine voice —
          which also stops it from reading as part of the label. */}
      <span className="ident row-meta"> · {count}</span>
    </>
  );
  return (
    <div className="sec-head">
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="tap flex flex-1 items-center gap-1.5 text-left"
          style={{ color: "inherit" }}
        >
          {label} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
        </button>
      ) : (
        <div className="flex flex-1 items-center gap-1.5">{label}</div>
      )}
      {/* Any control added at the end of this row must be a SIBLING of the
          fold button above, never nested inside it: nested, pressing the
          control would also fold the section, so a sort toggle would collapse
          the very list it was sorting. */}
    </div>
  );
}
