import { carryAcknowledged, type Agent, type AgentState } from "@shared/types";
import type { CoreEvent, CoreStatus, CoreTerminal } from "@shared/herdr-core-api";
import { coreId } from "@shared/origin";

/**
 * The only place a herdr-core terminal becomes a paddock `Agent`. Mirrors
 * `herdr/adapter.ts`: all field mapping lives here, so a protocol change
 * touches this file and `socket.ts` and nothing else.
 */

const KNOWN_STATES: ReadonlySet<string> = new Set(["idle", "working", "done", "blocked", "error"]);

/** Status words already reported, so a new word is logged once, not per event. */
const loggedUnknown = new Set<string>();

/**
 * The program's own word, narrowed to a state paddock renders. The API only
 * grows, so an unknown word is tolerated as `idle` (the one state that never
 * raises an alarm or hides an agent) and said once at INFO, never silently.
 */
export function toState(word: string): AgentState {
  if (KNOWN_STATES.has(word)) return word as AgentState;
  if (!loggedUnknown.has(word)) {
    loggedUnknown.add(word);
    console.info(`herdr-core: unknown status word "${word}", treating as idle`);
  }
  return "idle";
}

/** `claude-code` is what Claude Code reports; paddock's harness id is `claude`. */
export function toHarness(app: string | undefined): string {
  if (!app) return "";
  return app === "claude-code" ? "claude" : app;
}

/** "api-space / 1" is the app's `where` label: the space name, then the tab. */
export function spaceLabel(labels: Record<string, string>): string | null {
  const where = labels["where"];
  if (!where) return null;
  const i = where.indexOf(" / ");
  return (i === -1 ? where : where.slice(0, i)) || null;
}

/**
 * What the app calls an unnamed agent: its tab, from `where`. A tab the
 * operator never named is known by its number ("gt / 2"), which alone is no
 * name, so it is said with its space ("gt 2").
 */
export function tabName(labels: Record<string, string>): string | null {
  const where = labels["where"];
  if (!where) return null;
  const i = where.indexOf(" / ");
  if (i === -1) return null;
  const tab = where.slice(i + 3).trim();
  if (!tab) return null;
  return /^\d+$/.test(tab) ? `${where.slice(0, i)} ${tab}` : tab;
}

/** The agent's own name, else its tab's, else its address — never its folder. */
function nameOf(t: Pick<CoreTerminal, "name" | "address">, labels: Record<string, string>): string {
  return t.name ?? tabName(labels) ?? t.address;
}

/** Raw space id for a terminal the app has not put in a space. */
export const CORE_UNGROUPED = "ungrouped";

/** Never an empty raw id: a terminal without a space label is "ungrouped". */
function workspaceIdOf(labels: Record<string, string>): string {
  return coreId(labels["herdr.space"] || CORE_UNGROUPED);
}

function toSeen(labels: Record<string, string>): number | null {
  const raw = labels["herdr.seen"];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function taskOf(status: CoreStatus, fallback: string): string {
  return status.msg || status.title || fallback;
}

/**
 * Normalize one terminal record. Null for anything that is not a live agent
 * with its own pane. `name` falls back to the tab, then the address, and never
 * to `basename(cwd)`: agents share working directories, and every row would
 * read the same.
 */
export function toCoreAgent(t: CoreTerminal, hostId: string): Agent | null {
  if (t.state !== "live") return null;
  const status = t.status;
  if (!status) return null; // never reported: a shell, not an agent
  // A sub-agent without a tab has no pane to show: out of v1.
  if (t.parent && t.labels["herdr.tab"] === undefined) return null;

  const stateSince = t.status_ms ?? t.created_ms;
  return {
    hostId,
    agentId: coreId(t.address),
    name: nameOf(t, t.labels),
    task: taskOf(status, t.title || ""),
    state: toState(status.state),
    workspaceId: workspaceIdOf(t.labels),
    workspaceLabel: spaceLabel(t.labels),
    cwd: t.cwd,
    harness: toHarness(status.app),
    stateSince,
    stateSinceExact: true,
    updatedAt: stateSince,
    acknowledgedAt: null,
    hasJournal: false,
    origin: "core",
    turn: t.turn ?? null,
    seen: toSeen(t.labels),
  };
}

export interface CoreEventContext {
  /** Needed only when an event creates an agent from nothing. */
  hostId?: string;
  now?: number;
}

/**
 * Apply one event to the agent it concerns (`prev`, or null when the terminal
 * is not currently an agent). Returns the new agent, or null when the terminal
 * is not (or no longer) an agent.
 *
 * `record` is the caller's full, current terminal record. It is how a terminal
 * that was never an agent becomes one (`created`, `restarted`, a `labels`
 * event that newly matches, a first `status`): without prev there is nothing
 * to patch. Event types this generation does not know leave `prev` alone.
 */
export function applyCoreEvent(
  prev: Agent | null,
  e: CoreEvent,
  record?: CoreTerminal,
  ctx: CoreEventContext = {},
): Agent | null {
  // A host is never guessed: with no prev to inherit from, the caller says.
  // Resolved lazily so events that create nothing (removed, finished) need none.
  const host = (): string => {
    const h = ctx.hostId ?? prev?.hostId;
    if (h === undefined) {
      throw new Error(`applyCoreEvent: ctx.hostId is required to build an agent for ${e.terminal ?? "an unknown terminal"} without a previous agent`);
    }
    return h;
  };
  const now = ctx.now ?? Date.now();
  switch (e.type) {
    case "created":
    case "restarted":
      return toCoreAgent((e as Extract<CoreEvent, { type: "created" }>).data, host());
    case "removed":
    case "finished":
      return null;
    case "status": {
      const { status } = (e as Extract<CoreEvent, { type: "status" }>).data;
      if (!status) return null; // cleared: no longer an agent
      if (!prev) return record ? toCoreAgent(record, host()) : null;
      const state = toState(status.state);
      return {
        ...prev,
        state,
        task: taskOf(status, prev.task),
        harness: status.app ? toHarness(status.app) : prev.harness,
        stateSince: state === prev.state ? prev.stateSince : now,
        stateSinceExact: true,
        updatedAt: now,
        acknowledgedAt: carryAcknowledged(prev, state),
      };
    }
    case "turn": {
      if (!prev) return null;
      return { ...prev, turn: (e as Extract<CoreEvent, { type: "turn" }>).data.turn, updatedAt: now };
    }
    case "labels": {
      const { labels, record: matched } = (e as Extract<CoreEvent, { type: "labels" }>).data;
      if (matched) return toCoreAgent(matched, host());
      if (!prev) return record ? toCoreAgent(record, host()) : null;
      return {
        ...prev,
        // A tab rename reaches an unnamed agent here. Without the record the
        // agent's own name is unknown, so the name it has stands.
        name: record ? nameOf(record, labels) : prev.name,
        workspaceId: workspaceIdOf(labels),
        workspaceLabel: spaceLabel(labels),
        seen: toSeen(labels),
        updatedAt: now,
      };
    }
    default:
      return prev;
  }
}
