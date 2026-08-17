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
  /**
   * Epoch ms when the operator dismissed this agent's `done` from paddock,
   * or null.
   *
   * herdr derives `done` from idle-plus-*unseen*, and reading over the socket
   * does not clear it — so without this, finished agents accumulate in Needs
   * you and can never be cleared from a phone. This flag is paddock's own:
   * herdr's `done` stays true, paddock just stops surfacing it.
   */
  acknowledgedAt: number | null;
}

/**
 * The one rule for carrying `acknowledgedAt` across a state update: preserved
 * while the agent is still `done`, cleared the moment it is not.
 *
 * Used on BOTH paths that can move an agent's state — the 30s reconcile
 * (`AgentStore.replaceAll`) and the real-time push event
 * (`applyStatusEvent`) — for the same reason `compareAgents` and `sectionFor`
 * are each a single function: two copies of a state rule are free to drift,
 * and push is the PRIMARY path here, not reconcile. A rule that only lived on
 * the healing (reconcile) side would leave any agent whose run is shorter
 * than the reconcile interval to slip through: acknowledge → done leaves via
 * a push event → done returns via a push event, all without an intervening
 * reconcile, and a stale flag would permanently suppress every future finish
 * for that agent.
 */
export function carryAcknowledged(prev: Agent, nextState: AgentState): number | null {
  return nextState === "done" ? prev.acknowledgedAt : null;
}

export interface PromptOption {
  /** The option's text EXACTLY as the agent rendered it. Never rewritten. */
  label: string;
  /** The key to send via agent.send_keys — the option's digit. */
  key: string;
  /** True when the agent's `❯` cursor sits on this option. */
  selected: boolean;
}

export interface ParsedPrompt {
  /** The question line, e.g. "Do you want to proceed?". Null when not found. */
  question: string | null;
  /**
   * The parsed options, or null when the snapshot could not be parsed.
   *
   * null is an OUTCOME, not an error: the UI falls back to raw output plus a
   * free-text reply. A mislabelled Approve button is worse than no button.
   */
  options: PromptOption[] | null;
  /** The snapshot as read. Always present, so the UI can always show something. */
  raw: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
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

export function sectionFor(agent: Agent): Section {
  if (agent.state === "blocked") return "needs-you";
  // An acknowledged finish has been dealt with; it stops competing for
  // attention with agents that still need some.
  if (agent.state === "done") return agent.acknowledgedAt === null ? "needs-you" : "idle";
  if (agent.state === "working") return "working";
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
  const sa = SECTION_ORDER.indexOf(sectionFor(a));
  const sb = SECTION_ORDER.indexOf(sectionFor(b));
  if (sa !== sb) return sa - sb;
  if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince;
  return a.name.localeCompare(b.name);
}
