import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = () => readFile("public/sw.js", "utf8");

interface FakeClient {
  url: string;
  focused: boolean;
  focus(): Promise<FakeClient>;
  navigate(u: string): Promise<FakeClient>;
}

/** Run the real sw.js against a faked worker global and return its handlers. */
async function load(clients: FakeClient[] = []) {
  const handlers = new Map<string, (e: unknown) => void>();
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers.set(t, fn); },
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(clients),
      openWindow: (u: string) => { opened.push(u); return Promise.resolve(null); },
      claim: () => Promise.resolve(),
    },
    skipWaiting: () => Promise.resolve(),
  };
  new Function("self", await source())(self);
  return { handlers, shown, opened };
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
