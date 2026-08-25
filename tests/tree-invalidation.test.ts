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

/**
 * herdr must actually be ASKED for the structural events, in herdr's own
 * subscribe spelling.
 *
 * `handleEvent` matches on delivered event names and has no idea whether the
 * stream was ever subscribed to them, so the three tests above passed with
 * `...STRUCTURAL_SUBSCRIPTIONS` deleted from `resubscribe()`. Verified: with
 * the spread removed those three stay green and only this test goes red. In
 * production herdr would then simply never deliver `workspace_renamed`, the
 * Spaces screen would stop invalidating, and the suite would say nothing —
 * forever.
 *
 * Asserted in the DOTTED form deliberately: `socket.ts` documents that the
 * subscribe name and the delivered name differ, and subscribing to the
 * delivered spelling (`tab_renamed`) is the silent-failure-for-ever mistake
 * this pins against. So one tab and one workspace entry are checked as
 * subscribed, and the underscored spellings are checked as absent.
 */
test("the structural events are actually subscribed, in the dotted subscribe spelling", async () => {
  const { sup, subs } = harness();
  await sup.start();
  expect(subs).toContainEqual({ type: "tab.renamed" });
  expect(subs).toContainEqual({ type: "workspace.renamed" });
  expect(subs).toContainEqual({ type: "tab.created" });
  expect(subs).toContainEqual({ type: "workspace.created" });
  // The delivered spellings are what `handleEvent` matches; asking herdr for
  // them is the mistake that fails silently and for ever.
  expect(subs).not.toContainEqual({ type: "tab_renamed" });
  expect(subs).not.toContainEqual({ type: "workspace_renamed" });
});
