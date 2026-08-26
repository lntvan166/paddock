import { expect, test } from "bun:test";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { SpaceTree } from "@shared/types";
import { agentIdFromHash, spaceHash, spaceIdFromHash } from "@shared/route";

const NOW = 1_700_000_000_000;

const TREE: SpaceTree = {
  readAt: NOW,
  spaces: [{
    spaceId: "w1", label: "api-refactor", tabCount: 1, paneCount: 1,
    tabs: [{ tabId: "w1:t1", label: null, panes: [
      { paneId: "w1:p1", harness: "claude", name: "api-refactor", title: "api-refactor", cwd: "/srv/project", state: "working" },
    ] }],
  }],
};

function harness(readTree?: () => Promise<SpaceTree>) {
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub({ now: () => NOW }),
    now: () => NOW,
    readTree,
    health: () => ({ ok: true, hostId: "dev-box", agents: 0, clients: 0, herdrConnected: true, lastEventAt: NOW, lastNotifyError: null, version: "0.0.0-dev", latestKnown: null, managedBy: null, herdrProtocol: null, schemaWarning: null }),
  });
}

test("GET /api/spaces returns the tree", async () => {
  const res = await harness(async () => TREE).request("/api/spaces");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(TREE);
});

test("without a herdr reader the route 404s honestly, like the action routes in demo mode", async () => {
  const res = await harness(undefined).request("/api/spaces");
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("herdr");
});

test("a herdr failure surfaces, and is never reported as an empty tree", async () => {
  const res = await harness(async () => { throw new Error("socket refused"); }).request("/api/spaces");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.detail).toContain("socket refused");
});

test("a space id round-trips through its hash", () => {
  // Space ids are herdr coordinates and contain no colon today, but they are
  // herdr's to change; encoding costs nothing and a raw one would break the
  // day it does.
  expect(spaceIdFromHash(spaceHash("w1"))).toBe("w1");
  expect(spaceIdFromHash(spaceHash("w1:odd/id"))).toBe("w1:odd/id");
});

test("the plural route is not the singular one", () => {
  // `#/spaces` is the LIST. If it parsed as a space id the list would render
  // a space screen for a space called "s".
  expect(spaceIdFromHash("#/spaces")).toBeNull();
  expect(spaceIdFromHash("#/space/")).toBeNull();
  expect(spaceIdFromHash("#/settings")).toBeNull();
  expect(spaceIdFromHash("")).toBeNull();
});

test("a malformed escape lands on no space rather than throwing", () => {
  // Same rule `agentIdFromHash` follows: a hand-edited or truncated URL must
  // not crash the render.
  expect(spaceIdFromHash("#/space/%")).toBeNull();
});

test("a pane hash is not a space hash, and neither reads the other", () => {
  expect(spaceIdFromHash("#/pane/w1:p1")).toBeNull();
  expect(agentIdFromHash(spaceHash("w1"))).toBeNull();
});
