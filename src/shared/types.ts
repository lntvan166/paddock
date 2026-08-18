import type { ScreenPatch } from "@shared/screen";

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
  /**
   * The line the agent's `❯` cursor sits on, marker stripped, or null.
   *
   * Reported INDEPENDENTLY of `options`, and that independence is the point.
   * The keypad's ↓ wraps from the last option back to the first, and the
   * middle option of a permission prompt is routinely a persistent grant
   * ("and don't ask again"), so one tap too many can commit a standing
   * permission. The wrap is not really the hazard — the wrap being invisible
   * is. Showing what Enter will commit removes it, and keeps working on
   * prompt shapes the option parser deliberately refuses to read.
   */
  selected: string | null;
  /** The snapshot as read. Always present, so the UI can always show something. */
  raw: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
}

/**
 * The keys the terminal view is allowed to send, as a CLOSED allowlist.
 *
 * These are navigation, not answers. An arrow key makes no claim about what
 * an option means — the operator reads the agent's real screen, watches the
 * agent's own `❯` cursor move, and commits with Enter. That is strictly more
 * faithful than a parsed button, and it is why this path works on prompt
 * shapes the parser cannot read (`options: null`) as well as ones it can.
 *
 * Closed on purpose. `agent.prompt` accepts arbitrary text and `send_keys`
 * accepts arbitrary control sequences, so the boundary is enforced here and
 * at the route rather than trusted to the UI: paddock still has no
 * general-purpose key-send endpoint. Every name below was verified accepted
 * by herdr 0.8.0 on a throwaway pane; `pageup`, `pagedown`, `home` and `end`
 * are rejected by herdr (`invalid_key`) and are therefore absent.
 */
export const NAV_KEYS = [
  "up", "down", "left", "right", "enter", "esc", "tab", "space", "backspace",
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(value: unknown): value is NavKey {
  return typeof value === "string" && (NAV_KEYS as readonly string[]).includes(value);
}

/**
 * A key press plus the screen it produced.
 *
 * The re-read is part of the response rather than a follow-up request because
 * the two are one interaction: pressing ↓ and seeing the cursor move is a
 * single act to the operator, and splitting it into two round trips over a
 * ~250 ms link is what would make navigation feel broken.
 */
export interface KeyResult extends ActionResult {
  lines: string[];
  source: string;
  /**
   * The cursor line after the key landed, so the "Enter will select" preview
   * tracks every ↓ without a second round trip. Null when no cursor is on
   * screen — which is the normal case for an agent that is not being asked
   * anything.
   */
  selected?: string | null;
}

/**
 * A read response, which may say "nothing changed" instead of resending.
 *
 * Measured on a live working agent: consecutive 3s polls differ by 3 lines out
 * of 63, so ~95% of a 10.8 KB response is bytes the client already has. The
 * client sends the digest of the screen it is holding; when it still matches,
 * the server answers `{ unchanged: true }` and no screen is transmitted.
 *
 * This is deliberately an application-level revalidation rather than an HTTP
 * `ETag`: these are POST routes (spec §12 — payloads must never reach a query
 * string, and a GET would put read parameters in edge access logs), and
 * browsers do not perform conditional revalidation on POST.
 */
export type OutputResult =
  | { unchanged: true }
  /**
   * Only the lines that moved. The common case by a wide margin: measured on
   * a live agent at 250ms, the MEDIAN changed update touched ONE line of 63,
   * because a thinking agent redraws only its spinner and token counter.
   * Sending the whole screen for that cost ~2052 B gzipped against ~211 B for
   * the lines alone — about 30 MB/hour versus 3.
   *
   * `digest` is the digest of the screen the patch should PRODUCE, so the
   * client can verify after applying and ask for a full screen if it
   * disagrees. A patch that silently mis-applies would show terminal output
   * that never existed.
   */
  | { unchanged?: false; patch: ScreenPatch; source: string }
  | { unchanged?: false; lines: string[]; source: string; digest: string };

export type ServerMessage =
  | { type: "snapshot"; hostId: string; agents: Agent[]; serverTime: number; build?: string | null }
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
  /**
   * Carries the server's current build id so an ALREADY-OPEN tab can notice it
   * is running stale JavaScript. `index.html` is `no-cache`, which fixes fresh
   * loads and does nothing for a tab left open on a phone for days.
   */
  | { type: "heartbeat"; serverTime: number; build?: string | null };

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
