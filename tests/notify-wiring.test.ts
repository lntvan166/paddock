import { expect, test } from "bun:test";
import { buildPushSender, deltaSink } from "@server/index-wiring";
import type { Delta } from "@server/state/store";
import type { Agent } from "@shared/types";

const agent = (state: Agent["state"]): Agent => ({
  hostId: "dev-box",
  agentId: "w1:p1",
  name: "docs-cleanup",
  task: "Rewrite the quickstart",
  state,
  workspaceId: "w1",
  workspaceLabel: null,
  cwd: "/path/to/project",
  harness: "claude",
  stateSince: 0, stateSinceExact: true,
  updatedAt: 0,
  acknowledgedAt: null,
  hasJournal: false,
});
// The hub/notifier split is covered by `deltaSink` at the foot of this file.
// `fanOut` used to live in `notifier.ts` and be tested here; it was retired
// rather than kept beside `deltaSink`, because two functions doing one job is
// the divergence this project keeps warning about — one would learn the demo
// bypass and the other would not.

const FAKE_KEYS = { publicKey: "BP4z", privateKey: { kty: "EC", crv: "P-256", d: "x" } };
const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

test("the push sender is wired to the store's subscriptions and prunes the gone ones", async () => {
  // A 410 means the subscription no longer exists, and the ONLY outcome that
  // removes one. Wiring that does not prune leaves a dead endpoint retried for
  // ever; wiring that prunes too eagerly unsubscribes live phones.
  const removed: string[] = [];
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [
      { endpoint: "https://push.example.com/live", p256dh: P256DH, auth: AUTH },
      { endpoint: "https://push.example.com/dead", p256dh: P256DH, auth: AUTH },
    ],
    remove: async (e: string) => { removed.push(e); },
  };
  const bodies: string[] = [];
  const send = buildPushSender(store as never, async (target, _keys, payload) => {
    bodies.push(payload);
    return target.endpoint.endsWith("/dead") ? { kind: "gone" } : { kind: "ok" };
  });
  await send!({ name: "api-refactor", state: "blocked", agentId: "a1", skipDeviceKeys: new Set() });
  expect(removed).toEqual(["https://push.example.com/dead"]);
  // Every device gets the payload, and it is the payload the notifier composed.
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[0]!)).toEqual({ name: "api-refactor", state: "blocked", agentId: "a1" });
});

test("a failing device does not stop the ones after it", async () => {
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [
      { endpoint: "https://push.example.com/broken", p256dh: P256DH, auth: AUTH },
      { endpoint: "https://push.example.com/fine", p256dh: P256DH, auth: AUTH },
    ],
    remove: async () => {},
  };
  const reached: string[] = [];
  const send = buildPushSender(store as never, async (target) => {
    reached.push(target.endpoint);
    return target.endpoint.endsWith("/broken")
      ? { kind: "failed", detail: "HTTP 500" }
      : { kind: "ok" };
  });
  await send!({ name: "api-refactor", state: "blocked", agentId: "a1", skipDeviceKeys: new Set() });
  expect(reached).toHaveLength(2);
});

test("with no keypair, the push sender is not wired at all", () => {
  // An unreadable push.json disables push. It must not produce a sender that
  // fails once per notification for ever.
  const store = { keys: () => null, list: () => [], remove: async () => {} };
  expect(buildPushSender(store as never, async () => ({ kind: "ok" }))).toBeNull();
});

test("the push sender skips the devices named in skipDeviceKeys", async () => {
  const PHONE_ENDPOINT = "https://push.example.com/phone";
  const TABLET_ENDPOINT = "https://push.example.com/tablet";
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [
      { endpoint: PHONE_ENDPOINT, p256dh: P256DH, auth: AUTH, deviceKey: "dk-phone" },
      { endpoint: TABLET_ENDPOINT, p256dh: P256DH, auth: AUTH, deviceKey: "dk-tablet" },
    ],
    remove: async () => {},
  };
  const sent: string[] = [];
  const send = buildPushSender(store as never, async (target) => {
    sent.push(target.endpoint);
    return { kind: "ok" };
  });
  await send!({
    name: "docs-cleanup", state: "blocked", agentId: "w1:p1",
    skipDeviceKeys: new Set(["dk-phone"]),
  });
  expect(sent).toEqual([TABLET_ENDPOINT]);
});

test("the skip set never reaches the payload", async () => {
  // A push payload is `{name, state, agentId}` and nothing else — it renders
  // on a lock screen, and `skipDeviceKeys` is an argument, not content.
  const store = {
    keys: () => FAKE_KEYS,
    list: () => [{ endpoint: "https://push.example.com/x", p256dh: P256DH, auth: AUTH, deviceKey: "dk-x" }],
    remove: async () => {},
  };
  const bodies: string[] = [];
  const send = buildPushSender(store as never, async (_t, _k, payload) => {
    bodies.push(payload);
    return { kind: "ok" };
  });
  await send!({
    name: "docs-cleanup", state: "blocked", agentId: "w1:p1", skipDeviceKeys: new Set(["dk-other"]),
  });
  expect(JSON.parse(bodies[0]!)).toEqual({ name: "docs-cleanup", state: "blocked", agentId: "w1:p1" });
});

// ---- the CALL SITE, not just the function it calls ------------------------
//
// `deltaSink`'s body being right was never the gap. The gap was `index.ts`
// CHOOSING it. The wiring read
//
//     onDelta: fanOut(hub, notifier)          // herdr
//     onDelta: (d) => hub.queue(d)            // --demo
//
// two differently-shaped lines, and an edit making the first look like the
// second would pass the whole suite: the browser fan-out keeps working, nothing
// user-visible breaks, and the notifier never sees another delta — so paddock
// stops telling anyone their agent is blocked, which is why it exists.
//
// Not hypothetical. The same shape — a decision living in `index.ts`, the one
// file with no test harness — silently disabled the stale-tab bar on every
// installed paddock for months while the tests around it stayed green.
//
// A guard cannot forbid the hub-only shape, because `--demo` wants it: a demo
// must not fire real Telegram messages about synthetic agents. So both modes
// call one function, and these tests pin the distinction rather than syntax.

test("with a notifier, a delta reaches both destinations", () => {
  const queued: Delta[] = [];
  const observed: Delta[] = [];
  const d: Delta = { upserted: [agent("blocked")], removedIds: [] };

  deltaSink({ queue: (x) => queued.push(x) }, { observe: (x) => observed.push(x) })(d);

  expect(queued).toEqual([d]);
  expect(observed).toEqual([d]);
});

test("without one — the demo — the hub still gets everything", () => {
  const queued: Delta[] = [];
  const d: Delta = { upserted: [agent("done")], removedIds: [] };

  deltaSink({ queue: (x) => queued.push(x) }, null)(d);

  expect(queued, "a demo must still update the browser").toEqual([d]);
});

test("omitting the notifier argument does not compile", () => {
  // The bypass has to be stated. An optional parameter would put the decision
  // back where a reader cannot see it.
  const d: Delta = { upserted: [], removedIds: [] };
  // @ts-expect-error the second argument is required
  deltaSink({ queue: () => {} })(d);
});

test("the hub is served first, so a notifier cannot delay a screen", () => {
  const order: string[] = [];
  deltaSink(
    { queue: () => order.push("hub") },
    { observe: () => order.push("notifier") },
  )({ upserted: [], removedIds: [] });

  expect(order).toEqual(["hub", "notifier"]);
});
