import { afterEach, expect, test } from "bun:test";
import { mkdtemp, unlink } from "node:fs/promises";
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
import { StreamKeeper } from "@server/herdr/keeper";
import { HERDR_PROTOCOL, type HerdrEvent } from "@shared/herdr-api";

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
 *
 * `mute` models the nastier failure: herdr accepts the connection, reads the
 * request, and then answers NOTHING, ever, while holding the connection open.
 * Nothing about that is observable to the client except the passage of time.
 */
async function fakeHerdr(
  protocol = 19,
  opts: { dropSubscribeAck?: boolean; mute?: boolean; omitProtocol?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-sock-"));
  const path = join(dir, "h.sock");
  const streams = new Set<any>();
  const muted = new Set<any>();
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

          // Accepted, read, and never answered — the connection just sits there.
          if (opts.mute) { muted.add(s); return; }

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
              ? {
                  id: req.id,
                  // `omitProtocol` sends a pong with NO protocol field at all.
                  // Passing `undefined` as the argument cannot express this —
                  // the default parameter would silently substitute 19 and the
                  // test would pass by throwing for the wrong reason.
                  result: opts.omitProtocol
                    ? { type: "pong", version: "0.8.0" }
                    : { type: "pong", version: "0.8.0", protocol },
                }
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

  stop = () => {
    for (const s of streams) s.end();
    for (const s of muted) s.end();
    server.stop(true);
  };
  return {
    path,
    requestsSeen,
    push: (e: HerdrEvent) => { for (const s of streams) s.write(JSON.stringify(e) + "\n"); },
    pushRaw: (text: string) => { for (const s of streams) s.write(text); },
    streamCount: () => streams.size,
    /** Hang up from the server side, as herdr crashing or restarting would —
     * NOT requested by the client. Distinct from the client calling close(). */
    dropStream: () => { for (const s of streams) s.end(); },
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

// DERIVED from HERDR_PROTOCOL, never hardcoded. These two used the literals 19
// and 20, so bumping the pin — a routine operation every time herdr moves —
// broke them both: "matching" stopped matching, and "different" became the new
// pin and stopped throwing. A test that fails on a legitimate regeneration is
// noise that trains you to edit tests instead of reading them.
test("checkProtocol accepts a matching protocol", async () => {
  const { path } = await fakeHerdr(HERDR_PROTOCOL);
  await checkProtocol(path);
});

// OLDER, not newer, and deliberately so: an older herdr genuinely lacks what
// this paddock reads, so it must refuse in every policy this project has held.
test("checkProtocol throws ProtocolMismatchError on an older protocol", async () => {
  const { path } = await fakeHerdr(HERDR_PROTOCOL - 1);
  await expect(checkProtocol(path)).rejects.toBeInstanceOf(ProtocolMismatchError);
});

// The asymmetry `scripts/protocol-guard.ts` already encodes for `make types`,
// now applied at runtime: herdr bumps its protocol often (0.8.0 → 0.8.2 moved
// 19 → 20 and changed nothing paddock reads), and refusing to start over an
// integer that carried no consequence took the dashboard down for nothing.
// Newer is REPORTED, not fatal — what actually breaks is a field going away,
// and `checkAgentShape` is what watches for that.
test("checkProtocol accepts a NEWER herdr and reports the drift", async () => {
  const { path } = await fakeHerdr(HERDR_PROTOCOL + 1);
  expect(await checkProtocol(path)).toEqual({
    kind: "newer",
    herdr: HERDR_PROTOCOL + 1,
    paddock: HERDR_PROTOCOL,
  });
});

test("checkProtocol reports a match plainly", async () => {
  const { path } = await fakeHerdr(HERDR_PROTOCOL);
  expect(await checkProtocol(path)).toEqual({ kind: "match" });
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

// Task 16 review finding: open() tears down the previous socket at its top
// (see close() there), and Bun invokes that old socket's close handler
// synchronously. That teardown is deliberate — a routine resubscribe, which
// happens on every ordinary agent start/exit in a live session — and must
// not be reported as a disconnect. Reporting it would fire the Task 16
// reconnect keeper on every such routine event, not just a real one, and
// bury the one signal a genuine incident needs to stand out against.
test("a routine open() replacing the stream reports no false disconnect", async () => {
  const { path } = await fakeHerdr();
  const changes: boolean[] = [];
  const stream = new HerdrStream({
    path,
    onEvent: () => {},
    onStateChange: (up) => changes.push(up),
  });

  await stream.open(statusSubscriptions(["w1:p1"]));
  await stream.open(statusSubscriptions(["w1:p1", "w1:p2"]));
  await Bun.sleep(50);

  // Two opens, each eventually connected — never a spurious `false` from the
  // first stream's deliberate teardown in between.
  expect(changes).toEqual([true, true]);
  stream.close();
});

// The other half of the same fix: a drop nobody asked for must still be
// reported, or a real herdr crash would go unnoticed and Task 16's keeper
// would never fire.
test("a genuine unrequested drop still reports a disconnect", async () => {
  const { path, dropStream } = await fakeHerdr();
  const changes: boolean[] = [];
  const stream = new HerdrStream({
    path,
    onEvent: () => {},
    onStateChange: (up) => changes.push(up),
  });

  await stream.open(statusSubscriptions(["w1:p1"]));
  dropStream(); // herdr hangs up on its own — the client never called close()
  await Bun.sleep(50);

  expect(changes).toEqual([true, false]);
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

// ---------------------------------------------------------------------------
// Bounded waits. A herdr that ACCEPTS a connection and then answers nothing
// used to hang forever, which by Task 16 meant: reconcile() hangs ->
// runRefreshLoop() never resolves -> refreshLoop stays non-null -> every later
// refresh() returns that same hung promise, including the reconnect keeper's,
// which then never retries. Plus one leaked socket per 30s healing tick.
// ---------------------------------------------------------------------------

test("request() rejects within its timeout when herdr accepts but never answers", async () => {
  const { path } = await fakeHerdr(19, { mute: true });

  const timedOut = Symbol("hung");
  const started = Date.now();
  const result = await Promise.race([
    request(path, "agent.list", {}, 100).then(
      () => { throw new Error("request() resolved, but herdr never answered"); },
      (err) => err,
    ),
    Bun.sleep(2_000).then(() => timedOut),
  ]);

  expect(result).not.toBe(timedOut); // regression: request() hung forever
  expect((result as Error).message).toMatch(/agent\.list timed out after 100ms/);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("the request timeout names the method, so a log line identifies the wedge", async () => {
  const { path } = await fakeHerdr(19, { mute: true });
  await expect(request(path, "workspace.list", {}, 50)).rejects.toThrow(/workspace\.list timed out/);
});

test("the subscribe ack wait is bounded too", async () => {
  // Distinct from the drop-before-ack case above: here the connection stays
  // up and simply never acknowledges, so there is no close event to settle
  // open() and nothing but a timeout can end the wait.
  const { path } = await fakeHerdr(19, { mute: true });
  const stream = new HerdrStream({ path, onEvent: () => {}, ackTimeoutMs: 100 });

  const timedOut = Symbol("hung");
  const result = await Promise.race([
    stream.open(statusSubscriptions(["w1:p1"])).then(
      () => { throw new Error("open() resolved without an ack"); },
      (err) => err,
    ),
    Bun.sleep(2_000).then(() => timedOut),
  ]);

  expect(result).not.toBe(timedOut); // regression: the ack wait hung forever
  expect((result as Error).message).toMatch(/events\.subscribe timed out after 100ms/);
  expect(stream.connected).toBe(false); // and the socket did not leak
  stream.close();
});

// ---------------------------------------------------------------------------
// The dead end: a reopen that cannot connect. The old socket's teardown was
// deliberate, so it reports nothing; the replacement never connects, so there
// is no close handler to report either. Nothing armed recovery, and
// /api/health went on claiming the stream was up.
// ---------------------------------------------------------------------------

test("a reopen whose connect fails reports the disconnect", async () => {
  const { path } = await fakeHerdr();
  const changes: boolean[] = [];
  const stream = new HerdrStream({
    path,
    onEvent: () => {},
    onStateChange: (up) => changes.push(up),
  });

  await stream.open(statusSubscriptions(["w1:p1"]));
  expect(changes).toEqual([true]);

  // herdr dies exactly between the teardown and the reconnect: the socket
  // path is gone, so Bun.connect cannot succeed, while the live connection is
  // still what open() tears down first.
  await unlink(path);

  await expect(stream.open(statusSubscriptions(["w1:p1", "w1:p2"]))).rejects.toThrow();

  expect(changes).toEqual([true, false]);
  expect(stream.connected).toBe(false); // health must not claim otherwise
  stream.close();
});

test("a failed reopen ARMS the reconnect keeper", async () => {
  // The end of the dead-end path: whatever the mechanism, the outcome that
  // matters is that something is now trying to get the stream back.
  const { path } = await fakeHerdr();
  let keeper: StreamKeeper;
  let refreshes = 0;

  const stream = new HerdrStream({
    path,
    onEvent: () => {},
    // Exactly how src/server/index.ts wires it.
    onStateChange: (up) => { if (!up) keeper.notifyClosed(); },
  });
  keeper = new StreamKeeper({
    refresh: async () => { refreshes++; },
    sleep: async () => {},
  });

  await stream.open(statusSubscriptions(["w1:p1"]));
  await unlink(path);
  await expect(stream.open(statusSubscriptions(["w1:p1", "w1:p2"]))).rejects.toThrow();
  await keeper.settled();

  expect(refreshes).toBeGreaterThan(0);
  stream.close();
});

test("a FIRST open() that fails does not claim a stream was lost", async () => {
  // Nothing was ever up, so there is nothing to report as down — only the
  // rejection the caller already has to handle.
  const { path } = await fakeHerdr();
  await unlink(path);
  const changes: boolean[] = [];
  const stream = new HerdrStream({
    path, onEvent: () => {}, onStateChange: (up) => changes.push(up),
  });

  await expect(stream.open(statusSubscriptions(["w1:p1"]))).rejects.toThrow();

  expect(changes).toEqual([]);
});

// The message is the whole feature here: it is the only thing an operator sees
// before the process exits, and the version it replaced told EVERY mismatch to
// run `make types` — advice that is right in exactly one of the two directions
// and destructive in the other, because regenerating against an older herdr
// lowers the committed contract.
test("the mismatch message tells an operator with an older herdr to upgrade herdr", () => {
  const msg = new ProtocolMismatchError(19, 16).message;
  expect(msg).toContain("19");
  expect(msg).toContain("16");
  expect(msg).toContain("older");
  expect(msg).toContain("daemon");
  expect(msg).not.toContain("make types");
  // Naming the commands is the point. "restart its daemon" was true and still
  // left the operator guessing: there is no standalone handoff command, and
  // which one applies depends on whether the BINARY is already current.
  expect(msg).toContain("herdr status server");
  expect(msg).toContain("herdr update --handoff");
  expect(msg).toContain("herdr server stop");
});

test("the mismatch message tells a contributor with a newer herdr to regenerate the types", () => {
  const msg = new ProtocolMismatchError(19, 20).message;
  expect(msg).toContain("newer");
  expect(msg).toContain("make types");
  expect(msg).toContain("adapter.ts");
  expect(msg).toContain("paddock update");
});

// A hole the `!==` → ordered-comparison change opened, found in review.
// `undefined < N` and `undefined > N` are BOTH false, so an absent or
// non-numeric protocol fell through to "match" and paddock started as if it had
// verified something. The old `!==` threw with "herdr reports undefined", which
// was loud and correct.
test("a ping with no protocol is a mismatch, not a match", async () => {
  const { path } = await fakeHerdr(HERDR_PROTOCOL, { omitProtocol: true });
  await expect(checkProtocol(path)).rejects.toBeInstanceOf(ProtocolMismatchError);
});

test("a non-numeric protocol is a mismatch, not a match", async () => {
  const { path } = await fakeHerdr("20" as unknown as number);
  await expect(checkProtocol(path)).rejects.toBeInstanceOf(ProtocolMismatchError);
});
