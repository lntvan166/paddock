import { expect, test } from "bun:test";
import { applyMessage, type ClientState } from "@web/store";

const base = (): ClientState => ({
  agents: [], hostId: null, connected: true, lastMessageAt: null,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null,
  treeStaleAt: 0,
});

const beat = (build: string | null) =>
  ({ type: "heartbeat", serverTime: 1, build }) as const;

test("the first build id seen is adopted, not treated as an update", () => {
  // Otherwise every tab announces an update the moment it connects.
  const s = applyMessage(base(), beat("index-AAA.js"));
  expect(s.build).toBe("index-AAA.js");
  expect(s.updateAvailable).toBe(false);
});

test("a changed build id raises the update flag", () => {
  let s = applyMessage(base(), beat("index-AAA.js"));
  s = applyMessage(s, beat("index-BBB.js"));
  expect(s.updateAvailable).toBe(true);
});

test("the same build id repeated does not raise it", () => {
  let s = applyMessage(base(), beat("index-AAA.js"));
  for (let i = 0; i < 5; i++) s = applyMessage(s, beat("index-AAA.js"));
  expect(s.updateAvailable).toBe(false);
});

test("a null build id never raises it, however often it arrives", () => {
  // Dev mode serves unhashed assets and reports null. Treating that as a
  // change would show a permanent, un-dismissable reload prompt.
  let s = base();
  for (let i = 0; i < 5; i++) s = applyMessage(s, beat(null));
  expect(s.updateAvailable).toBe(false);
  expect(s.build).toBeNull();
});

test("a null after a real id does not raise it either", () => {
  // A server restarted without a built UI must not look like a new release.
  let s = applyMessage(base(), beat("index-AAA.js"));
  s = applyMessage(s, beat(null));
  expect(s.updateAvailable).toBe(false);
  expect(s.build).toBe("index-AAA.js");
});

test("once raised, the flag stays raised", () => {
  // The tab is running stale code until it reloads. A flag that cleared itself
  // would hide that fact again while the staleness persisted.
  let s = applyMessage(base(), beat("index-AAA.js"));
  s = applyMessage(s, beat("index-BBB.js"));
  s = applyMessage(s, beat("index-BBB.js"));
  expect(s.updateAvailable).toBe(true);
});

test("a snapshot carries the build id too, so a reconnect notices", () => {
  // A rebuild usually restarts the server, so the client reconnects and gets
  // a snapshot before any heartbeat is due.
  let s = applyMessage(base(), beat("index-AAA.js"));
  s = applyMessage(s, {
    type: "snapshot", hostId: "dev-box", agents: [], serverTime: 2, build: "index-BBB.js",
  });
  expect(s.updateAvailable).toBe(true);
});
