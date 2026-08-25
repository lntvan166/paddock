import { expect, test } from "bun:test";
import { applyMessage, backoffMs, isStale, useStore, type ClientState } from "@web/store";
import type { Agent, ServerMessage } from "@shared/types";
import { wsUrlFrom } from "@web/store";

const NOW = 1_700_000_000_000;
const EMPTY: ClientState = { agents: [], hostId: null, connected: false, lastMessageAt: null, build: null, updateAvailable: false, latestKnown: null, managedBy: null, treeStaleAt: 0 };

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: null, cwd: "/srv/project", stateSince: NOW, stateSinceExact: true, updatedAt: NOW,
    acknowledgedAt: null, hasJournal: false, harness: "claude", ...over,
  };
}

test("wsUrlFrom uses wss on https", () => {
  expect(wsUrlFrom({ protocol: "https:", host: "paddock.example.com" }))
    .toBe("wss://paddock.example.com/ws");
});

test("wsUrlFrom uses ws on http", () => {
  expect(wsUrlFrom({ protocol: "http:", host: "127.0.0.1:8787" }))
    .toBe("ws://127.0.0.1:8787/ws");
});

test("wsUrlFrom does NOT special-case localhost", () => {
  // A hostname allowlist is how a working dashboard silently becomes a demo screen.
  expect(wsUrlFrom({ protocol: "http:", host: "localhost:8787" }))
    .toBe("ws://localhost:8787/ws");
});

test("a snapshot replaces all state", () => {
  const next = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.hostId).toBe("dev-box");
  expect(next.lastMessageAt).toBe(NOW);
});

test("a snapshot is idempotent", () => {
  const msg: ServerMessage = { type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW };
  expect(applyMessage(applyMessage(EMPTY, msg), msg).agents).toHaveLength(1);
});

test("a new snapshot drops agents missing from it — replacement, not a merge with the prior snapshot", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box",
    agents: [agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW + 1,
  });
  // If this merged with the prior snapshot instead of replacing it, "w2:p1"
  // (removed server-side, e.g. between a disconnect and reconnect) would
  // linger on screen forever.
  expect(next.agents.map((a) => a.agentId)).toEqual(["w1:p1"]);
});

test("a delta upserts by agentId", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [agent({ state: "blocked" })], removedIds: [], serverTime: NOW + 1,
  });
  expect(next.agents).toHaveLength(1);
  expect(next.agents[0]!.state).toBe("blocked");
});

test("a delta removes by id", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box",
    agents: [agent(), agent({ agentId: "w2:p1", name: "docs-cleanup" })], serverTime: NOW,
  });
  const next = applyMessage(base, {
    type: "delta", upserted: [], removedIds: ["w2:p1"], serverTime: NOW + 1,
  });
  expect(next.agents.map((a) => a.agentId)).toEqual(["w1:p1"]);
});

test("a heartbeat counts as a received message without disturbing agent state", () => {
  const base = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [agent()], serverTime: NOW,
  });
  const next = applyMessage(base, { type: "heartbeat", serverTime: NOW + 20_000 });

  expect(next.lastMessageAt).toBe(NOW + 20_000);
  // Identity, not just deep equality: a heartbeat must not rebuild the list.
  expect(next.agents).toBe(base.agents);
  expect(next.hostId).toBe("dev-box");
});

test("heartbeats keep a quiet-but-live link out of the stale state", () => {
  // The end-to-end point of the heartbeat: at 20s intervals, a session where
  // no agent moves for hours never crosses the 60s threshold.
  let s: ClientState = { ...EMPTY, connected: true, lastMessageAt: NOW };
  expect(isStale(s, NOW + 61_000)).toBe(true); // without one, it would

  for (const tick of [20_000, 40_000, 60_000, 80_000]) {
    s = applyMessage(s, { type: "heartbeat", serverTime: NOW + tick });
    expect(isStale(s, NOW + tick + 1_000)).toBe(false);
  }
});

test("a disconnected socket is stale immediately, however fresh the last heartbeat", () => {
  const s = applyMessage({ ...EMPTY, connected: false }, { type: "heartbeat", serverTime: NOW });
  expect(isStale(s, NOW)).toBe(true);
});

test("backoff grows and stays within the cap", () => {
  const fixed = () => 0.5;
  expect(backoffMs(0, fixed)).toBeLessThan(backoffMs(3, fixed));
  for (let i = 0; i < 20; i++) expect(backoffMs(i, fixed)).toBeLessThanOrEqual(15_000);
});

test("backoff includes jitter so clients do not retry in lockstep", () => {
  expect(backoffMs(5, () => 0)).not.toBe(backoffMs(5, () => 0.99));
});

test("state is stale when disconnected", () => {
  expect(isStale({ ...EMPTY, connected: false, lastMessageAt: NOW }, NOW + 1)).toBe(true);
});

test("state is stale when no message has arrived within the threshold", () => {
  const s = { ...EMPTY, connected: true, lastMessageAt: NOW };
  expect(isStale(s, NOW + 61_000)).toBe(true);
  expect(isStale(s, NOW + 10_000)).toBe(false);
});

test("a heartbeat's latestKnown reaches state", () => {
  const next = applyMessage(EMPTY, { type: "heartbeat", serverTime: NOW, latestKnown: "9.9.9" });
  expect(next.latestKnown).toBe("9.9.9");
});

test("a snapshot's latestKnown reaches state too", () => {
  const next = applyMessage(EMPTY, {
    type: "snapshot", hostId: "dev-box", agents: [], serverTime: NOW, latestKnown: "9.9.9",
  });
  expect(next.latestKnown).toBe("9.9.9");
});

test("latestKnown does NOT latch — unlike updateAvailable, it clears once the operator updates", () => {
  let s = applyMessage(EMPTY, { type: "heartbeat", serverTime: NOW, latestKnown: "9.9.9" });
  expect(s.latestKnown).toBe("9.9.9");
  // The server's own check re-evaluates isNewer() against whatever binary is
  // now running; once it is current, latestKnown genuinely becomes null
  // again, and the dashboard must stop nagging about an update that already
  // happened.
  s = applyMessage(s, { type: "heartbeat", serverTime: NOW + 1, latestKnown: null });
  expect(s.latestKnown).toBeNull();
});

test("a message with no latestKnown field at all leaves the prior value alone", () => {
  // Distinguishes "the server says null" (a real, current answer) from "this
  // message does not carry the field" (e.g. a delta, which never does) —
  // only the latter must be a no-op.
  let s = applyMessage(EMPTY, { type: "heartbeat", serverTime: NOW, latestKnown: "9.9.9" });
  s = applyMessage(s, { type: "delta", upserted: [], removedIds: [], serverTime: NOW + 1 });
  expect(s.latestKnown).toBe("9.9.9");
});

test("connect() is not re-entrant: a second call opens no additional socket", () => {
  const realWebSocket = globalThis.WebSocket;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const realLocation = (globalThis as { location?: unknown }).location;
  let constructed = 0;

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    constructor(public url: string) {
      constructed++;
    }
  }

  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as { location: unknown }).location = { protocol: "http:", host: "example.test" };

  try {
    // Simulates a duplicate mount / a double-invoked React StrictMode effect:
    // two connect() calls with no close in between must not orphan the first
    // socket's handlers by silently overwriting the `ws` reference.
    useStore.getState().connect();
    useStore.getState().connect();
    expect(constructed).toBe(1);
  } finally {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
    if (hadLocation) {
      (globalThis as { location: unknown }).location = realLocation;
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  }
});

test("a heartbeat's managedBy reaches state", () => {
  const next = applyMessage(EMPTY, { type: "heartbeat", serverTime: NOW, managedBy: "homebrew" });
  expect(next.managedBy).toBe("homebrew");
});

test("a message with no managedBy field at all leaves the prior value alone", () => {
  // Mirrors latestKnown: `undefined` means "this frame does not say", which is
  // not the same as "not managed" -- and flipping the banner's command back and
  // forth between frames would be worse than either answer.
  let s = applyMessage(EMPTY, { type: "heartbeat", serverTime: NOW, managedBy: "homebrew" });
  s = applyMessage(s, { type: "heartbeat", serverTime: NOW + 1 });
  expect(s.managedBy).toBe("homebrew");
});
