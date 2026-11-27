import { expect, test } from "bun:test";
import { corePaneOf } from "@server/herdr-core/tree";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import type { CoreTerminal } from "@shared/herdr-core-api";

/*
 * A pane route checks ONE id against that id's backend, not the whole tree.
 * Measured on a Mac whose Herdr app had added another machine: the whole
 * tree took 3–6 s, paid on every read of an open terminal.
 */

const term = (over: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address: "t7", argv: ["zsh"], cols: 80, rows: 24, created_ms: 1, cwd: "/srv/project",
  labels: { "herdr.space": "spA", "herdr.tab": "tbA" }, screen: "exact", state: "live", ...over,
});

test("one terminal becomes the pane the Spaces screen would show, or nothing", () => {
  expect(corePaneOf(term(), undefined)).toMatchObject({ paneId: "hc.t7", harness: null });
  expect(corePaneOf(term({ state: "finished" }), undefined)).toBeNull();
  expect(corePaneOf(term({ labels: {} }), undefined)).toBeNull();
});

test("with a pane lookup, a pane read never reads the whole tree", async () => {
  let trees = 0;
  const looked: string[] = [];
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    readTree: async () => { trees++; return { readAt: 0, spaces: [] }; },
    lookupPane: async (id) => { looked.push(id); return { paneId: id, harness: null } as never; },
    actions: { async readPane() { return { lines: ["$ ls"], source: "recent_unwrapped" as const }; } } as never,
  });
  const res = await app.request(`/api/panes/${encodeURIComponent("hc.t7")}/output`, { method: "POST" });
  expect(await res.json()).toEqual({ lines: ["$ ls"], source: "recent_unwrapped" });
  expect(looked).toEqual(["hc.t7"]);
  expect(trees).toBe(0);
});

test("a pane its backend does not know is an unknown pane", async () => {
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    readTree: async () => ({ readAt: 0, spaces: [] }),
    lookupPane: async () => undefined,
    actions: { async readPane() { throw new Error("must not read"); } } as never,
  });
  const res = await app.request(`/api/panes/${encodeURIComponent("hc.t9")}/output`, { method: "POST" });
  expect(res.status).toBe(404);
});

test("a tab or space route reads only its own backend's tree", async () => {
  let whole = 0;
  const asked: string[] = [];
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    readTree: async () => { whole++; return { readAt: 0, spaces: [] }; },
    readTreeFor: async (id) => {
      asked.push(id);
      return { readAt: 0, spaces: [{ spaceId: "hc.spA", label: "api", origin: "core", tabCount: 1, paneCount: 0, tabs: [{ tabId: "hc.tbA", label: null, panes: [] }] }] };
    },
    actions: { async renameTab() {} } as never,
  });
  const res = await app.request(`/api/tabs/${encodeURIComponent("hc.tbA")}/name`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "logs" }),
  });
  expect(res.status).toBe(200);
  expect(asked).toEqual(["hc.tbA"]);
  expect(whole).toBe(0);
});
