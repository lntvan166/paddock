import { agentHash } from "@shared/route";
import type { Agent, AgentState } from "@shared/types";
import type { Delta } from "@server/state/store";
import type { SettingsStore } from "@server/settings/store";

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Quiet hours wrap midnight, and that is the ORDINARY case: 22:00-08:00 has
 * start > end. Read as `start <= t < end` the most common setting an operator
 * types silences nothing at all. Equal start and end is a zero-length window.
 */
export function inQuietHours(d: Date, qh: { start: string; end: string } | null): boolean {
  if (qh === null) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  const s = minutes(qh.start), e = minutes(qh.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export interface NotifierOpts {
  settings: SettingsStore;
  send: (text: string) => Promise<{ ok: boolean; detail: string | null }>;
  now?: () => number;
}

export class Notifier {
  /** Delta carries only the NEW agent, so a transition cannot be derived
   *  without remembering what we last saw. This map is also the dedup. */
  #lastSeen = new Map<string, AgentState>();
  #lastSentAt = new Map<string, number>();
  lastError: string | null = null;

  constructor(private o: NotifierOpts) {}

  /**
   * Returns void and never awaits. `observe` is a synchronous fan-out feeding
   * the WebSocket broadcast; awaiting Telegram would put a third party's
   * latency in front of every browser update.
   */
  observe(d: Delta): void {
    for (const a of d.upserted) void this.#one(a);
    for (const id of d.removedIds) { this.#lastSeen.delete(id); this.#lastSentAt.delete(id); }
  }

  async #one(a: Agent): Promise<void> {
    const prev = this.#lastSeen.get(a.agentId);
    if (prev === undefined) { this.#lastSeen.set(a.agentId, a.state); return; }  // first sight
    if (prev === a.state) return;

    // Recorded synchronously, before any `await`: `observe` is fire-and-forget
    // (never awaited by its caller), so a second delta for the same agent can
    // arrive and run its own synchronous prefix before this call's `send`
    // settles. Leaving the transition unrecorded until after the send would
    // let that second delta re-read the stale `prev` and re-fire for a state
    // that was already handled. Only a failed send (below) reverts this.
    this.#lastSeen.set(a.agentId, a.state);

    const s = this.o.settings.current();
    const fires = s.notify.enabled
      && s.notify.triggers.includes(a.state as never)
      && s.telegram.token !== null && s.telegram.chatId !== null;
    if (!fires) return;

    const now = (this.o.now ?? Date.now)();
    if (inQuietHours(new Date(now), s.notify.quietHours)) {
      // Dropped, never queued: a pile delivered at 08:00 describes agents
      // unblocked five hours earlier — noise wearing the costume of signal.
      return;
    }

    const since = now - (this.#lastSentAt.get(a.agentId) ?? Number.NEGATIVE_INFINITY);
    if (since < s.notify.cooldownMs) return;

    // Trailing slash stripped: a free-text publicUrl field will collect one,
    // and `${url}/${hash}` with url already ending in "/" would produce
    // "https://host//#/agent/...".
    const link = s.publicUrl ? `\n${s.publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}` : "";
    const r = await this.o.send(`${a.name} is ${a.state}\n${a.task}${link}`);
    if (r.ok) {
      this.lastError = null;
      this.#lastSentAt.set(a.agentId, now);
      return;
    }
    // Revert the optimistic write above so the next delta re-detects this
    // transition and retries. Guarded on nothing else having moved `lastSeen`
    // in the meantime: only undo it if it still holds the value we wrote.
    if (this.#lastSeen.get(a.agentId) === a.state) this.#lastSeen.set(a.agentId, prev);
    this.lastError = r.detail ?? "send failed";
  }
}
