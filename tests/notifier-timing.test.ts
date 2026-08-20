import { expect, test } from "bun:test";
import { Notifier, type TimerHandle } from "@server/notify/notifier";
import type { Agent, NotifyTrigger } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix",
  task: "Re-running the suite", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

function harness(o: { mutedUntil?: number | null; cooldownMs?: number; failWith?: string } = {}) {
  const sent: string[] = [];
  // Every send INVOCATION, success or failure — unlike `sent`, which only
  // records successes and so cannot see a failed attempt at all. Needed to
  // tell "deferred, retry budget untouched" apart from "one attempt burned
  // on the deferral": both leave `sent` empty either way.
  const calls: string[] = [];
  let now = NOW;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let muted = o.mutedUntil ?? null;

  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: {
        enabled: true, triggers: ["blocked", "done"] as NotifyTrigger[],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: muted,
        cooldownMs: o.cooldownMs ?? 0,
      },
      publicUrl: null,
    }),
  };

  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => {
      calls.push(text);
      if (o.failWith !== undefined) return { ok: false, detail: o.failWith };
      sent.push(text);
      return { ok: true, detail: null };
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id as unknown as TimerHandle;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });

  async function advance(ms: number): Promise<void> {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
    await Bun.sleep(1);
  }

  return { n, sent, calls, advance, notifier: n, setMuted: (v: number | null) => { muted = v; },
           pending: () => timers.size };
}

/** Drive one agent from working into a trigger state. */
function transition(n: Notifier, state: Agent["state"]): void {
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ state })], removedIds: [] });
}

test("mute suppresses the message", async () => {
  const h = harness({ mutedUntil: NOW + 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.sent).toEqual([]);
});

test("a message suppressed by mute is dropped, not delivered when mute expires", async () => {
  // A pile delivered at 08:00 describes agents unblocked five hours earlier —
  // noise wearing the costume of signal. Carried over verbatim from the quiet
  // hours reasoning it replaces.
  const h = harness({ mutedUntil: NOW + 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  h.setMuted(null);
  await h.advance(120_000);
  expect(h.sent).toEqual([]);
});

test("mute is read at fire time, so muting during a settle window still silences", async () => {
  const h = harness();
  transition(h.n, "blocked");
  h.setMuted(NOW + 60_000);
  await h.advance(0);
  expect(h.sent).toEqual([]);
});

test("a cooldown miss defers the message rather than losing it", async () => {
  // The cooldown bounds how OFTEN paddock may speak about one agent. Treating
  // it as a drop would lose a real finish because a blocked message went out
  // 20s earlier — which is exactly the notification the operator wanted.
  const h = harness({ cooldownMs: 60_000 });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.sent).toEqual(["flaky-test-fix is blocked"]);

  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(20_000);
  expect(h.sent).toEqual(["flaky-test-fix is blocked"]);   // still inside the window
  await h.advance(41_000);
  expect(h.sent).toEqual(["flaky-test-fix is blocked", "flaky-test-fix is done"]);
});

test("a failed send retries at the cooldown, three attempts, then stops", async () => {
  const h = harness({ cooldownMs: 60_000, failWith: "chat not found" });
  transition(h.n, "blocked");
  await h.advance(0);
  expect(h.notifier.lastError).toBe("chat not found");
  await h.advance(60_001);
  await h.advance(60_001);
  // Third attempt has now run; nothing further may be armed.
  expect(h.pending()).toBe(0);
  await h.advance(600_000);
  expect(h.pending()).toBe(0);
  expect(h.notifier.lastError).toBe("chat not found");
});

test("a cooldown deferral does not consume a retry attempt", async () => {
  // Every send here fails, so `attempts` is the only thing standing between
  // "three tries" and "the deferral quietly spent one": passing
  // `attempts + 1` on the defer branch instead of `attempts` would exhaust
  // the cap one send early, which `sent` alone (always empty here) cannot
  // show — it takes counting every attempt and watching when the retry
  // timer stops being armed.
  const h = harness({ cooldownMs: 60_000, failWith: "chat not found" });
  transition(h.n, "blocked");
  await h.advance(0);                    // t=0: send #1 (fails); re-arm @60_000, attempts=1
  expect(h.calls.length).toBe(1);

  h.n.observe({ upserted: [agent({ state: "done" })], removedIds: [] });
  await h.advance(10_000);               // t=10_000: done's settle fires; since=10_000 < 60_000 -> DEFER
  expect(h.calls.length).toBe(1);        // no send yet — the deferral did not attempt

  await h.advance(50_000);               // t=60_000: since=60_000 -> send #2 (fails); re-arm attempts=1
  await h.advance(60_000);               // t=120_000: send #3 (fails)
  // Bug (defer passing attempts+1) reaches the cap here and stops arming;
  // correct code still has one retry left queued.
  expect(h.pending()).toBe(1);

  await h.advance(60_000);               // t=180_000: send #4 (fails), cap now genuinely reached
  expect(h.calls.length).toBe(4);
});
