import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createActions,
  DEFAULT_READ_LINES,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_READ_LINES,
  MAX_WAIT_TIMEOUT_MS,
  readSourceFor,
  resolveReadLines,
  resolveWaitTimeoutMs,
} from "@server/herdr/actions";
import { HERDR_TIMEOUT_MS } from "@server/herdr/socket";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

// ---------------------------------------------------------------------------
// Response envelopes, copied from what herdr 0.8.0 (protocol 19) actually
// sends. Measured against a live socket, not inferred from the plan.
//
// This is the whole reason this file failed to catch the read bug: the fake
// used to answer `agent.read` with `{ text }`, a shape herdr has never sent,
// so it certified `res.text` — which is always `undefined` — as correct. A
// fake more permissive than the real dependency tests the code against the
// mistake instead of against reality, and every test below then passed while
// the output pane was empty for every agent in production.
//
// So these are helpers, not literals at call sites: a shape written out by
// hand at each `fakeHerdr(...)` is a shape that can drift one call site at a
// time. `tests/herdr-schema-drift.test.ts` pins the read envelope against the
// installed herdr's own schema; these keep the fake honest to it.
// ---------------------------------------------------------------------------

/** `agent.read` -> `{ type: "pane_read", read: { …, text } }`. */
function paneRead(text: string, source = "visible") {
  return {
    type: "pane_read",
    read: {
      pane_id: "p1", workspace_id: "w1", tab_id: "t1",
      source, format: "text", text, revision: 7, truncated: false,
    },
  };
}

/** `agent.send_keys` -> `{ type: "ok" }`, the bare acknowledgement. */
const OK_RESULT = { type: "ok" } as const;

/**
 * A minimal AgentInfo, for the two methods that echo the agent back.
 * Invented names only — never a real one.
 */
const AGENT_INFO = {
  agent: "claude", agent_status: "idle", cwd: "/path/to/repo",
  focused: false, name: "api-refactor", pane_id: "w1:p1", revision: 12,
  tab_id: "w1:t1", terminal_id: "term_1", workspace_id: "w1",
} as const;

/** `agent.prompt` -> `{ type: "agent_prompted", agent }`, NOT `{ type: "ok" }`. */
const PROMPTED_RESULT = { type: "agent_prompted", agent: AGENT_INFO } as const;

/**
 * `agent.wait` -> `{ type: "agent_info", agent }`, NOT `{ agent_status }`.
 * `waitUntilUnblocked` discards the body — it only cares that the call
 * resolved rather than erroring — but a fake that invents a field the real
 * herdr does not send is exactly how the read bug survived review.
 */
const WAITED_RESULT = { type: "agent_info", agent: AGENT_INFO } as const;

async function fakeHerdr(handler: (req: any) => object) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-actions-"));
  const path = join(dir, "h.sock");
  const seen: any[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(s, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          seen.push(req);
          s.write(JSON.stringify({ id: req.id, result: handler(req) }) + "\n");
          s.end(); // herdr closes after one response
        }
      },
    },
  });
  stop = () => server.stop(true);
  return { path, seen };
}

// The finding that shapes this module, re-measured against a live herdr
// 0.8.0 after the first version of it turned out to be wrong.
//
// The constraint is NOT "blocked". A coding agent renders on the terminal's
// alternate screen, which keeps no scrollback, so herdr recovers anything
// past the viewport by physically scrolling the pane — and refuses to while
// the agent is not idle. On a working agent with a 64-row viewport,
// `recent_unwrapped` succeeded at lines=63 and failed with `agent_not_idle`
// at lines=64. paddock cannot evaluate that boundary (no payload it reads
// carries the pane's row count) and its default read is 120 lines, so
// scrollback is safe in exactly one state.
test("only an idle agent is read from scrollback; every other state reads the viewport", () => {
  expect(readSourceFor("idle")).toBe("recent_unwrapped");
  expect(readSourceFor("working")).toBe("visible");
  expect(readSourceFor("blocked")).toBe("visible");
  // `done` is conservative rather than measured: herdr derives it from
  // idle-plus-unseen, but `pane.report_agent` cannot report `done`, so the
  // guess that it would pass the gate could not be checked on a live socket.
  // Assuming it would is what produced the rule this one replaces.
  expect(readSourceFor("done")).toBe("visible");
});

// Out of range clamps (the caller still gets as much output as paddock will
// serve); malformed falls back to the default (no inferable intent).
test("a line count is always a positive integer within the ceiling", () => {
  expect(resolveReadLines(40)).toBe(40);
  expect(resolveReadLines(1e9)).toBe(MAX_READ_LINES);
  expect(resolveReadLines(MAX_READ_LINES + 1)).toBe(MAX_READ_LINES);
  for (const bad of ["60", {}, [], null, undefined, NaN, Infinity, -5, 0, 2.5, true]) {
    expect(resolveReadLines(bad)).toBe(DEFAULT_READ_LINES);
  }
});

// Unreachable today — one caller, passing nothing — but identical in shape to
// `lines`, and clamping only the reachable one is the asymmetry that let the
// unvalidated `lines` through in the first place.
test("a wait budget is bounded the same way", () => {
  expect(resolveWaitTimeoutMs(5_000)).toBe(5_000);
  expect(resolveWaitTimeoutMs(10 * MAX_WAIT_TIMEOUT_MS)).toBe(MAX_WAIT_TIMEOUT_MS);
  for (const bad of ["5000", {}, null, undefined, NaN, -1, 0]) {
    expect(resolveWaitTimeoutMs(bad)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  }
});

test("readOutput clamps the line count it puts in the herdr params", async () => {
  const { path, seen } = await fakeHerdr(() => paneRead("x"));
  const actions = createActions(path);
  await actions.readOutput("w1:p1", "working", 1e9);
  expect(seen[0].params.lines).toBe(MAX_READ_LINES);
});

test("waitUntilUnblocked clamps the budget it asks herdr for", async () => {
  const { path, seen } = await fakeHerdr(() => WAITED_RESULT);
  await createActions(path).waitUntilUnblocked("w1:p1", 10 * MAX_WAIT_TIMEOUT_MS);
  expect(seen[0].params.timeout_ms).toBe(MAX_WAIT_TIMEOUT_MS);
});

test("readOutput asks herdr for the state-appropriate source", async () => {
  const { path, seen } = await fakeHerdr(() => paneRead("line one\nline two"));
  const out = await createActions(path).readOutput("w1:p1", "blocked", 40);
  expect(seen[0].method).toBe("agent.read");
  expect(seen[0].params.source).toBe("visible");
  expect(seen[0].params.lines).toBe(40);
  // The text comes off `result.read.text`. Reading `result.text` — the shape
  // this module used to declare — yields undefined, and so [] here.
  expect(out.lines).toEqual(["line one", "line two"]);
  expect(out.source).toBe("visible");
});

// The other branch of readSourceFor, end to end: an idle agent is the one
// case where paddock asks herdr to scroll, and the source it reports back
// has to be the one it actually asked for.
test("readOutput reads an idle agent from scrollback and reports that source", async () => {
  const { path, seen } = await fakeHerdr(() => paneRead("scrollback line", "recent_unwrapped"));
  const out = await createActions(path).readOutput("w1:p1", "idle", 40);
  expect(seen[0].params.source).toBe("recent_unwrapped");
  expect(out.lines).toEqual(["scrollback line"]);
  expect(out.source).toBe("recent_unwrapped");
});

// A genuinely empty pane must report no lines, not a sentinel blank one:
// "".split("\n") is [""], which would force every consumer to filter it out.
test("readOutput returns no lines for an empty pane, not a sentinel blank line", async () => {
  const { path } = await fakeHerdr(() => paneRead(""));
  const out = await createActions(path).readOutput("w1:p1", "working");
  expect(out.lines).toEqual([]);
});

test("readDetection always uses the detection source", async () => {
  const { path, seen } = await fakeHerdr(() => paneRead("snapshot", "detection"));
  expect(await createActions(path).readDetection("w1:p1")).toBe("snapshot");
  expect(seen[0].params.source).toBe("detection");
});

test("sendOptionKey sends the digit as a key", async () => {
  const { path, seen } = await fakeHerdr(() => OK_RESULT);
  await createActions(path).sendOptionKey("w1:p1", "2");
  expect(seen[0].method).toBe("agent.send_keys");
  expect(seen[0].params.keys).toEqual(["2"]);
});

test("sendReply submits text through agent.prompt", async () => {
  const { path, seen } = await fakeHerdr(() => PROMPTED_RESULT);
  await createActions(path).sendReply("w1:p1", "no, run the tests first");
  expect(seen[0].method).toBe("agent.prompt");
  expect(seen[0].params.text).toBe("no, run the tests first");
});

// Declining an option sends the agent to idle, NOT working. Waiting on
// `working` alone would report a false failure on every rejection.
test("waitUntilUnblocked waits on leaving blocked, not on reaching working", async () => {
  const { path, seen } = await fakeHerdr(() => WAITED_RESULT);
  await createActions(path).waitUntilUnblocked("w1:p1", 5_000);
  expect(seen[0].method).toBe("agent.wait");
  expect(seen[0].params.until.sort()).toEqual(["done", "idle", "working"]);
  expect(seen[0].params.timeout_ms).toBe(5_000);
});

// FINDING (post-review): request() defaults its own socket ceiling to
// HERDR_TIMEOUT_MS (10s) whenever it is called with no fourth argument. A
// waitUntilUnblocked call asking herdr for a longer budget (12s here) must
// pass a transport ceiling that also exceeds 12s — otherwise the socket
// guard fires at 10s while herdr is still inside the 12s it was told it
// could use, and a real approve/reject confirmation reads back as failed.
//
// This proves that real relationship — an answer arriving past
// HERDR_TIMEOUT_MS but within the requested budget still resolves — without
// a real ten-second sleep: every setTimeout is scaled by 1/50th for the
// duration of the test, so the SAME millisecond values that matter in
// production (HERDR_TIMEOUT_MS, and the budget past it) hold their real
// relationship while costing only a few hundred real milliseconds.
test("waitUntilUnblocked's transport ceiling exceeds the herdr-side budget, even past HERDR_TIMEOUT_MS", async () => {
  const SCALE = 50;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn as any, Math.max(1, (ms ?? 0) / SCALE), ...args)) as unknown as typeof setTimeout;

  try {
    const dir = await mkdtemp(join(tmpdir(), "paddock-actions-"));
    const path = join(dir, "h.sock");
    const server = Bun.listen({
      unix: path,
      socket: {
        data(s, chunk) {
          for (const line of chunk.toString().split("\n")) {
            if (!line.trim()) continue;
            const req = JSON.parse(line);
            // herdr answers 1s past HERDR_TIMEOUT_MS — inside the 12s budget
            // this call asks for, but past the 10s request() would silently
            // fall back to on a bare three-argument call.
            setTimeout(() => {
              s.write(JSON.stringify({ id: req.id, result: WAITED_RESULT }) + "\n");
              s.end();
            }, HERDR_TIMEOUT_MS + 1_000);
          }
        },
      },
    });
    stop = () => server.stop(true);

    await expect(
      createActions(path).waitUntilUnblocked("w1:p1", HERDR_TIMEOUT_MS + 2_000),
    ).resolves.toBeUndefined();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
