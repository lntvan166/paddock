import { expect, test } from "bun:test";
import { fanOut, Notifier } from "@server/notify/notifier";
import { buildPushSender } from "@server/index-wiring";
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

// The regression this guards: wiring the notifier by REPLACING
// `onDelta: (d) => hub.queue(d)` rather than adding to it, which silently
// stops every browser updating while notifications appear to work. `fanOut`
// is the single function both `index.ts` and this test call, so a change that
// drops either destination from `fanOut` itself fails here.
test("a delta reaches BOTH the hub and the notifier", async () => {
  let queued = 0;
  const hubStub = { queue: (_d: Delta) => { queued++; } };
  const seen: string[] = [];
  const notifier = new Notifier({
    settings: {
      current: () => ({
        telegram: { token: "1:A", chatId: "5" },
        notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 },
                  mutedUntil: null, cooldownMs: 0 },
        publicUrl: null,
      }),
    } as never,
    send: async (t: string) => { seen.push(t); return { ok: true, detail: null }; },
  });

  const onDelta = fanOut(hubStub, notifier);
  onDelta({ upserted: [agent("working")], removedIds: [] });
  onDelta({ upserted: [agent("blocked")], removedIds: [] });
  await Bun.sleep(1);

  expect(queued).toBe(2);
  expect(seen).toHaveLength(1);
});

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
  await send!({ name: "api-refactor", state: "blocked", agentId: "a1" });
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
  await send!({ name: "api-refactor", state: "blocked", agentId: "a1" });
  expect(reached).toHaveLength(2);
});

test("with no keypair, the push sender is not wired at all", () => {
  // An unreadable push.json disables push. It must not produce a sender that
  // fails once per notification for ever.
  const store = { keys: () => null, list: () => [], remove: async () => {} };
  expect(buildPushSender(store as never, async () => ({ kind: "ok" }))).toBeNull();
});
