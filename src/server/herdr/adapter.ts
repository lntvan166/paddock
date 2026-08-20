import { carryAcknowledged, type Agent, type AgentState } from "@shared/types";
import type { HerdrAgentRaw, HerdrAgentSession, HerdrStatusChanged, HerdrWorkspaceRaw } from "@shared/herdr-api";

export interface AdaptContext {
  hostId: string;
  labels: Map<string, string>;
  now: number;
  /**
   * Whether a journal adapter exists for this session. INJECTED rather than
   * imported: `journal/` is a harness-axis module and this file is the herdr
   * adapter, so importing it here would cross the two axes permanently.
   * Defaults to false, which is exactly "paddock reads no journals".
   */
  hasJournal?: (session: HerdrAgentSession | null | undefined) => boolean;
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
 * `name` is the label, and this per-row mapper falls back to `pane_id` because
 * it CANNOT see the other rows: whether a friendlier label would be unique is
 * not a fact about one row. `toAgents` is the layer that decides that, and it
 * is what the application calls. Use this directly only when one row is
 * genuinely all you have.
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
    hasJournal: ctx.hasJournal?.(rawAgent.agent_session) ?? false,
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

/**
 * The label an operator actually reads, decided across the WHOLE list.
 *
 * `w3:p1` is correct and useless: it identifies the pane and tells you nothing
 * about what the agent is doing. herdr does not require a name, and an operator
 * who never sets one got a dashboard of coordinates.
 *
 * So an unnamed agent is labelled from `basename(cwd)` — WITH mandatory
 * disambiguation. Read `docs/gotchas.md` before touching this: the rule there
 * is not "cwd is forbidden", it is "two rows must never render identically",
 * and cwd was forbidden because on its own it cannot promise that. The promise
 * is what this function adds, so the rule is satisfied rather than waived. If
 * you remove the suffixing, restore the ban.
 *
 * Three rungs, and a label only climbs one when the rung below is ambiguous:
 *
 *   project            one unnamed agent in /srv/project
 *   project p1         a second one joins it
 *   project w1:p1      "w1:p1" and "w2:p1" both reduce to "p1"
 *
 * A name the operator set is never rewritten — but it does occupy its label,
 * so a fallback that would duplicate it moves aside instead. What matters is
 * what is distinguishable on screen, not which field the string came from.
 *
 * Recomputed on every reconcile rather than remembered, so a suffix appears
 * when an agent joins and goes away when it leaves. That is the accepted cost
 * of a familiar label: `AgentChip` renders the name ALONE, so an idle section
 * of five identical chips is not a cosmetic complaint, it is five controls
 * with no way to tell which one you are about to tap.
 */
export function toAgents(rows: HerdrAgentRaw[], ctx: AdaptContext): Agent[] {
  const mapped: { agent: Agent; raw: HerdrAgentRaw }[] = [];
  for (const raw of rows) {
    const agent = toAgent(raw, ctx);
    if (agent !== null) mapped.push({ agent, raw });
  }

  // Labels that are already spoken for. Only operator-set names go in here:
  // a fallback must never reserve a label against another fallback, or the
  // first row processed would win by accident of ordering.
  const taken = new Set<string>();
  for (const { raw } of mapped) {
    const given = raw.name?.trim();
    if (given) taken.add(given);
  }

  const fallbacks = mapped.filter(({ raw }) => !raw.name?.trim());
  const byBase = new Map<string, typeof fallbacks>();
  for (const entry of fallbacks) {
    const base = baseName(entry.agent.cwd);
    if (base === null) continue; // keeps toAgent's pane_id
    const group = byBase.get(base);
    if (group) group.push(entry);
    else byBase.set(base, [entry]);
  }

  for (const [base, group] of byBase) {
    if (group.length === 1 && !taken.has(base)) {
      group[0]!.agent.name = base;
      continue;
    }
    // Ambiguous: every member of the group is suffixed, including the first.
    // Suffixing only the later ones would make a label depend on arrival
    // order, so the same two agents would read differently after a restart.
    const short = new Map<string, number>();
    for (const { raw } of group) {
      const s = paneSuffix(raw.pane_id);
      short.set(s, (short.get(s) ?? 0) + 1);
    }
    for (const entry of group) {
      const s = paneSuffix(entry.raw.pane_id);
      // The short suffix is dropped for the WHOLE row, not just the colliding
      // pair, only when it is itself ambiguous — `p1` in two workspaces says
      // as little as no suffix at all.
      entry.agent.name = `${base} ${short.get(s)! > 1 ? entry.raw.pane_id : s}`;
    }
  }

  return mapped.map(({ agent }) => agent);
}

/**
 * The last path segment of a cwd, or null when there is not one.
 *
 * Null is the answer for `""`, `"/"` and `"///"` — a root or an absent cwd has
 * no name to borrow, and `""` as a label is worse than the pane id it would
 * replace.
 */
function baseName(cwd: string): string | null {
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const seg = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return seg === "" ? null : seg;
}

/** `w3:p1` → `p1`. Unchanged when there is no workspace prefix to drop. */
function paneSuffix(paneId: string): string {
  return paneId.slice(paneId.lastIndexOf(":") + 1);
}

/**
 * Session ids by pane id, for the server side only.
 *
 * Separate from `toAgents` because the result must NOT travel with the agent:
 * `Agent` crosses the socket to the browser and this does not.
 */
export function sessionRefs(rows: HerdrAgentRaw[]): Map<string, HerdrAgentSession> {
  const out = new Map<string, HerdrAgentSession>();
  for (const row of rows) {
    if (row.agent_session) out.set(row.pane_id, row.agent_session);
  }
  return out;
}
