import type { Delta } from "@server/state/store";
import type { Agent } from "@shared/types";

interface Listener {
  agentId: string;
  pred: (a: Agent) => boolean;
  done: (r: Agent | "gone" | "timeout") => void;
}

/**
 * A tap on the delta fan-out, so a bridge wait can sleep until an agent's
 * state changes instead of polling herdr.
 *
 * It exists because `AgentStore` has no subscription of its own: changes leave
 * the store only through the `onDelta` callback the composition root passes
 * in, which is where `deltaSink` hangs this beside the hub and the notifier.
 */
export class AgentWatch {
  #listeners = new Set<Listener>();

  /** For tests: a leaked listener is a leaked timer. */
  get listeners(): number { return this.#listeners.size; }

  observe(d: Delta): void {
    for (const l of [...this.#listeners]) {
      if (d.removedIds.includes(l.agentId)) { l.done("gone"); continue; }
      const a = d.upserted.find((u) => u.agentId === l.agentId);
      if (a && l.pred(a)) l.done(a);
    }
  }

  /**
   * Resolves with the agent's record when `pred` holds for an upsert of
   * `agentId`, `"gone"` when it is removed, `"timeout"` after `ms`. Never
   * rejects, and every exit removes the listener and its timer.
   */
  until(agentId: string, pred: (a: Agent) => boolean, ms: number): Promise<Agent | "gone" | "timeout"> {
    return new Promise((resolve) => {
      const l: Listener = {
        agentId, pred,
        done: (r) => {
          clearTimeout(timer);
          this.#listeners.delete(l);
          resolve(r);
        },
      };
      const timer = setTimeout(() => l.done("timeout"), ms);
      this.#listeners.add(l);
    });
  }
}
