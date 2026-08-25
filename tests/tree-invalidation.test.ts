import { expect, test } from "bun:test";
import { Supervisor } from "@server/supervisor";
import { AgentStore } from "@server/state/store";

const NOW = 1_700_000_000_000;

function harness() {
  const stale: string[] = [];
  const subs: unknown[] = [];
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "agent.list") return { agents: [] } as T;
      if (method === "workspace.list") return { workspaces: [] } as T;
      return {} as T;
    },
    async openStream(s: unknown[]) { subs.push(...s); },
  };
  const sup = new Supervisor({
    client, store: new AgentStore("dev-box"), now: () => NOW,
    onDelta: () => {}, onTreeStale: () => stale.push("stale"),
  });
  return { sup, stale, subs, client };
}

test("a renamed tab invalidates the tree", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "tab_renamed", data: {} });
  expect(stale).toEqual(["stale"]);
});

test("a rollup-only event does NOT invalidate, or every agent state change would refetch", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "workspace_updated", data: {} });
  sup.handleEvent({ event: "workspace_metadata_updated", data: {} });
  expect(stale).toEqual([]);
});

test("a shell becoming an agent invalidates, reusing a subscription paddock already has", async () => {
  const { sup, stale } = harness();
  await sup.start();
  stale.length = 0;
  sup.handleEvent({ event: "pane_agent_detected", data: {} });
  expect(stale).toEqual(["stale"]);
});
