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
