import { expect, test } from "bun:test";
import { StreamKeeper, backoffWithJitter } from "@server/herdr/keeper";
import { ProtocolMismatchError, type Subscription } from "@server/herdr/socket";
import { Supervisor } from "@server/supervisor";
import { AgentStore } from "@server/state/store";

const noSleep = async () => {};

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
  return {
    streams: [] as Subscription[][],
    async request<T>(method: string): Promise<T> {
      if (method === "agent.list") return { type: "agent_list", agents } as T;
      if (method === "workspace.list") {
        return { type: "workspace_list", workspaces: [{ workspace_id: "w1", label: "api work", number: 1 }] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    async openStream(subs: Subscription[]) { this.streams.push(subs); },
  };
}

test("retries until refresh succeeds", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => {
      calls++;
      if (calls < 3) throw new Error("herdr is down");
    },
    sleep: noSleep,
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(3);
  expect(keeper.reconnecting).toBe(false);
});

test("a second notifyClosed while retrying does not start a second loop", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => {
      calls++;
      if (calls < 2) throw new Error("still down");
    },
    sleep: noSleep,
  });

  keeper.notifyClosed();
  keeper.notifyClosed();
  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(2); // not 6
});

test("stop() halts the retry loop", async () => {
  let calls = 0;
  const keeper = new StreamKeeper({
    refresh: async () => { calls++; throw new Error("down"); },
    sleep: async () => { keeper.stop(); },
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(1);
  expect(keeper.reconnecting).toBe(false);
});

test("a protocol mismatch is fatal and is never retried", async () => {
  let calls = 0;
  let fatal: Error | null = null;
  const keeper = new StreamKeeper({
    refresh: async () => { calls++; throw new ProtocolMismatchError(19, 20); },
    sleep: noSleep,
    onFatal: (e) => { fatal = e; },
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(calls).toBe(1); // retrying a version mismatch can never succeed
  expect(fatal).toBeInstanceOf(ProtocolMismatchError);
});

test("backoff grows and is capped at 15s", () => {
  const at = (n: number) => backoffWithJitter(n, () => 0.5);
  expect(at(0)).toBeLessThan(at(1));
  expect(at(1)).toBeLessThan(at(2));
  for (let n = 0; n < 20; n++) expect(backoffWithJitter(n, () => 1)).toBeLessThanOrEqual(15_000);
});

test("jitter spreads retries rather than synchronising them", () => {
  // Two clients reconnecting after the same herdr restart must not retry in
  // lockstep, so the delay must depend on the random source.
  expect(backoffWithJitter(4, () => 0)).not.toBe(backoffWithJitter(4, () => 1));
});

test("recovery re-opens the stream even when the pane set is UNCHANGED", async () => {
  // This is the whole point of the task. After a herdr restart the pane set
  // is usually identical to what it was before the drop — same agents, dead
  // socket — so Supervisor.resubscribe()'s unchanged-pane-set early return
  // would otherwise believe the (now-dead) stream is still live and never
  // call openStream() again. The keeper's refresh callback must clear that
  // belief with invalidateSubscription() before calling refresh(), exactly as
  // src/server/index.ts wires it.
  const client = fakeClient();
  const store = new AgentStore("dev-box");
  const sup = new Supervisor({ client, store, onDelta: () => {}, now: () => NOW });
  await sup.start();
  const before = client.streams.length;

  // Sanity check: an unchanged pane set alone does not reopen the stream —
  // this is what makes the carry-forward necessary in the first place.
  await sup.refresh();
  expect(client.streams.length).toBe(before);

  const keeper = new StreamKeeper({
    refresh: () => {
      sup.invalidateSubscription();
      return sup.refresh();
    },
    sleep: noSleep,
  });

  keeper.notifyClosed();
  await keeper.settled();

  expect(client.streams.length).toBe(before + 1);
  sup.stop();
});
