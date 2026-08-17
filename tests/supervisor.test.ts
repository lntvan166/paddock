import { expect, test } from "bun:test";
import { Supervisor } from "@server/supervisor";
import { AgentStore } from "@server/state/store";
import type { Delta } from "@server/state/store";
import type { Subscription } from "@server/herdr/socket";

const NOW = 1_700_000_000_000;

function rawAgent(over: Record<string, unknown> = {}) {
  return {
    agent: "claude", agent_status: "working", cwd: "/srv/project", focused: false,
    name: "api-refactor", pane_id: "w1:p1", revision: 1, tab_id: "w1:t1",
    terminal_id: "t1", terminal_title: "* Extract auth middleware",
    terminal_title_stripped: "Extract auth middleware", workspace_id: "w1", ...over,
  };
}

function fakeClient(agents: unknown[] = [rawAgent()]) {
  const calls: string[] = [];
  return {
    calls,
    /** Every openStream call, so tests can assert the subscription set. */
    streams: [] as Subscription[][],
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "agent.list") return { type: "agent_list", agents } as T;
      if (method === "workspace.list") {
        return { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "api work", number: 1 }] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async openStream(subs: Subscription[]) { this.streams.push(subs); },
  };
}

test("start reconciles FIRST, then subscribes naming every known pane", async () => {
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();

  // Ordering: the pane set cannot be named before agent.list has returned it.
  expect(client.calls.indexOf("agent.list")).toBeGreaterThanOrEqual(0);
  expect(client.streams).toHaveLength(1);

  const subs = client.streams[0]!;
  expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p1" });
  // Globals carry no pane_id and are how the pane set stays current.
  expect(subs).toContainEqual({ type: "pane.agent_detected" });
  expect(subs).toContainEqual({ type: "pane.closed" });
  sup.stop();
});

test("a status subscription is never sent without a pane_id", async () => {
  // herdr rejects that outright: invalid_request "missing field pane_id".
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();
  for (const s of client.streams.flat()) {
    if (s.type === "pane.agent_status_changed") expect(s.pane_id).toBeTruthy();
  }
  sup.stop();
});

test("pane_agent_detected re-opens the stream with the new pane set", async () => {
  const client = fakeClient();
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  // Underscored — this is the name herdr actually delivers.
  sup.handleEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p2", workspace_id: "w1", agent: "claude" } });
  await Bun.sleep(20);

  expect(client.streams.length).toBe(before + 1);
  sup.stop();
});

test("pane_closed removes the agent immediately, without waiting for reconcile", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const deltas: Delta[] = [];
  const sup = new Supervisor({ client, store, onDelta: (d) => deltas.push(d), now: () => NOW });
  await sup.start();
  expect(store.snapshot()).toHaveLength(1);

  sup.handleEvent({ event: "pane_closed", data: { pane_id: "w1:p1", workspace_id: "w1" } });

  expect(store.snapshot()).toHaveLength(0);
  expect(deltas.at(-1)!.removedIds).toContain("w1:p1");
  sup.stop();
});

test("reconcile joins the workspace label onto the agent", async () => {
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client: fakeClient(), store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  expect(store.snapshot()[0]!.workspaceLabel).toBe("api work");
});

test("a status event for a known agent updates it without a reconcile", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const deltas: Delta[] = [];
  const sup = new Supervisor({ client, store, onDelta: (d) => deltas.push(d), now: () => NOW });
  await sup.reconcile();
  const before = client.calls.length;

  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "blocked" },
  });

  expect(store.snapshot()[0]!.state).toBe("blocked");
  expect(client.calls).toHaveLength(before); // no extra round trip
  expect(deltas.at(-1)!.upserted[0]!.name).toBe("api-refactor"); // name preserved
});

test("a status event for an UNKNOWN agent triggers a reconcile to learn its name", async () => {
  const store = new AgentStore("dev-box");
  const client = fakeClient();
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  const before = client.calls.filter((c) => c === "agent.list").length;

  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w9:p1", workspace_id: "w9", agent_status: "working" },
  });
  await Bun.sleep(20);

  expect(client.calls.filter((c) => c === "agent.list").length).toBe(before + 1);
});

test("lastEventAt is null before any event and set after one", async () => {
  const sup = new Supervisor({
    client: fakeClient(), store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW,
  });
  expect(sup.lastEventAt).toBeNull();
  await sup.reconcile();
  sup.handleEvent({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" },
  });
  expect(sup.lastEventAt).toBe(NOW);
});

test("an unrelated event kind is ignored", async () => {
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client: fakeClient(), store, onDelta: () => {}, now: () => NOW });
  await sup.reconcile();
  sup.handleEvent({ event: "pane.scroll_changed", data: { pane_id: "w1:p1" } });
  expect(store.snapshot()[0]!.state).toBe("working");
});
