import { expect, test } from "bun:test";
import { PresenceStore } from "@server/state/presence";

const NOW = 1_700_000_000_000;

test("two connections on one device union rather than overwrite", () => {
  const p = new PresenceStore({ now: () => NOW });
  const pwa = {};
  const tab = {};
  p.set(pwa, { deviceKey: "dk-phone", agentId: "w1:p1" });
  // The same phone's Safari tab, sitting on the agent list. Keyed by device
  // key this would erase the PWA's view and suppression would flicker on
  // whichever surface spoke last.
  p.set(tab, { deviceKey: "dk-phone", agentId: null });
  expect([...p.viewers("w1:p1")]).toEqual(["dk-phone"]);
});

test("a viewer of one agent is not a viewer of another", () => {
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  expect(p.viewers("w2:p1").size).toBe(0);
});

test("a client with no push subscription is recorded and views nothing", () => {
  // deviceKey null is a browser that never subscribed. It must not match a
  // target, and must not throw on the way to not matching one.
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: null, agentId: "w1:p1" });
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("an entry older than the TTL is not a viewer", () => {
  // iOS suspends a backgrounded PWA without delivering visibilitychange, so
  // the socket can linger. Three missed heartbeats and it stops counting.
  let now = NOW;
  const p = new PresenceStore({ now: () => now, staleMs: 60_000 });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  now = NOW + 60_001;
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("the sweep drops an expired entry and announces its agent", () => {
  let now = NOW;
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => now, staleMs: 60_000 });
  p.onChange((agentId) => seen.push(agentId));
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  now = NOW + 60_001;
  p.sweep();
  expect(seen).toEqual(["w1:p1"]);
  // Dropped, not merely ignored: the map must not grow for every socket that
  // ever connected.
  p.sweep();
  expect(seen).toEqual(["w1:p1"]);
});

test("dropping a client announces the agent it was viewing", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.drop(c);
  expect(seen).toEqual(["w1:p1"]);
  expect(p.viewers("w1:p1").size).toBe(0);
});

test("moving to another agent announces the one left behind", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.set(c, { deviceKey: "dk-phone", agentId: "w2:p1" });
  expect(seen).toEqual(["w1:p1"]);
});

test("dropping a client that was viewing nothing announces nothing", () => {
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: null });
  p.drop(c);
  expect(seen).toEqual([]);
});

test("a throwing listener does not stop the others, and does not escape", () => {
  // A presence change runs on the socket's close path. An exception there
  // would take down a connection teardown to deliver a notification hint.
  const seen: string[] = [];
  const p = new PresenceStore({ now: () => NOW });
  p.onChange(() => { throw new Error("listener exploded"); });
  p.onChange((agentId) => seen.push(agentId));
  const c = {};
  p.set(c, { deviceKey: "dk-phone", agentId: "w1:p1" });
  expect(() => p.drop(c)).not.toThrow();
  expect(seen).toEqual(["w1:p1"]);
});

test("dispose clears the entries and the listeners", () => {
  const p = new PresenceStore({ now: () => NOW });
  p.set({}, { deviceKey: "dk-phone", agentId: "w1:p1" });
  p.dispose();
  expect(p.viewers("w1:p1").size).toBe(0);
});
