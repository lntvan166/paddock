import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions, readSourceFor } from "@server/herdr/actions";

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

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

// The finding that shapes this module: recent_unwrapped FAILS on a blocked
// agent, because its prompt renders on the terminal's alternate screen.
test("a blocked agent is read from visible, everything else from recent_unwrapped", () => {
  expect(readSourceFor("blocked")).toBe("visible");
  expect(readSourceFor("working")).toBe("recent_unwrapped");
  expect(readSourceFor("idle")).toBe("recent_unwrapped");
  expect(readSourceFor("done")).toBe("recent_unwrapped");
});

test("readOutput asks herdr for the state-appropriate source", async () => {
  const { path, seen } = await fakeHerdr(() => ({ text: "line one\nline two" }));
  const out = await createActions(path).readOutput("w1:p1", "blocked", 40);
  expect(seen[0].method).toBe("agent.read");
  expect(seen[0].params.source).toBe("visible");
  expect(seen[0].params.lines).toBe(40);
  expect(out.lines).toEqual(["line one", "line two"]);
  expect(out.source).toBe("visible");
});

test("readDetection always uses the detection source", async () => {
  const { path, seen } = await fakeHerdr(() => ({ text: "snapshot" }));
  expect(await createActions(path).readDetection("w1:p1")).toBe("snapshot");
  expect(seen[0].params.source).toBe("detection");
});

test("sendOptionKey sends the digit as a key", async () => {
  const { path, seen } = await fakeHerdr(() => ({ type: "ok" }));
  await createActions(path).sendOptionKey("w1:p1", "2");
  expect(seen[0].method).toBe("agent.send_keys");
  expect(seen[0].params.keys).toEqual(["2"]);
});

test("sendReply submits text through agent.prompt", async () => {
  const { path, seen } = await fakeHerdr(() => ({ type: "ok" }));
  await createActions(path).sendReply("w1:p1", "no, run the tests first");
  expect(seen[0].method).toBe("agent.prompt");
  expect(seen[0].params.text).toBe("no, run the tests first");
});

// Declining an option sends the agent to idle, NOT working. Waiting on
// `working` alone would report a false failure on every rejection.
test("waitUntilUnblocked waits on leaving blocked, not on reaching working", async () => {
  const { path, seen } = await fakeHerdr(() => ({ agent_status: "idle" }));
  await createActions(path).waitUntilUnblocked("w1:p1", 5_000);
  expect(seen[0].method).toBe("agent.wait");
  expect(seen[0].params.until.sort()).toEqual(["done", "idle", "working"]);
  expect(seen[0].params.timeout_ms).toBe(5_000);
});
