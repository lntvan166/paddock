import { expect, test } from "bun:test";
import { deltaSink } from "@server/index-wiring";
import { AgentWatch } from "@server/mcp/watch";
import type { Agent } from "@shared/types";

const agent = (state: Agent["state"], agentId = "w1:p1"): Agent => ({
  hostId: "dev-box", agentId, name: "flaky-test-fix", task: "Stabilise the retry test",
  state, workspaceId: "w1", workspaceLabel: null, cwd: "/path/to/project", harness: "claude",
  stateSince: 0, stateSinceExact: true, updatedAt: 0, acknowledgedAt: null, hasJournal: true, origin: "herdr", turn: null, seen: null,
});

test("until resolves on a matching upsert", async () => {
  const w = new AgentWatch();
  const p = w.until("w1:p1", (a) => a.state === "idle", 1000);
  w.observe({ upserted: [agent("idle")], removedIds: [] });
  expect(await p).toEqual(agent("idle"));
  expect(w.listeners).toBe(0);
});

test("non-matching upserts are ignored", async () => {
  const w = new AgentWatch();
  const p = w.until("w1:p1", (a) => a.state === "idle", 30);
  w.observe({ upserted: [agent("working")], removedIds: [] });
  w.observe({ upserted: [agent("idle", "w2:p1")], removedIds: [] });
  expect(await p).toBe("timeout");
});

test("removal ends the wait", async () => {
  const w = new AgentWatch();
  const p = w.until("w1:p1", () => false, 1000);
  w.observe({ upserted: [], removedIds: ["w1:p1"] });
  expect(await p).toBe("gone");
  expect(w.listeners).toBe(0);
});

test("timeout resolves and leaves no listener behind", async () => {
  const w = new AgentWatch();
  expect(await w.until("w1:p1", () => true, 20)).toBe("timeout");
  expect(w.listeners).toBe(0);
});

test("deltaSink calls the watch after the hub and the notifier", () => {
  const order: string[] = [];
  const sink = deltaSink(
    { queue: () => order.push("hub") },
    { observe: () => order.push("notifier") },
    { observe: () => order.push("watch") },
  );
  sink({ upserted: [agent("idle")], removedIds: [] });
  expect(order).toEqual(["hub", "notifier", "watch"]);
});
