import { agentHash } from "@shared/route";
import type { Agent, AgentState } from "@shared/types";
import type { Delta } from "@server/state/store";
import { isConfigured, type SettingsStore } from "@server/settings/store";

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
    for (const a of d.upserted) {
      // `#one` is deliberately never awaited (see above), so nothing else is
      // left to observe a rejection — and Bun TERMINATES the process on an
      // unhandled rejection. A `fetch` that throws rather than resolving
      // would take the whole dashboard down over a notification. Recorded on
      // `lastError`, which `/api/health` exposes, rather than swallowed: the
      // design says `observe` "catches its own failures", and the project's
      // standing rule says a caught error is surfaced, never discarded.
      void this.#one(a).catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
      });
    }
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
      // `isConfigured`, not `!== null`: the two are NOT the same for an empty
      // string, and the store's `view()` and the routes both answer with this
      // predicate. Disagreeing here is what made the notifier fire against a
      // credential the rest of the process considered absent.
      && isConfigured(s.telegram.token) && isConfigured(s.telegram.chatId);
    if (!fires) return;

    const now = (this.o.now ?? Date.now)();
    if (inQuietHours(new Date(now), s.notify.quietHours)) {
      // Dropped, never queued: a pile delivered at 08:00 describes agents
      // unblocked five hours earlier — noise wearing the costume of signal.
      return;
    }

    const since = now - (this.#lastSentAt.get(a.agentId) ?? Number.NEGATIVE_INFINITY);
    if (since < s.notify.cooldownMs) {
      // Revert the optimistic `lastSeen` write above, same as the failed-send
      // path below: the cooldown bounds retry FREQUENCY, it does not consume
      // the transition. Without this, an intervening same-state delta inside
      // the cooldown window (a blocked agent's task line updating) would
      // write `lastSeen` forward and never be undone, and every later delta —
      // including ones long past the cooldown — would then read
      // `prev === a.state` and never re-detect the transition again. One
      // failed attempt per episode, and no periodic retry ever, which is the
      // opposite of what the cooldown is for.
      if (this.#lastSeen.get(a.agentId) === a.state) this.#lastSeen.set(a.agentId, prev);
      return;
    }

    // Recorded synchronously too, alongside `lastSeen` above, and NOT reverted
    // on failure below. A broken token fails every send, but `lastSeen` still
    // reverts so the transition keeps re-detecting — if the attempt itself
    // were not also recorded here, every one of those re-detections would see
    // `lastSentAt` still unset (since = Infinity) and fire immediately, i.e.
    // one Telegram POST per delta forever for a blocked agent whose task line
    // keeps changing. Recording the attempt (not just successes) is what
    // makes the cooldown bound the retry rate instead of the retry being lost
    // (reverted `lastSeen`) while its own rate limit is (bugged) unarmed.
    this.#lastSentAt.set(a.agentId, now);

    // Trailing slash stripped: a free-text publicUrl field will collect one,
    // and `${url}/${hash}` with url already ending in "/" would produce
    // "https://host//#/agent/...".
    const link = s.publicUrl ? `\n${s.publicUrl.replace(/\/+$/, "")}/${agentHash(a.agentId)}` : "";
    // Name, state, link. NOTHING ELSE — and specifically NOT `a.task`.
    //
    // `task` is `terminal_title_stripped` (shared/types.ts): live,
    // agent-authored text that carries whatever the agent last echoed,
    // including a pasted credential. Telegram bot messages are not
    // end-to-end encrypted and Telegram can read them; the design accepts
    // that cost and names content minimalism as the ONLY mitigation for
    // choosing Telegram over Web Push. Adding a field here — task, terminal
    // output, cwd, anything agent-authored — spends that mitigation.
    // `tests/notifier.test.ts` asserts the task text is absent.
    const r = await this.o.send(`${a.name} is ${a.state}${link}`);
    if (r.ok) {
      this.lastError = null;
      return;
    }
    // Revert the optimistic `lastSeen` write above so the next delta
    // re-detects this transition and retries. Guarded on nothing else having
    // moved `lastSeen` in the meantime: only undo it if it still holds the
    // value we wrote. `lastSentAt` is deliberately NOT reverted — the retry is
    // bounded by the cooldown, not unbounded.
    if (this.#lastSeen.get(a.agentId) === a.state) this.#lastSeen.set(a.agentId, prev);
    this.lastError = r.detail ?? "send failed";
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
