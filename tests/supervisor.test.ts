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
  // A mutable backing array: resubscribe() now no-ops when the pane set is
  // unchanged (see the coalescing tests below), so the fake server's agent
  // list has to actually gain the pane for this resubscribe to be non-trivial.
  const agents = [rawAgent()];
  const client = fakeClient(agents);
  const sup = new Supervisor({ client, store: new AgentStore("dev-box"), onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  agents.push(rawAgent({ pane_id: "w1:p2", name: "flaky-test-fix" }));

  // Underscored — this is the name herdr actually delivers.
  sup.handleEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p2", workspace_id: "w1", agent: "claude" } });
  await Bun.sleep(20);

  expect(client.streams.length).toBe(before + 1);
  expect(client.streams.at(-1)).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p2" });
  sup.stop();
});

test("a burst of lifecycle events coalesces into one resubscribe carrying the final pane set", async () => {
  // Two panes are live; mid-burst the server starts reporting a completely
  // different pane set (p1 and p2 both gone, p3 present) before any of the
  // three back-to-back events below has had a chance to reconcile.
  const agents = [rawAgent({ pane_id: "w1:p1" }), rawAgent({ pane_id: "w1:p2", name: "flaky-test-fix" })];
  const client = fakeClient(agents);
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.start();
  expect(store.snapshot()).toHaveLength(2);
  const before = client.streams.length;
  const agentListCallsBefore = client.calls.filter((c) => c === "agent.list").length;

  agents.length = 0;
  agents.push(rawAgent({ pane_id: "w1:p3", name: "schema-migration" }));

  // Fired back-to-back with no await between them — a real burst, not three
  // separate ticks of the event loop.
  sup.handleEvent({ event: "pane_closed", data: { pane_id: "w1:p1", workspace_id: "w1" } });
  sup.handleEvent({ event: "pane_closed", data: { pane_id: "w1:p2", workspace_id: "w1" } });
  sup.handleEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p3", workspace_id: "w1", agent: "claude" } });

  await Bun.sleep(20);

  // The real discriminator: three events must not launch three independent
  // reconcile+resubscribe chains. One in-flight pass, plus exactly one
  // coalesced follow-up to pick up all three events, is two agent.list calls
  // total — never three (one per event). This is what genuinely distinguishes
  // a serialized refresh() from an unserialized one; the resubscribe call
  // count below does NOT (see the coalescing comment in supervisor.ts), since
  // the unchanged-set no-op happens to converge to the same open count here.
  const agentListCallsDuring = client.calls.filter((c) => c === "agent.list").length - agentListCallsBefore;
  expect(agentListCallsDuring).toBe(2);

  // And the stream that does get (re)opened carries the final pane set, not
  // one from partway through the burst.
  expect(client.streams.length).toBe(before + 1);
  const finalSubs = client.streams.at(-1)!;
  expect(finalSubs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1:p3" });
  expect(finalSubs.some((s) => s.pane_id === "w1:p1")).toBe(false);
  expect(finalSubs.some((s) => s.pane_id === "w1:p2")).toBe(false);
  sup.stop();
});

test("a refresh whose pane set is unchanged does not reopen the stream", async () => {
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  // Nothing about the pane set changed — reconcile alone must not reopen it.
  await sup.refresh();

  expect(client.streams.length).toBe(before);
  sup.stop();
});

test("a rejected openStream() does not poison the guard — a later resubscribe with the same pane set still retries", async () => {
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });

  // Make the FIRST openStream attempt reject, as herdr would if it were down
  // or refused the subscription. Every attempt after that succeeds normally.
  let openAttempts = 0;
  const realOpenStream = client.openStream.bind(client);
  client.openStream = async (subs) => {
    openAttempts++;
    if (openAttempts === 1) throw new Error("herdr: subscribe rejected");
    return realOpenStream(subs);
  };

  // start() reconciles fine, but its subscribe attempt is the rejected one.
  let threw = false;
  try {
    await sup.start();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(openAttempts).toBe(1);

  // The pane set is unchanged from the failed attempt (still just w1:p1). If
  // the failed attempt had been recorded as successful, this refresh would
  // wrongly take the "unchanged, nothing to do" early return and never call
  // openStream() again — leaving the supervisor believing it is subscribed
  // to a stream that was never opened.
  await sup.refresh();
  expect(openAttempts).toBe(2);

  sup.stop();
});

test("invalidateSubscription() forces the next refresh to re-open the stream even with an unchanged pane set", async () => {
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  // Baseline: an unchanged pane set alone does not reopen the stream.
  await sup.refresh();
  expect(client.streams.length).toBe(before);

  // Task 16 calls this after learning the stream is closed. The pane set is
  // still unchanged, but the next refresh must re-subscribe anyway.
  sup.invalidateSubscription();
  await sup.refresh();

  expect(client.streams.length).toBe(before + 1);
  sup.stop();
});

test("an invalidateSubscription() landing MID-OPEN is not overwritten by that open", async () => {
  // The narrow race the reviewer left standing: a genuine drop is reported
  // while an UNRELATED refresh is already between its openStream() await and
  // its post-await `openPaneKey` write. That write used to clobber the
  // invalidation, after which the follow-up pass took the unchanged-pane-set
  // early return, refresh() resolved happily, and the keeper logged "event
  // stream recovered" for a stream that was never reopened.
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.start();

  // Hold the next openStream() open so a drop can land in the middle of it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let heldOnce = false;
  const realOpenStream = client.openStream.bind(client);
  client.openStream = async (subs) => {
    if (!heldOnce) { heldOnce = true; await held; }
    return realOpenStream(subs);
  };

  sup.invalidateSubscription();       // an earlier drop starts this refresh
  const inFlight = sup.refresh();
  await Bun.sleep(10);                // now parked inside openStream()
  sup.invalidateSubscription();       // a SECOND drop lands mid-open
  release();
  await inFlight;

  const before = client.streams.length;
  await sup.refresh(); // the pane set is unchanged; only the invalidation forces this

  expect(client.streams.length).toBe(before + 1);
  sup.stop();
});

test("a background refresh failure is reported, not swallowed into a log line", async () => {
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const failures: unknown[] = [];
  const sup = new Supervisor({
    client, store, onDelta: () => {}, now: () => NOW,
    onBackgroundFailure: (err) => failures.push(err),
  });
  await sup.start();

  // herdr goes away after startup: the refresh a lifecycle event triggers now
  // rejects, and nothing is awaiting it.
  client.request = async () => { throw new Error("herdr: connection refused"); };

  sup.handleEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p2", workspace_id: "w1", agent: "claude" } });
  await Bun.sleep(20);

  // Without this, the only trace is a console line and nothing arms recovery.
  expect(failures).toHaveLength(1);
  expect((failures[0] as Error).message).toMatch(/connection refused/);
  sup.stop();
});

test("a failing healing reconcile also reports, so a stuck timer is not silent", async () => {
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const failures: unknown[] = [];
  const sup = new Supervisor({
    client, store, onDelta: () => {}, now: () => NOW,
    reconcileMs: 10,
    onBackgroundFailure: (err) => failures.push(err),
  });
  await sup.start();
  client.request = async () => { throw new Error("herdr: gone"); };

  await Bun.sleep(40);
  sup.stop();

  expect(failures.length).toBeGreaterThan(0);
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
