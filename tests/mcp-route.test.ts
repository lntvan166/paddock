import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrActions } from "@server/herdr/actions";
import { AgentWatch } from "@server/mcp/watch";
import { createApp, type AppDeps } from "@server/routes";
import { SettingsStore } from "@server/settings/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const NOW = 1_700_000_000_000;

async function deps(enabled: boolean, over: Partial<AppDeps> = {}): Promise<AppDeps> {
  const store = new AgentStore("dev-box");
  store.replaceAll([{
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor", task: "Extract auth middleware", state: "idle",
    workspaceId: "w1", workspaceLabel: null, cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW, acknowledgedAt: null, hasJournal: false, origin: "herdr", turn: null, seen: null,
  }], NOW, "herdr");
  const settings = new SettingsStore(await mkdtemp(join(tmpdir(), "paddock-mcp-route-")), {});
  await settings.load();
  if (enabled) await settings.patch({ bridge: { enabled: true } });
  const actions = { async sendReply() {}, async readOutput() { return { lines: [], source: "visible" } } } as unknown as HerdrActions;
  return {
    store, hub: new Hub({ now: () => NOW }), settings, actions, watch: new AgentWatch(), now: () => NOW,
    health: () => ({ ok: true, hostId: "dev-box", agents: 1, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
    ...over,
  };
}

const rpc = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

const fakePairing = {
  attempt: () => ({ kind: "burned" as const }),
  reissue: () => ({ code: "0000", expiresAt: 0 }),
  current: () => ({ code: "0000", expiresAt: 0 }),
  pairedCount: 0,
};

test("404 while the bridge is off", async () => {
  const res = await rpc(createApp(await deps(false)), init);
  expect(res.status).toBe(404);
});

test("initialize, then tools/list lists the five tools", async () => {
  const app = createApp(await deps(true));
  const a = await rpc(app, init);
  expect(a.status).toBe(200);
  expect((await a.json()).result.serverInfo.name).toBe("paddock");
  const b = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((await b.json()).result.tools.map((t: { name: string }) => t.name))
    .toEqual(["list_agents", "read_agent", "send_message", "wait_for_agent", "answer_question"]);
});

test("a notification is 202 with no body", async () => {
  const res = await rpc(createApp(await deps(true)), { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(res.status).toBe(202);
  expect(await res.text()).toBe("");
});

test("an unparseable body is a JSON-RPC parse error", async () => {
  const res = await rpc(createApp(await deps(true)), "{not json");
  expect(res.status).toBe(200);
  expect((await res.json()).error.code).toBe(-32700);
});

test("GET is 405: there is no stream to open", async () => {
  const res = await createApp(await deps(true)).request("/mcp");
  expect(res.status).toBe(405);
});

test("never registered on the gated quick-tunnel app", async () => {
  const res = await rpc(createApp(await deps(true, { pairing: fakePairing })), init);
  expect(res.status).toBe(404);
});

test("not registered without herdr actions", async () => {
  const res = await rpc(createApp(await deps(true, { actions: undefined })), init);
  expect(res.status).toBe(404);
});

test("a request with no Origin passes the same-origin guard", async () => {
  const res = await rpc(createApp(await deps(true)), init);
  expect(res.status).toBe(200);
});

test("a foreign Origin is still refused by the guard", async () => {
  const res = await rpc(createApp(await deps(true)), init, { origin: "https://evil.example.com" });
  expect(res.status).toBe(403);
});

test("turning the bridge on takes effect without a new app", async () => {
  const d = await deps(false);
  const app = createApp(d);
  expect((await rpc(app, init)).status).toBe(404);
  await d.settings!.patch({ bridge: { enabled: true } });
  expect((await rpc(app, init)).status).toBe(200);
});

test("a tool call over HTTP reaches the store", async () => {
  const res = await rpc(createApp(await deps(true)), {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_agents", arguments: {} },
  });
  const text = (await res.json()).result.content[0].text;
  expect(JSON.parse(text)[0].name).toBe("api-refactor");
});
