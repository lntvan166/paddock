import { expect, test } from "bun:test";
import { Notifier } from "@server/notify/notifier";
import type { Agent, AgentState, InlineKeyboard } from "@shared/types";

const NOW = 1_700_000_000_000;
const PHONE = "dk-phone";
const TABLET = "dk-tablet";

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "flaky-test-fix",
  task: "Quarantine the retry test", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

type PushPayload = { name: string; state: AgentState; agentId: string; skipDeviceKeys: Set<string> };

/** Mirrors `tests/notifier-push.test.ts`'s harness, plus presence. */
function buildNotifier(o: {
  send?: (text: string, m?: InlineKeyboard) => Promise<{ ok: boolean; detail: string | null }>;
  sendPush?: (p: PushPayload) => Promise<void>;
  viewers?: (agentId: string) => Set<string>;
  pushDeviceKeys?: () => Set<string>;
  telegram?: { token: string; chatId: string };
  skipWhileViewing?: boolean;
  cooldownMs?: number;
}) {
  const store = {
    current: () => ({
      // No Telegram by default here: presence governs push, and a configured
      // Telegram would deliver every one of these and mask the behaviour.
      telegram: o.telegram ?? { token: "", chatId: "" },
      notify: {
        telegram: true, triggers: ["blocked"],
        settleMs: { blocked: 0, done: 0 }, mutedUntil: null,
        cooldownMs: o.cooldownMs ?? 60_000,
        skipWhileViewing: o.skipWhileViewing ?? true,
      },
      push: { enabled: true },
      publicUrl: "https://paddock.example.com",
    }),
  };
  return new Notifier({
    settings: store as never,
    send: o.send ?? (async () => ({ ok: true, detail: null })),
    sendPush: o.sendPush,
    viewers: o.viewers,
    pushDeviceKeys: o.pushDeviceKeys,
    now: () => NOW,
  });
}

async function settleBlocked(n: Notifier, over: Partial<Agent> = {}) {
  n.observe({ upserted: [agent({ ...over, state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ ...over, state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);
}

test("no push is sent when the only device is showing that agent", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  // Not "sent and then dropped by the transport" — nothing is dispatched at
  // all, which is also what leaves the cooldown unspent.
  expect(push).toEqual([]);
});

test("a viewer of a DIFFERENT agent suppresses nothing", async () => {
  // Suppression is per agent, not per app. Reading docs-cleanup must never
  // silence flaky-test-fix.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: (id) => (id === "w9:p9" ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a second device that is not looking is still told", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE, TABLET]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  // The phone is named to the transport, which skips it. Partial suppression
  // sends: you were told, on a device that was not already showing you.
  expect([...push[0]!.skipDeviceKeys]).toEqual([PHONE]);
});

test("with nothing subscribed, a viewer suppresses nothing", async () => {
  // An empty roster is not suppression, and deferring would wait for a
  // departure that can never happen.
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set(),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("Telegram still delivers while push is withheld", async () => {
  // A device key identifies one browser. A Telegram chat can be read from a
  // laptop, so presence can make no claim about it.
  const telegram: string[] = [];
  const push: PushPayload[] = [];
  const n = buildNotifier({
    telegram: { token: "1:A", chatId: "555" },
    send: async (t) => { telegram.push(t); return { ok: true, detail: null }; },
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(telegram).toHaveLength(1);
  expect(push).toEqual([]);
});

test("the toggle off restores today's behaviour exactly", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    skipWhileViewing: false,
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
  });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
  expect([...push[0]!.skipDeviceKeys]).toEqual([]);
});

test("a notifier with no presence getters behaves as it does today", async () => {
  // The demo server and an attached tunnel construct a notifier without
  // presence. Absent getters must mean "no suppression", never "suppress
  // everything".
  const push: PushPayload[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p); } });
  await settleBlocked(n);
  expect(push).toHaveLength(1);
});

test("a withheld notification fires when the viewer leaves", async () => {
  // The failure this exists to prevent: look at an agent as it blocks, pocket
  // the phone ten seconds later without answering, and nothing ever tells you.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  expect(push).toEqual([]);

  looking = false;
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
  expect(push[0]!.name).toBe("flaky-test-fix");
});

test("a withheld send does not spend the cooldown", async () => {
  // If the withheld path stamped `#lastSentAt`, this deferral would wait out a
  // full cooldown after the viewer left — a minute of silence, by default, for
  // a send that never happened. The clock is frozen at NOW, so a spent
  // cooldown means the assertion below sees nothing.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 60_000,
  });
  await settleBlocked(n);
  looking = false;
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
});

test("an agent that unblocked while you watched it notifies nobody later", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  // Answered on the spot: the episode is over and the deferral has nothing
  // true left to say.
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  await Bun.sleep(5);
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("blocked, watched, unblocked and blocked again fires once", async () => {
  // The episode trap. A deferral from the FIRST blocked episode must not fire
  // against the second, and must not double up with it.
  const push: PushPayload[] = [];
  let looking = true;
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);              // deferred, episode 1
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  await Bun.sleep(5);
  looking = false;
  n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(5);                  // episode 2 sends: nobody is looking
  n.reconsider("w1:p1");               // episode 1's deferral, now void
  await Bun.sleep(5);
  expect(push).toHaveLength(1);
});

test("a deferral is dropped when the agent goes away", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({
    sendPush: async (p) => { push.push(p); },
    viewers: () => new Set([PHONE]),
    pushDeviceKeys: () => new Set([PHONE]),
    cooldownMs: 0,
  });
  await settleBlocked(n);
  n.observe({ upserted: [], removedIds: ["w1:p1"] });
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("reconsider for an agent with nothing deferred does nothing", async () => {
  const push: PushPayload[] = [];
  const n = buildNotifier({ sendPush: async (p) => { push.push(p); } });
  n.reconsider("w1:p1");
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("mute discards a deferral rather than queuing it", async () => {
  // `mutedUntil` drops rather than queues — a pile delivered when mute lifts
  // describes agents unblocked hours earlier. A deferral surviving mute would
  // be exactly that pile, one entry at a time.
  const push: PushPayload[] = [];
  let looking = true;
  let muted = false;
  const store = {
    current: () => ({
      telegram: { token: "", chatId: "" },
      notify: {
        telegram: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 },
        mutedUntil: muted ? NOW + 60_000 : null, cooldownMs: 0, skipWhileViewing: true,
      },
      push: { enabled: true },
      publicUrl: null,
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async () => ({ ok: true, detail: null }),
    sendPush: async (p) => { push.push(p as PushPayload); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    now: () => NOW,
  });
  await settleBlocked(n);        // deferred
  muted = true;
  looking = false;
  n.reconsider("w1:p1");         // meets the mute
  await Bun.sleep(5);
  muted = false;
  n.reconsider("w1:p1");         // and there is nothing left to release
  await Bun.sleep(5);
  expect(push).toEqual([]);
});

test("unticking a trigger while an episode is deferred clears the deferral, not just declines once", async () => {
  // `#fire`'s trigger check returns before reaching the `#deferred.delete`
  // further down, so a deferred entry that fails the trigger check must clear
  // itself right there — otherwise it sits in `#deferred` and a LATER
  // presence event (the viewer leaving, the trigger being re-ticked) re-arms
  // it and lets it fire on stale reasoning. Proven observably: re-ticking the
  // trigger and releasing the viewer must NOT deliver the notification the
  // operator had already dismissed the trigger for.
  const push: PushPayload[] = [];
  let looking = true;
  let triggers: AgentState[] = ["blocked"];
  const store = {
    current: () => ({
      telegram: { token: "", chatId: "" },
      notify: {
        telegram: true, triggers, settleMs: { blocked: 0, done: 0 },
        mutedUntil: null, cooldownMs: 0, skipWhileViewing: true,
      },
      push: { enabled: true },
      publicUrl: null,
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async () => ({ ok: true, detail: null }),
    sendPush: async (p) => { push.push(p as PushPayload); },
    viewers: () => (looking ? new Set([PHONE]) : new Set()),
    pushDeviceKeys: () => new Set([PHONE]),
    now: () => NOW,
  });
  await settleBlocked(n);        // deferred: withheld push, no Telegram configured
  triggers = [];                 // the operator unticks "blocked"
  n.reconsider("w1:p1");         // declines on the trigger check — must also clear #deferred
  await Bun.sleep(5);
  triggers = ["blocked"];        // re-ticked
  looking = false;               // and the viewer leaves
  n.reconsider("w1:p1");         // nothing should be left to release
  await Bun.sleep(5);
  expect(push).toEqual([]);
});
