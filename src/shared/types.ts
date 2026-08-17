export type AgentState = "blocked" | "done" | "working" | "idle";

export interface Agent {
  hostId: string;
  agentId: string;
  /** Operator-assigned name. The PRIMARY label. Never derived from cwd. */
  name: string;
  /** Live task line, from terminal_title_stripped. */
  task: string;
  state: AgentState;
  workspaceId: string;
  workspaceLabel: string | null;
  cwd: string;
  /** Epoch ms when this state was first observed. Stamped by paddock. */
  stateSince: number;
  updatedAt: number;
}

export type ServerMessage =
  | { type: "snapshot"; hostId: string; agents: Agent[]; serverTime: number }
  | { type: "delta"; upserted: Agent[]; removedIds: string[]; serverTime: number }
  /**
   * "I am still here" — carries no agent data and changes nothing on screen.
   *
   * Its own variant rather than an empty delta on purpose: an empty delta
   * states "nothing changed", which is a different claim from "the link is
   * alive", and a client is entitled to treat a delta as agent news. The
   * client counts any received message as liveness, so this is what keeps a
   * genuinely quiet overnight session — every agent idle, zero traffic — from
   * declaring itself stale at T+60s and leaving the operator unable to tell
   * "nothing is happening" from "the link died".
   */
  | { type: "heartbeat"; serverTime: number };

export const SECTION_ORDER = ["needs-you", "working", "idle"] as const;
export type Section = (typeof SECTION_ORDER)[number];

export function sectionFor(state: AgentState): Section {
  if (state === "blocked" || state === "done") return "needs-you";
  if (state === "working") return "working";
  return "idle";
}

/**
 * THE triage display order (spec §6): section, then most-recently-changed
 * first, then name as a stable tie-break.
 *
 * Exported from the shared contract and used by BOTH sides on purpose. The
 * server sorts its snapshot with it; the client re-sorts after every delta,
 * because merging a delta into a keyed collection preserves each existing
 * entry's original position — so a snapshot-only sort holds for exactly as
 * long as it takes the first delta to arrive, and then decays for the rest of
 * the session. Two copies of this comparison would be free to drift; there is
 * only one.
 */
export function compareAgents(a: Agent, b: Agent): number {
  const sa = SECTION_ORDER.indexOf(sectionFor(a.state));
  const sb = SECTION_ORDER.indexOf(sectionFor(b.state));
  if (sa !== sb) return sa - sb;
  if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince;
  return a.name.localeCompare(b.name);
}
