import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { SavedImage } from "@server/uploads/store";
import type { Agent } from "@shared/types";

const NOW = 1_700_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "docs-cleanup",
    task: "Tidy the README", state: "blocked", workspaceId: "w1",
    workspaceLabel: "docs", cwd: "/srv/project", harness: "claude",
    stateSince: NOW, stateSinceExact: true, updatedAt: NOW,
    acknowledgedAt: null, hasJournal: false, ...over,
  };
}

function harness(save?: (bytes: Uint8Array) => Promise<SavedImage | { refused: string }>) {
  const store = new AgentStore("dev-box");
  store.replaceAll([agent()], NOW);
  const seen: number[] = [];
  const app = createApp({
    store,
    hub: new Hub(),
    health: () => ({}) as never,
    saveImage: save
      ? async (b) => { seen.push(b.byteLength); return save(b); }
      : undefined,
  });
  return { app, seen };
}

const stored: SavedImage = {
  path: "/srv/config/uploads/2026-08-27-a3f9c1e8.png",
  name: "2026-08-27-a3f9c1e8.png",
  type: "png",
};

const post = (app: ReturnType<typeof harness>["app"], body: BodyInit, headers: Record<string, string> = {}) =>
  app.request("/api/agents/w1:p1/image", { method: "POST", body, headers });

test("an image is stored, and its path is what comes back", async () => {
  // The path is what the client puts in front of the operator's words at send
  // time, so the route has to return it rather than only a name.
  const { app, seen } = harness(async () => stored);

  const res = await post(app, PNG);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, path: stored.path, name: stored.name });
  expect(seen, "the bytes reached the writer intact").toEqual([PNG.byteLength]);
});

test("a refusal is a 400 carrying the reason, not a bare failure", async () => {
  const { app } = harness(async () => ({ refused: "that is not a PNG, JPEG, GIF or WebP" }));

  const res = await post(app, new Uint8Array([1, 2, 3]));

  expect(res.status).toBe(400);
  expect((await res.json()).detail).toContain("not a PNG");
});

test("an unknown agent is a 404, and nothing is written", async () => {
  const { app, seen } = harness(async () => stored);

  const res = await app.request("/api/agents/nope/image", { method: "POST", body: PNG });

  expect(res.status).toBe(404);
  expect(seen).toEqual([]);
});

test("with no writer configured the route refuses honestly", async () => {
  // `--demo` omits it. A demo that appeared to accept an upload and silently
  // dropped it would be the mislabelled control this project bans.
  const { app } = harness(undefined);

  const res = await post(app, PNG);

  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("not configured");
});

test("an oversized upload is refused before the body is read", async () => {
  // The guard has to be on the DECLARED length, not on the buffer: reading a
  // 500 MB body to discover it is too big is the denial of service.
  const { app, seen } = harness(async () => stored);

  const res = await post(app, PNG, { "content-length": String(50 * 1024 * 1024) });

  expect(res.status).toBe(413);
  expect(seen, "the writer never saw it").toEqual([]);
});

test("an empty body is refused", async () => {
  const { app } = harness(async () => ({ refused: "that file is empty" }));

  const res = await post(app, new Uint8Array([]));

  expect(res.status).toBe(400);
});
