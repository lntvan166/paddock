import { expect, test } from "bun:test";
import { ScreenStream, type StreamClient } from "@server/screen-stream";
import { applyPatch, digestOf } from "@shared/screen";
import type { AgentState, ServerMessage } from "@shared/types";

/*
 * Pushing an open pane's screen over the socket. Fake backend: `watch` hands
 * back the change callback, `read` returns whatever `screen` holds. Invented
 * agent ids only.
 */

type Frame = Extract<ServerMessage, { type: "screen" }>;

function client() {
  const got: Frame[] = [];
  const c: StreamClient = { send: (d) => got.push(JSON.parse(d) as Frame) };
  return { c, got };
}

function rig(o: { canWatch?: boolean; known?: string[] } = {}) {
  const fire = new Map<string, () => void>();
  const unwatched: string[] = [];
  let screen = ["$ api-refactor", "thinking"];
  let reads = 0;
  let fail: string | null = null;
  const logs: string[] = [];
  let clock = 1_000;
  const known = new Set(o.known ?? ["hc.t1"]);
  const s = new ScreenStream({
    agent: (id) => (known.has(id) ? { state: "working" as AgentState } : null),
    watch: (id, cb) => {
      if (o.canWatch === false) return null;
      fire.set(id, cb);
      return () => { unwatched.push(id); fire.delete(id); };
    },
    read: async () => {
      reads++;
      if (fail) throw new Error(fail);
      return { lines: [...screen], source: "visible" };
    },
    minMs: 0,
    retryMs: 50,
    now: () => clock,
    log: (l) => logs.push(l),
  });
  return {
    s, fire, unwatched, logs, known,
    set screen(v: string[]) { screen = v; },
    get reads() { return reads; },
    set fail(v: string | null) { fail = v; },
    tick: (ms: number) => { clock += ms; },
  };
}

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** What a browser holding nothing would show after applying `frames` in order. */
function replay(frames: Frame[]): string[] {
  let held: string[] = [];
  let digest: string | null = null;
  for (const f of frames) {
    expect(f.base).toBe(f.base === null ? null : digest);
    held = applyPatch(f.base === null ? [] : held, f.patch);
    expect(digestOf(held)).toBe(f.patch.digest);
    digest = f.patch.digest;
  }
  return held;
}

test("opening a pane pushes its screen whole, then only what moved, each against the last", async () => {
  const r = rig();
  const a = client();
  r.s.view(a.c, "hc.t1");
  await settle();
  expect(a.got.length).toBe(1);
  expect(a.got[0]!.base).toBeNull();

  r.screen = ["$ api-refactor", "done thinking"];
  r.fire.get("hc.t1")!();
  await settle();
  expect(a.got.length).toBe(2);
  expect(a.got[1]!.patch.changed).toEqual([[1, "done thinking"]]);
  expect(replay(a.got)).toEqual(["$ api-refactor", "done thinking"]);
});

test("a change that leaves the screen as it was sends nothing", async () => {
  const r = rig();
  const a = client();
  r.s.view(a.c, "hc.t1");
  await settle();
  r.fire.get("hc.t1")!();
  await settle();
  expect(a.got.length).toBe(1);
});

test("a burst of changes is one read while one is in flight, and its last state still arrives", async () => {
  const r = rig();
  const a = client();
  r.s.view(a.c, "hc.t1");
  await settle();
  const before = r.reads;
  for (let i = 0; i < 20; i++) { r.screen = ["$ api-refactor", `line ${i}`]; r.fire.get("hc.t1")!(); }
  await settle(20);
  expect(r.reads - before).toBeLessThanOrEqual(2);
  expect(replay(a.got)).toEqual(["$ api-refactor", "line 19"]);
});

test("a second viewer gets the last screen whole from memory, without a read", async () => {
  const r = rig();
  const a = client();
  const b = client();
  r.s.view(a.c, "hc.t1");
  await settle();
  const reads = r.reads;
  r.s.view(b.c, "hc.t1");
  expect(r.reads).toBe(reads);
  expect(b.got.length).toBe(1);
  expect(b.got[0]!.base).toBeNull();
  // Both then follow the same history.
  r.screen = ["$ api-refactor", "next"];
  r.fire.get("hc.t1")!();
  await settle();
  expect(replay(a.got)).toEqual(replay(b.got));
});

test("a heartbeat's repeated viewing sends nothing; a resync sends the screen whole to that client only", async () => {
  const r = rig();
  const a = client();
  const b = client();
  r.s.view(a.c, "hc.t1");
  r.s.view(b.c, "hc.t1");
  await settle();
  const [na, nb] = [a.got.length, b.got.length];
  r.s.view(a.c, "hc.t1");
  expect(a.got.length).toBe(na);
  r.s.view(a.c, "hc.t1", true);
  expect(a.got.length).toBe(na + 1);
  expect(a.got.at(-1)!.base).toBeNull();
  expect(b.got.length).toBe(nb);
});

test("the last viewer leaving, or closing, stops watching", async () => {
  const r = rig();
  const a = client();
  const b = client();
  r.s.view(a.c, "hc.t1");
  r.s.view(b.c, "hc.t1");
  await settle();
  r.s.view(a.c, null); // hidden or back to the list
  expect(r.unwatched).toEqual([]);
  r.s.drop(b.c);
  expect(r.unwatched).toEqual(["hc.t1"]);
  expect(r.s.size()).toBe(0);
});

test("nothing is pushed where the backend cannot watch, or for an id the store does not hold", async () => {
  const none = rig({ canWatch: false });
  const a = client();
  none.s.view(a.c, "hc.t1");
  await settle();
  expect(a.got).toEqual([]);
  expect(none.reads).toBe(0);

  const r = rig();
  const b = client();
  r.s.view(b.c, "hc.build-box/t9"); // hidden by the machine scope, or made up
  await settle();
  expect(b.got).toEqual([]);
  expect(r.fire.size).toBe(0);
});

test("a failing read is said once and retried after a pause, not in a loop", async () => {
  const r = rig();
  const a = client();
  r.fail = "the view of t1 ended";
  r.s.view(a.c, "hc.t1");
  await settle();
  const first = r.reads;
  // A retiring mirror reports changes; they must not read straight away.
  r.fire.get("hc.t1")!(); r.fire.get("hc.t1")!();
  await settle(10);
  expect(r.reads).toBe(first);
  expect(r.logs.filter((l) => l.includes("could not push")).length).toBe(1);

  r.fail = null;
  r.tick(60);
  await settle(70);
  expect(a.got.length).toBe(1);
  expect(r.logs.some((l) => l.includes("pushing hc.t1 again"))).toBe(true);
});

test("an agent that left the store ends its stream at the next change", async () => {
  const r = rig();
  const a = client();
  r.s.view(a.c, "hc.t1");
  await settle();
  r.known.delete("hc.t1");
  r.fire.get("hc.t1")!();
  await settle();
  expect(r.unwatched).toEqual(["hc.t1"]);
});
