import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrStream,
  ProtocolMismatchError,
  checkProtocol,
  request,
  statusSubscriptions,
  GLOBAL_SUBSCRIPTIONS,
  EVENT_STATUS_CHANGED,
  EVENT_PANE_CLOSED,
} from "@server/herdr/socket";
import type { HerdrEvent } from "@shared/herdr-api";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

/**
 * Models herdr's real connection behaviour:
 *  - a request connection gets ONE response, then the server closes it
 *  - an events.subscribe connection stays open and streams
 *
 * `dropSubscribeAck` models a subscribe connection that herdr accepts and
 * then drops without ever sending the acknowledgement frame (a malformed
 * subscription, a daemon hangup, or the socket just dying mid-handshake).
 * It changes nothing about request connections: they still get exactly one
 * response and refuse a second request on the same connection.
 */
async function fakeHerdr(protocol = 19, opts: { dropSubscribeAck?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-sock-"));
  const path = join(dir, "h.sock");
  const streams = new Set<any>();
  const served = new WeakSet<any>();
  const requestsSeen: { method: string; params: any }[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      close(s) { streams.delete(s); },
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);

          // A connection that already answered must not answer again.
          if (served.has(s)) { s.end(); return; }
          requestsSeen.push({ method: req.method, params: req.params });

          if (req.method === "events.subscribe") {
            if (opts.dropSubscribeAck) {
              s.end(); // accepted, then dropped — no ack frame, ever
              return;
            }
            s.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
            streams.add(s); // stays open
            return;
          }

          const reply =
            req.method === "ping"
              ? { id: req.id, result: { type: "pong", version: "0.8.0", protocol } }
              : req.method === "boom"
                ? { id: req.id, error: { code: "invalid_request", message: "no such thing" } }
                : { id: req.id, result: { type: "agent_list", agents: [] } };
          s.write(JSON.stringify(reply) + "\n");
          served.add(s);
          s.end(); // herdr closes after one response
        }
      },
    },
  });

  stop = () => { for (const s of streams) s.end(); server.stop(true); };
  return {
    path,
    requestsSeen,
    push: (e: HerdrEvent) => { for (const s of streams) s.write(JSON.stringify(e) + "\n"); },
    pushRaw: (text: string) => { for (const s of streams) s.write(text); },
    streamCount: () => streams.size,
  };
}

test("a request returns its result", async () => {
  const { path } = await fakeHerdr();
  const res = await request<{ type: string }>(path, "agent.list", {});
  expect(res.type).toBe("agent_list");
});

// THE regression test for this task. The server hangs up after each response,
// so every request must open its own connection. A multiplexing client passes
// the test above and fails this one.
test("sequential requests each open a fresh connection", async () => {
  const { path } = await fakeHerdr();
  expect((await request<{ type: string }>(path, "agent.list", {})).type).toBe("agent_list");
  expect((await request<{ type: string }>(path, "workspace.list", {})).type).toBe("agent_list");
  expect((await request<{ type: string }>(path, "agent.list", {})).type).toBe("agent_list");
});

test("a request rejects when herdr returns an error body", async () => {
  const { path } = await fakeHerdr();
  await expect(request(path, "boom", {})).rejects.toThrow("no such thing");
});

test("checkProtocol accepts a matching protocol", async () => {
  const { path } = await fakeHerdr(19);
  await checkProtocol(path);
});

test("checkProtocol throws ProtocolMismatchError on a different protocol", async () => {
  const { path } = await fakeHerdr(20);
  await expect(checkProtocol(path)).rejects.toBeInstanceOf(ProtocolMismatchError);
});

test("status subscriptions carry a pane_id; global ones do not", () => {
  const subs = statusSubscriptions(["w1:p1", "w1:p2"]);
  expect(subs).toEqual([
    { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    { type: "pane.agent_status_changed", pane_id: "w1:p2" },
  ]);
  for (const g of GLOBAL_SUBSCRIPTIONS) expect(g.pane_id).toBeUndefined();
});

test("the stream sends every subscription in one events.subscribe call", async () => {
  const { path, requestsSeen } = await fakeHerdr();
  const stream = new HerdrStream({ path, onEvent: () => {} });
  await stream.open([...statusSubscriptions(["w1:p1"]), ...GLOBAL_SUBSCRIPTIONS]);
  const sub = requestsSeen.find((r) => r.method === "events.subscribe");
  expect(sub!.params.subscriptions).toHaveLength(1 + GLOBAL_SUBSCRIPTIONS.length);
  stream.close();
});

test("the stream delivers events, keeping herdr's own event names", async () => {
  const { path, push } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  // Dotted for a SubscriptionEventKind, underscored for the rest.
  push({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1", agent_status: "working" } } as HerdrEvent);
  push({ event: EVENT_PANE_CLOSED, data: { pane_id: "w1:p1", workspace_id: "w1" } } as HerdrEvent);
  await Bun.sleep(50);

  expect(seen.map((e) => e.event)).toEqual([EVENT_STATUS_CHANGED, EVENT_PANE_CLOSED]);
  stream.close();
});

test("the stream reassembles a frame split across two writes", async () => {
  const { path, pushRaw } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  const frame =
    JSON.stringify({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1", agent_status: "blocked" } }) + "\n";
  const cut = Math.floor(frame.length / 2);
  pushRaw(frame.slice(0, cut));
  await Bun.sleep(20);
  expect(seen).toHaveLength(0); // nothing dispatched until the newline arrives
  pushRaw(frame.slice(cut));
  await Bun.sleep(30);

  expect(seen).toHaveLength(1);
  expect((seen[0]!.data as any).agent_status).toBe("blocked");
  stream.close();
});

test("two frames arriving in one write are both dispatched", async () => {
  const { path, pushRaw } = await fakeHerdr();
  const seen: HerdrEvent[] = [];
  const stream = new HerdrStream({ path, onEvent: (e) => seen.push(e) });
  await stream.open(statusSubscriptions(["w1:p1"]));

  pushRaw(
    JSON.stringify({ event: EVENT_STATUS_CHANGED, data: { pane_id: "w1:p1" } }) + "\n" +
    JSON.stringify({ event: EVENT_PANE_CLOSED, data: { pane_id: "w1:p2" } }) + "\n",
  );
  await Bun.sleep(50);

  expect(seen.map((e) => e.event)).toEqual([EVENT_STATUS_CHANGED, EVENT_PANE_CLOSED]);
  stream.close();
});

test("open() replaces the previous stream rather than stacking one", async () => {
  const { path, streamCount } = await fakeHerdr();
  const stream = new HerdrStream({ path, onEvent: () => {} });
  await stream.open(statusSubscriptions(["w1:p1"]));
  await stream.open(statusSubscriptions(["w1:p1", "w1:p2"]));
  await Bun.sleep(50);
  expect(streamCount()).toBe(1);
  stream.close();
});

// Regression guard: open() must settle even if the underlying socket closes
// before the events.subscribe acknowledgement ever arrives (a malformed
// subscription, a daemon hangup, the connection just dying mid-handshake).
// Race against a bounded timeout so that if this regresses, the test fails
// fast instead of hanging the whole suite.
test("open() rejects rather than hanging when the socket closes before the subscribe ack", async () => {
  const { path } = await fakeHerdr(19, { dropSubscribeAck: true });
  const stream = new HerdrStream({ path, onEvent: () => {} });

  const timedOut = Symbol("timed out");
  const result = await Promise.race([
    stream.open(statusSubscriptions(["w1:p1"])).then(
      () => { throw new Error("open() resolved, but the subscribe ack was never sent"); },
      (err) => err,
    ),
    Bun.sleep(500).then(() => timedOut),
  ]);

  expect(result).not.toBe(timedOut); // regression: open() hung instead of rejecting
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toMatch(/before events\.subscribe was acknowledged/);
  stream.close();
});
