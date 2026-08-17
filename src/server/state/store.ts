import { carryAcknowledged, compareAgents, type Agent } from "@shared/types";

export interface Delta {
  upserted: Agent[];
  removedIds: string[];
}

/**
 * Fields whose change is worth sending to a browser.
 *
 * `acknowledgedAt` is deliberately absent, and that is only correct because of
 * a two-step argument worth stating rather than rediscovering:
 *
 *  1. **`acknowledgedAt !== null` implies `state === "done"`,** on all three
 *     write paths. `acknowledge()` below refuses any agent that is not `done`;
 *     `replaceAll` and the push path (`applyStatusEvent` in
 *     `herdr/adapter.ts`) both run the flag through `carryAcknowledged`, which
 *     nulls it for any non-`done` state. A fresh row arrives with `null`.
 *  2. Therefore the flag can only ever go **null → non-null** inside
 *     `acknowledge()`, which builds its own delta and does not consult this
 *     function, or **non-null → null** as part of leaving `done` — a state
 *     change `differs` already reports on its own.
 *
 * So there is no reachable case where `acknowledgedAt` changes while every
 * field below stays equal. Break step 1 — set the flag anywhere without the
 * `done` guard — and a dismissal would stop reaching other browsers.
 */
function differs(a: Agent, b: Agent): boolean {
  return (
    a.name !== b.name ||
    a.task !== b.task ||
    a.state !== b.state ||
    a.workspaceLabel !== b.workspaceLabel ||
    a.cwd !== b.cwd
  );
}

export class AgentStore {
  private readonly agents = new Map<string, Agent>();

  constructor(readonly hostId: string) {}

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Drop one agent, for a pane_closed / pane_exited event. Returns null when
   * the agent was already gone, so a duplicate event does not emit an empty
   * delta to every browser.
   */
  remove(agentId: string): Delta | null {
    if (!this.agents.delete(agentId)) return null;
    return { upserted: [], removedIds: [agentId] };
  }

  /**
   * Reconcile against a full listing. `stateSince` from the incoming rows is
   * only adopted when the state actually changed, so a reconcile never resets
   * elapsed time for an agent that has been sitting in one state.
   */
  replaceAll(incoming: Agent[], now: number): Delta {
    const upserted: Agent[] = [];
    const seen = new Set<string>();

    for (const next of incoming) {
      seen.add(next.agentId);
      const prev = this.agents.get(next.agentId);
      if (!prev) {
        this.agents.set(next.agentId, next);
        upserted.push(next);
        continue;
      }
      const merged: Agent = {
        ...next,
        stateSince: next.state === prev.state ? prev.stateSince : now,
        updatedAt: now,
        // Same carry rule as the push path (applyStatusEvent) — see
        // carryAcknowledged in @shared/types for why there is only one copy.
        acknowledgedAt: carryAcknowledged(prev, next.state),
      };
      this.agents.set(next.agentId, merged);
      if (differs(prev, merged)) upserted.push(merged);
    }

    const removedIds: string[] = [];
    for (const id of this.agents.keys()) {
      if (!seen.has(id)) removedIds.push(id);
    }
    for (const id of removedIds) this.agents.delete(id);

    return { upserted, removedIds };
  }

  applyEvent(agentId: string, mutate: (prev: Agent) => Agent): Agent | null {
    const prev = this.agents.get(agentId);
    if (!prev) return null;
    const next = mutate(prev);
    this.agents.set(agentId, next);
    return next;
  }

  /**
   * Dismiss a `done` agent from Needs you. Returns null when the agent is
   * unknown, not `done`, or already acknowledged — so a double-tap does not
   * broadcast a no-op delta to every browser.
   */
  acknowledge(agentId: string, now: number): Delta | null {
    const prev = this.agents.get(agentId);
    if (!prev || prev.state !== "done" || prev.acknowledgedAt !== null) return null;
    const next = { ...prev, acknowledgedAt: now, updatedAt: now };
    this.agents.set(agentId, next);
    return { upserted: [next], removedIds: [] };
  }

  /**
   * Display order: section, then most-recent state change, then name — the
   * ONE comparator from the shared contract, which the client applies again
   * after every delta. Sorting here is not enough on its own: a snapshot is
   * sent only on connect.
   */
  snapshot(): Agent[] {
    return [...this.agents.values()].sort(compareAgents);
  }
}
