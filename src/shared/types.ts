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
  | { type: "delta"; upserted: Agent[]; removedIds: string[]; serverTime: number };

export const SECTION_ORDER = ["needs-you", "working", "idle"] as const;
export type Section = (typeof SECTION_ORDER)[number];

export function sectionFor(state: AgentState): Section {
  if (state === "blocked" || state === "done") return "needs-you";
  if (state === "working") return "working";
  return "idle";
}
