import { SECTION_ORDER, sectionFor, type Agent } from "@shared/types";

export interface Delta {
  upserted: Agent[];
  removedIds: string[];
}

/** Fields whose change is worth sending to a browser. */
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

  /** Display order: section, then most-recent state change, then name. */
  snapshot(): Agent[] {
    return [...this.agents.values()].sort((a, b) => {
      const sa = SECTION_ORDER.indexOf(sectionFor(a.state));
      const sb = SECTION_ORDER.indexOf(sectionFor(b.state));
      if (sa !== sb) return sa - sb;
      if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince;
      return a.name.localeCompare(b.name);
    });
  }
}
