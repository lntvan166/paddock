import { carryAcknowledged, type Agent, type AgentState } from "@shared/types";
import type { HerdrAgentRaw, HerdrStatusChanged, HerdrWorkspaceRaw } from "@shared/herdr-api";

export interface AdaptContext {
  hostId: string;
  labels: Map<string, string>;
  now: number;
}

/** Leading status glyphs some agents prepend to the terminal title. */
function cleanTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function toState(status: string): AgentState | null {
  if (status === "blocked" || status === "done" || status === "working" || status === "idle") {
    return status;
  }
  return null; // "unknown" and anything new
}

export function workspaceLabels(rows: HerdrWorkspaceRaw[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of rows) if (w.label) map.set(w.workspace_id, w.label);
  return map;
}

/**
 * Normalize one `agent.list` row. Returns null for anything that is not an agent.
 *
 * `name` is the label. NEVER basename(cwd): agents commonly share a working
 * directory, which is exactly how every row ends up looking identical.
 */
export function toAgent(rawAgent: HerdrAgentRaw, ctx: AdaptContext): Agent | null {
  if (!rawAgent.agent) return null;
  const state = toState(rawAgent.agent_status);
  if (!state) return null;

  return {
    hostId: ctx.hostId,
    agentId: rawAgent.pane_id,
    name: rawAgent.name?.trim() || rawAgent.pane_id,
    task: cleanTitle(rawAgent.terminal_title_stripped ?? rawAgent.terminal_title),
    state,
    workspaceId: rawAgent.workspace_id,
    workspaceLabel: ctx.labels.get(rawAgent.workspace_id) ?? null,
    cwd: rawAgent.cwd ?? "",
    stateSince: ctx.now,
    updatedAt: ctx.now,
    acknowledgedAt: null,
  };
}

/**
 * Merge a `pane.agent_status_changed` event into a known agent.
 *
 * The event carries no `name`, so the previous value is preserved. `stateSince`
 * is refreshed only when the state actually changes, so elapsed time means
 * "how long in this state" rather than "time since last event".
 *
 * This is the PRIMARY path that moves an agent's state, so `acknowledgedAt`
 * must be carried/cleared here with the same rule the 30s reconcile uses
 * (`carryAcknowledged`) — not just on the reconcile's healing path. Otherwise
 * an agent whose run is shorter than the reconcile interval (acknowledge →
 * leaves `done` → returns to `done`, all via events) would keep a stale flag
 * forever, permanently hiding every future finish.
 */
export function applyStatusEvent(prev: Agent, data: HerdrStatusChanged, now: number): Agent {
  const state = toState(data.agent_status) ?? prev.state;
  const title = data.title === undefined || data.title === null ? prev.task : cleanTitle(data.title);
  return {
    ...prev,
    state,
    task: title,
    stateSince: state === prev.state ? prev.stateSince : now,
    updatedAt: now,
    acknowledgedAt: carryAcknowledged(prev, state),
  };
}
