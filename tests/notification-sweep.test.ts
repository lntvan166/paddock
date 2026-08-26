import { afterEach, expect, test } from "bun:test";
import { closeFor, sweep } from "@web/notifications";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;

const agent = (over: Partial<Agent> = {}): Agent => ({
  hostId: "dev-box", agentId: "w1:p1", name: "schema-migration",
  task: "Add the index", state: "blocked", workspaceId: "w1",
  workspaceLabel: null, cwd: "/srv/project", harness: "claude",
  stateSince: NOW, stateSinceExact: true,
  updatedAt: NOW, acknowledgedAt: null, hasJournal: false, ...over,
});

/** One notification, and whether the sweep closed it. */
function note(tag: string) {
  return { tag, closed: false, close() { this.closed = true; } };
}

/**
 * Fake `navigator.serviceWorker`, installed the way `push-section.test.tsx`
 * does it: on the existing navigator, saved and restored, because Bun ships a
 * navigator without a service worker.
 *
 * `notes === null` models a registration with no `getNotifications` at all —
 * a browser where the API does not exist.
 */
function fakeSw(notes: ReturnType<typeof note>[] | null) {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  const registration = notes === null ? {} : {
    getNotifications: async (o?: { tag?: string }) =>
      notes.filter((n) => o?.tag === undefined || n.tag === o.tag),
  };
  Object.defineProperty(nav, "serviceWorker", {
    value: { getRegistration: async () => registration },
    configurable: true, writable: true,
  });
  return () => {
    if (had) Object.defineProperty(nav, "serviceWorker", had);
    else delete nav.serviceWorker;
  };
}

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

test("a notification for an agent that is working again is closed", async () => {
  // The complaint this fixes: answer the agent from the herdr terminal on the
  // laptop and the phone's lock screen still says it is waiting.
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "working" })]);
  expect(notes[0]!.closed).toBe(true);
});

test("a notification for an agent still blocked is left alone", async () => {
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "blocked" })]);
  expect(notes[0]!.closed).toBe(false);
});

test("a notification for a done agent is left alone", async () => {
  // `done` is a trigger too, and a finished agent you have not looked at is
  // still news.
  const notes = [note("w1:p1")];
  restore = fakeSw(notes);
  await sweep([agent({ state: "done" })]);
  expect(notes[0]!.closed).toBe(false);
});

test("a notification for an agent that no longer exists is closed", async () => {
  const notes = [note("w9:p9")];
  restore = fakeSw(notes);
  await sweep([agent()]);
  expect(notes[0]!.closed).toBe(true);
});

test("an untagged notification is never swept", async () => {
  // `sw.js` falls back to "paddock: an agent needs you" with an empty tag when
  // a payload arrives it cannot read. The sweep cannot tell what that one is
  // about, so closing it would discard the only trace of a real event.
  const notes = [note("")];
  restore = fakeSw(notes);
  await sweep([]);
  expect(notes[0]!.closed).toBe(false);
});

test("closeFor closes only that agent's notification", async () => {
  const notes = [note("w1:p1"), note("w2:p1")];
  restore = fakeSw(notes);
  await closeFor("w1:p1");
  expect(notes.map((n) => n.closed)).toEqual([true, false]);
});

test("a browser without getNotifications is not an error", async () => {
  // Capability detection, not a swallowed failure: the API genuinely does not
  // exist everywhere paddock is opened, and there is nothing to report.
  restore = fakeSw(null);
  await sweep([agent()]);
  await closeFor("w1:p1");
});

test("a browser without a service worker at all is not an error", async () => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  delete nav.serviceWorker;
  restore = () => { if (had) Object.defineProperty(nav, "serviceWorker", had); };
  await sweep([agent()]);
});
