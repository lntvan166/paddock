import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = () => readFile("public/sw.js", "utf8");

interface FakeNotification {
  tag: string;
  closed: boolean;
  close?: () => void;
}

interface FakeClient {
  url: string;
  focused: boolean;
  focus(): Promise<FakeClient>;
  navigate(u: string): Promise<FakeClient>;
}

/** Run the real sw.js against a faked worker global and return its handlers. */
async function load(clients: FakeClient[] = [], standing: FakeNotification[] = []) {
  const handlers = new Map<string, (e: unknown) => void>();
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  // Notifications already on the lock screen. `sw.js` closes the matching tag
  // before showing, because iOS does not honour tag replacement on its own —
  // measured 2026-08-27, when two pushes for one agent left two entries.
  const live = [...standing];
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers.set(t, fn); },
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, opts });
        live.push({ tag: String(opts.tag ?? ""), closed: false });
        return Promise.resolve();
      },
      getNotifications: (filter?: { tag?: string }) =>
        Promise.resolve(
          live
            .filter((n) => !n.closed && (filter?.tag === undefined || n.tag === filter.tag))
            .map((n) => ({ ...n, close: () => { n.closed = true; } })),
        ),
    },
    clients: {
      matchAll: () => Promise.resolve(clients),
      openWindow: (u: string) => { opened.push(u); return Promise.resolve(null); },
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
  };
  new Function("self", await source())(self);
  return { handlers, shown, opened, live };
}

/** Per-load, NOT module-level: a shared array accumulates across tests, and
 *  one test then awaits another's promises. */
function events() {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    evt: (extra: Record<string, unknown>) => ({
      waitUntil: (p: Promise<unknown>) => { waited.push(p); },
      ...extra,
    }),
  };
}

test("a push renders the agent and its state", async () => {
  const { handlers, shown } = await load();
  const { evt, waited } = events();
  handlers.get("push")!(evt({
    data: { json: () => ({ name: "api-refactor", state: "blocked", agentId: "a1b2c3" }) },
  }));
  await Promise.all(waited);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toContain("api-refactor");
  expect(shown[0]!.title).toContain("blocked");
});

// One notification per agent, not a pocketful. Matches the notifier's own
// transition-based dedup.
test("the notification is tagged by agent, so a second one replaces the first", async () => {
  const { handlers, shown } = await load();
  const { evt, waited } = events();
  handlers.get("push")!(evt({
    data: { json: () => ({ name: "api-refactor", state: "blocked", agentId: "a1b2c3" }) },
  }));
  await Promise.all(waited);
  expect(shown[0]!.opts.tag).toBe("a1b2c3");
  expect((shown[0]!.opts.data as { agentId: string }).agentId).toBe("a1b2c3");
  // A replacement must not buzz again. Telling the operator an agent has
  // STOPPED needing them is not worth a second alert.
  expect(shown[0]!.opts.renotify, "a replacement would re-alert").toBe(false);
});

test("a malformed payload still notifies rather than throwing", async () => {
  // A push that arrives and renders nothing is worse than one that renders a
  // vague line: the operator learns something happened.
  const { handlers, shown } = await load();
  const { evt, waited } = events();
  handlers.get("push")!(evt({ data: { json: () => { throw new Error("bad json"); } } }));
  await Promise.all(waited);
  expect(shown).toHaveLength(1);
});

test("a tap focuses an existing paddock window", async () => {
  const client: FakeClient = {
    url: "https://paddock.example.com/", focused: false,
    focus() { this.focused = true; return Promise.resolve(this); },
    navigate() { return Promise.resolve(this); },
  };
  const { handlers, opened } = await load([client]);
  const { evt, waited } = events();
  handlers.get("notificationclick")!(evt({
    notification: { data: { agentId: "a1b2c3" }, close: () => {} },
  }));
  await Promise.all(waited);
  expect(client.focused).toBe(true);
  expect(opened).toEqual([]);
});

test("a tap with no window open opens one at the agent's deep link", async () => {
  const { handlers, opened } = await load([]);
  const { evt, waited } = events();
  handlers.get("notificationclick")!(evt({
    notification: { data: { agentId: "a1b2c3" }, close: () => {} },
  }));
  await Promise.all(waited);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("a1b2c3");
});

// The guard that reads oddly and earns its place.
test("sw.js registers NO fetch handler, deliberately", async () => {
  // docs/gotchas.md: an expired Cloudflare Access session turns a
  // service-worker fetch into an HTML login page rather than an error. A worker
  // that never fetches cannot be fooled by it — and paddock has no offline
  // story, so a caching worker could only serve a stale app shell. Adding one
  // later must be a failing test, not a discovery in production.
  const { handlers } = await load();
  expect(handlers.has("fetch")).toBe(false);
  expect(await source()).not.toContain("caches");
});


/**
 * One entry per agent, enforced rather than requested.
 *
 * `tag` is SUPPOSED to make a second notification replace the first. Chrome
 * honours it. Measured on a real iPhone 2026-08-27 it does not: two pushes for
 * one agent left TWO entries, and both carried the same tag — the server log
 * proved it. So `sw.js` closes the matching tag itself before showing.
 *
 * This matters for ordinary alerts, not just an edge case: an agent that goes
 * blocked and later done would otherwise leave the blocked entry sitting
 * beside the done one, both claiming to describe the same agent.
 */

test("a second push for one agent leaves ONE entry, not two", async () => {
  const { handlers, shown, live } = await load([], [{ tag: "a1b2c3", closed: false }]);
  const { evt, waited } = events();
  handlers.get("push")!(evt({
    data: { json: () => ({ name: "api-refactor", state: "done", agentId: "a1b2c3" }) },
  }));
  await Promise.all(waited);

  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toContain("done");
  const open = live.filter((n) => !n.closed);
  expect(open, "the stale entry was left beside the new one").toHaveLength(1);
});

test("another agent's notification is left alone", async () => {
  // The close is filtered by tag. Closing everything would throw away alerts
  // this push knows nothing about — a blocked agent silently losing its entry
  // because a different one finished.
  const { handlers, live } = await load([], [
    { tag: "other", closed: false },
    { tag: "a1b2c3", closed: false },
  ]);
  const { evt, waited } = events();
  handlers.get("push")!(evt({
    data: { json: () => ({ name: "api-refactor", state: "done", agentId: "a1b2c3" }) },
  }));
  await Promise.all(waited);

  expect(live.find((n) => n.tag === "other")!.closed, "an unrelated agent's alert was closed")
    .toBe(false);
});

test("an unreadable payload still shows, and closes nothing", async () => {
  // sw.js falls back to an empty tag when it cannot read a payload. That
  // notification is the only trace of a real event, so it must still render —
  // and with no tag to match, it must not close anything either.
  const { handlers, shown, live } = await load([], [{ tag: "a1b2c3", closed: false }]);
  const { evt, waited } = events();
  handlers.get("push")!(evt({ data: { json: () => { throw new Error("bad json"); } } }));
  await Promise.all(waited);

  expect(shown).toHaveLength(1);
  expect(live.find((n) => n.tag === "a1b2c3")!.closed, "an untagged push closed a tagged entry")
    .toBe(false);
});

