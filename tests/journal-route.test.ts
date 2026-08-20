import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { Agent } from "@shared/types";
import type { JournalPage } from "@server/journal/read";

const NOW = 1_700_000_000_000;
const health = () => ({
  ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true,
  lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null,
  herdrProtocol: null, schemaWarning: null,
});

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup",
    task: "Tidy the README", state: "working", workspaceId: "w1",
    workspaceLabel: "docs", cwd: "/srv/project", stateSince: NOW, updatedAt: NOW,
    acknowledgedAt: null, hasJournal: true, ...over,
  };
}

function harness(page: JournalPage = { lines: ["you · 13:04", "hi", ""], source: "journal", hasMore: true, cursor: "120", detail: null }) {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const calls: unknown[] = [];
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => ({ agent: "claude", kind: "id", source: "herdr:claude", value: "u1" }),
    journal: { async read(_s, before, limit) { calls.push({ before, limit }); return page; } },
  });
  return { app, calls };
}

const post = (app: ReturnType<typeof createApp>, body: object) =>
  app.request("/api/agents/w1:p1/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });

test("returns lines, provenance and a cursor", async () => {
  const { app } = harness();
  const res = await post(app, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.lines).toEqual(["you · 13:04", "hi", ""]);
  expect(body.source).toBe("journal");
  expect(body.hasMore).toBe(true);
  expect(body.cursor).toBe("120");
});

test("the cursor is passed through as a number", async () => {
  const { app, calls } = harness();
  await post(app, { before: "120", limit: 25 });
  expect(calls[0]).toEqual({ before: 120, limit: 25 });
});

test("a non-numeric cursor is refused rather than coerced", async () => {
  // The cursor is opaque to the client and MUST be one this server issued.
  // Coercing garbage to 0 would silently serve the top of the file instead.
  const { app } = harness();
  expect((await post(app, { before: "../etc" })).status).toBe(400);
});

test("an unknown agent is 404, not an empty page", async () => {
  const { app } = harness();
  const res = await app.request("/api/agents/nope/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: "{}",
  });
  expect(res.status).toBe(404);
});

test("no journal reports reconstruction with a reason, and 200", async () => {
  // The UI falls back quietly, so this is a normal answer rather than an error
  // — but the reason still travels, because nothing may be swallowed.
  const { app } = harness({
    lines: [], source: "reconstruction", hasMore: false, cursor: null,
    detail: "no journal adapter for this harness",
  });
  const res = await post(app, {});
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.source).toBe("reconstruction");
  expect(body.lines).toEqual([]);
  expect(body.detail).toContain("no journal");
});

test("the route exists with no actions dep — it never touches herdr", async () => {
  // Registered unconditionally, unlike the action routes. Gating a
  // filesystem read on a herdr dependency is the /ack mistake: the one
  // feature that works without herdr being the one broken in --demo.
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => null,
    journal: { async read() { return { lines: [], source: "reconstruction" as const, hasMore: false, cursor: null, detail: "no session" }; } },
  });
  expect((await post(app, {})).status).toBe(200);
});

test("the same-origin gate covers it like any other POST", async () => {
  const { app } = harness();
  const res = await app.request("/api/agents/w1:p1/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: "{}",
  });
  expect(res.status).toBe(403);
});

/** Runs `body` with `console.error` captured — the sink `warn` writes to. */
async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.error = real;
  }
  return lines;
}

test("a detail never carries a filesystem path to the browser", async () => {
  // `routes.ts` returns `{ ok: true, ...page }` verbatim, so whatever the
  // reader puts in `detail` reaches the phone. Decision 5 keeps filesystem
  // keys off the wire, and a path inside an error message is the same key by
  // another route.
  const { app } = harness({
    lines: [], source: "reconstruction", hasMore: false, cursor: null,
    detail: "could not read the session log",
  });
  const body = await (await post(app, {})).json() as { detail: string };
  expect(body.detail).not.toMatch(/\/home\/|\/Users\/|ENOENT|EACCES|\.jsonl/);
});

test("a miss is reported once per agent, and again after the journal recovers", async () => {
  // The de-duplicating set used to be write-only: an agent whose journal came
  // back could never be reported again if it later broke a second time, and
  // "history silently stopped going deeper" is invisible without that line.
  let page: JournalPage = {
    lines: [], source: "reconstruction", hasMore: false, cursor: null,
    detail: "session log not found — compacted, rotated or removed",
  };
  const store = new AgentStore("dev-box");
  store.replaceAll([agent({ agentId: "w9:p9" })], NOW);
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => ({ agent: "claude", kind: "id", source: "herdr:claude", value: "u1" }),
    journal: { async read() { return page; } },
  });
  const ask = () => app.request("/api/agents/w9:p9/history", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: "{}",
  });

  const first = await captureWarnings(async () => { await ask(); await ask(); await ask(); });
  expect(first.filter((l) => l.includes("no journal history"))).toHaveLength(1);

  // The journal reads again...
  page = { lines: ["you", "hi", ""], source: "journal", hasMore: false, cursor: null, detail: null };
  await captureWarnings(async () => { await ask(); });

  // ...so the NEXT failure is heard rather than suppressed by a stale entry.
  page = {
    lines: [], source: "reconstruction", hasMore: false, cursor: null,
    detail: "session log not found — compacted, rotated or removed",
  };
  const second = await captureWarnings(async () => { await ask(); });
  expect(second.filter((l) => l.includes("no journal history"))).toHaveLength(1);
});

test("the miss set cannot grow without bound", async () => {
  // Agent ids do not repeat across harness restarts, so a set that only ever
  // grew held one string per agent id ever seen, forever. Reporting has to
  // still work at the far end of that: the 400th distinct agent is warned
  // about exactly like the first.
  const store = new AgentStore("dev-box");
  const many = Array.from({ length: 400 }, (_, i) => agent({ agentId: `wb:p${i}` }));
  store.replaceAll(many, NOW);
  const app = createApp({
    store, now: () => NOW, health, hub: new Hub({ now: () => NOW }),
    sessionFor: () => ({ agent: "claude", kind: "id", source: "herdr:claude", value: "u1" }),
    journal: {
      async read() {
        return {
          lines: [], source: "reconstruction" as const, hasMore: false, cursor: null,
          detail: "no journal adapter for this harness",
        };
      },
    },
  });
  const lines = await captureWarnings(async () => {
    for (const a of many) {
      await app.request(`/api/agents/${a.agentId}/history`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: "{}",
      });
    }
  });
  expect(lines.filter((l) => l.includes("no journal history"))).toHaveLength(400);
  // And the early entries have been evicted, so re-asking about the FIRST
  // agent warns again rather than being silenced by a set that never forgets.
  const again = await captureWarnings(async () => {
    await app.request("/api/agents/wb:p0/history", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: "{}",
    });
  });
  expect(again.filter((l) => l.includes("no journal history"))).toHaveLength(1);
});
