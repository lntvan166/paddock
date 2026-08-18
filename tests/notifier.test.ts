import { expect, test } from "bun:test";
import { Notifier, inQuietHours } from "@server/notify/notifier";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
  task: "Extract auth middleware", state: "working", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", stateSince: NOW,
  updatedAt: NOW, acknowledgedAt: null, ...over,
});

function harness() {
  const sent: string[] = [];
  let result = { ok: true, detail: null as string | null };
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
      publicUrl: "https://paddock.example.com",
    }),
  };
  let now = NOW;
  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return result; },
    now: () => now,
  });
  return { n, sent, setNow: (t: number) => { now = t; },
           fail: (d: string) => { result = { ok: false, detail: d }; } };
}

test("first sight after boot does not notify", async () => {
  // Otherwise restarting paddock pings once per currently-blocked agent —
  // a burst of notifications caused by nothing having happened.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toEqual([]);
});

test("a transition into a watched state notifies, with name, state and deep link", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("api-refactor");
  expect(h.sent[0]).toContain("blocked");
  expect(h.sent[0]).toContain("https://paddock.example.com/#/agent/w1%3Ap1");
});

test("staying in the same state does not notify again", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  h.n.observe({ upserted: [agent({ state: "blocked", task: "new output" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
});

test("a failed send does NOT consume the transition, so the next delta retries", async () => {
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);
  expect(h.n.lastError).toContain("chat not found");

  h.setNow(NOW + 120_000);   // past the cooldown
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(2);
});

test("a sustained failure does not send once per delta — cooldown arms on the attempt, not the success", async () => {
  // A broken token fails every send. Without the cooldown arming on the
  // ATTEMPT (not just success), the reverted `lastSeen` would keep
  // re-detecting the transition and each of these deltas — arriving as a
  // blocked agent's task line keeps updating — would fire its own POST.
  const h = harness();
  h.n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  h.fail("Bad Request: chat not found");
  h.n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(h.sent).toHaveLength(1);

  // Three more deltas for the same transition, all still inside the
  // 60_000ms cooldown window and all still failing.
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output A" })], removedIds: [] });
  await Bun.sleep(1);
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output B" })], removedIds: [] });
  await Bun.sleep(1);
  h.n.observe({ upserted: [agent({ state: "blocked", task: "output C" })], removedIds: [] });
  await Bun.sleep(1);

  expect(h.sent).toHaveLength(1);
});

test("quiet hours wrap past midnight — 22:00-08:00 is the ordinary case", () => {
  // Read naively as start <= t < end, the most common setting silences nothing.
  const qh = { start: "22:00", end: "08:00" };
  expect(inQuietHours(new Date("2026-08-18T23:30:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T03:00:00"), qh)).toBe(true);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), qh)).toBe(false);
  expect(inQuietHours(new Date("2026-08-18T12:00:00"), { start: "09:00", end: "17:00" })).toBe(true);
});

test("a trailing slash on publicUrl does not produce a double slash in the link", async () => {
  const sent: string[] = [];
  const store = {
    current: () => ({
      telegram: { token: "1:A", chatId: "555" },
      notify: { enabled: true, triggers: ["blocked"], quietHours: null, cooldownMs: 60_000 },
      publicUrl: "https://paddock.example.com/",
    }),
  };
  const n = new Notifier({
    settings: store as never,
    send: async (text: string) => { sent.push(text); return { ok: true, detail: null }; },
    now: () => NOW,
  });
  n.observe({ upserted: [agent({ state: "working" })], removedIds: [] });
  n.observe({ upserted: [agent({ state: "blocked" })], removedIds: [] });
  await Bun.sleep(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("https://paddock.example.com/#/agent/w1%3Ap1");
  expect(sent[0]).not.toContain("//#/agent");
});
