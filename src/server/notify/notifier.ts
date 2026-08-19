import { agentHash } from "@shared/route";
import type { Agent, AgentState, NotifyTrigger } from "@shared/types";
import type { Delta } from "@server/state/store";
import { isConfigured, type SettingsStore } from "@server/settings/store";

export type TimerHandle = ReturnType<typeof setTimeout>;

const isTrigger = (s: AgentState): s is NotifyTrigger => s === "blocked" || s === "done";

export interface NotifierOpts {
  settings: SettingsStore;
  send: (text: string) => Promise<{ ok: boolean; detail: string | null }>;
  now?: () => number;
  /** Injected so tests drive 5-10 SECOND windows without waiting them out.
   *  The default unrefs, so a pending settle cannot hold the process open. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export class Notifier {
  /** What we last SAW. Always the truth, never reverted. */
  #lastSeen = new Map<string, AgentState>();
  /** What we last SENT A MESSAGE ABOUT. Splitting this from `#lastSeen` is
   *  what removes v2's optimistic-write-and-revert dance: one map was doing
   *  both jobs, and every subtlety in the old comments came from that. */
  #lastNotified = new Map<string, AgentState>();
  /** Last send ATTEMPT (not success) per agent, for the cooldown. */
  #lastSentAt = new Map<string, number>();
  /** In-flight settle windows. At most one per agent. */
  #pending = new Map<string, { state: NotifyTrigger; timer: TimerHandle; attempts: number }>();
  lastError: string | null = null;

  constructor(private o: NotifierOpts) {}

  #now(): number { return (this.o.now ?? Date.now)(); }

  #setTimer(fn: () => void, ms: number): TimerHandle {
    if (this.o.setTimer) return this.o.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    // A settle window must never be the reason the process stays alive.
    t.unref?.();
    return t;
  }

  #clearTimer(h: TimerHandle): void {
    if (this.o.clearTimer) this.o.clearTimer(h);
    else clearTimeout(h);
  }

  /**
   * Synchronous, and now genuinely so: the send happens later, on a timer, so
   * nothing here awaits a third party's latency in front of the WebSocket
   * broadcast this fans out alongside.
   */
  observe(d: Delta): void {
    for (const a of d.upserted) this.#see(a);
    for (const id of d.removedIds) this.#forget(id);
  }

  /** Clears every pending timer. Called from the server's shutdown path. */
  dispose(): void {
    for (const p of this.#pending.values()) this.#clearTimer(p.timer);
    this.#pending.clear();
  }

  #cancel(agentId: string): void {
    const p = this.#pending.get(agentId);
    if (p === undefined) return;
    this.#clearTimer(p.timer);
    this.#pending.delete(agentId);
  }

  #forget(agentId: string): void {
    this.#cancel(agentId);
    this.#lastSeen.delete(agentId);
    // Deleted too, or a returning pane id inherits a suppression it never
    // earned and its first real notification is silently dropped.
    this.#lastNotified.delete(agentId);
    this.#lastSentAt.delete(agentId);
  }

  #see(a: Agent): void {
    const prev = this.#lastSeen.get(a.agentId);
    this.#lastSeen.set(a.agentId, a.state);
    // First sight: paddock cannot tell "just blocked" from "blocked an hour
    // ago", so a restart announces nothing.
    if (prev === undefined || prev === a.state) return;

    // The state moved, so whatever the pending timer was going to claim is
    // void. THIS is the cancel that fixes the subagent handoff; the check at
    // fire time is a guard against a race, not the mechanism.
    this.#cancel(a.agentId);
    if (!isTrigger(a.state)) return;

    const s = this.o.settings.current();
    if (!s.notify.triggers.includes(a.state)) return;
    this.#arm(a, a.state, s.notify.settleMs[a.state], 0);
  }

  #arm(a: Agent, state: NotifyTrigger, ms: number, attempts: number): void {
    const timer = this.#setTimer(() => {
      this.#pending.delete(a.agentId);
      // Nothing else is left to observe a rejection here, and Bun TERMINATES
      // the process on an unhandled one — a `fetch` that throws rather than
      // resolving would take the whole dashboard down over a notification.
      // Recorded on `lastError`, which /api/health exposes, never swallowed.
      void this.#fire(a, state, attempts).catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }, ms);
    this.#pending.set(a.agentId, { state, timer, attempts });
  }

  async #fire(a: Agent, state: NotifyTrigger, attempts: number): Promise<void> {
    if (this.#lastSeen.get(a.agentId) !== state) return;
    if (this.#lastNotified.get(a.agentId) === state) return;

    const s = this.o.settings.current();
    if (!s.notify.enabled) return;
    if (!s.notify.triggers.includes(state)) return;
    // `isConfigured`, not `!== null`: the two differ for an empty string, and
    // an unset environment variable IS an empty string.
    if (!isConfigured(s.telegram.token) || !isConfigured(s.telegram.chatId)) return;

    this.#lastSentAt.set(a.agentId, this.#now());

    // Name, state, link. NOTHING ELSE — and specifically NOT `a.task`, which
    // is live agent-authored text that may carry a pasted credential.
    // Telegram bot messages are not end-to-end encrypted; content minimalism
    // is the ONLY mitigation the design claims for choosing Telegram over Web
    // Push, and adding a field here spends it.
    const link = s.publicUrl ? `\n${s.publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}` : "";
    const r = await this.o.send(`${a.name} is ${state}${link}`);
    if (r.ok) {
      this.#lastNotified.set(a.agentId, state);
      this.lastError = null;
      return;
    }
    this.lastError = r.detail ?? "send failed";
    // The retry lands in Task 3. `attempts` is unused until then, which is
    // fine — tsconfig sets `noUnusedLocals` but not `noUnusedParameters`. Do
    // NOT add a `MAX_ATTEMPTS` const here for the same reason: an unexported
    // unused const IS flagged, so Task 3 declares it where it is first read.
  }
}

/**
 * The composition root's fan-out, extracted so it can be unit-tested directly
 * rather than only by exercising `src/server/index.ts` as a whole.
 *
 * `index.ts` and `tests/notify-wiring.test.ts` both call this one function, so
 * a regression here — dropping either destination — is caught in the test
 * without the test needing to import or run the composition root itself.
 * Parameter types are structural (not `Hub` / `Notifier` directly) so a test
 * can pass plain stubs without casting.
 */
export function fanOut(
  hub: { queue: (d: Delta) => void },
  notifier: { observe: (d: Delta) => void },
): (d: Delta) => void {
  return (d) => {
    hub.queue(d);
    notifier.observe(d);
  };
}
