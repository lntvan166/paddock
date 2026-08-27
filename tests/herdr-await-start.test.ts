import { expect, test } from "bun:test";
import {
  connectWithWait,
  DEFAULT_WAIT_MS,
  resolveWaitMs,
} from "@server/herdr/await-start";
import { ProtocolMismatchError } from "@server/herdr/socket";
import type { SocketPathKind } from "@server/startup-errors";

const SOCKET = "/run/herdr/herdr.sock";
const NOW = 1_700_000_000_000;

/** ENOENT the way bun/node raise it — an errno error, not a bare Error. */
function errno(code: string): Error {
  const err = new Error(`connect ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * A clock the fake sleep drives. Nothing here waits in real time: the budget
 * is spent by sleeping, so a test asserting "gave up after 60s" runs instantly
 * and deterministically, with no dependence on how fast the machine is.
 */
function fakeClock() {
  let t = NOW;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    get total() {
      return slept.reduce((a, b) => a + b, 0);
    },
  };
}

/** A fixed backoff, so budget arithmetic in a test is readable. */
const fixed = (ms: number) => () => ms;

test("ready on the first attempt, with herdr's protocol", async () => {
  const clock = fakeClock();

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => 19,
    inspect: () => "socket",
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out).toEqual({ kind: "ready", protocol: 19 });
  expect(clock.slept).toEqual([]);
});

test("waits for a socket that is not there yet, then starts", async () => {
  const clock = fakeClock();
  let calls = 0;

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      calls++;
      if (calls < 3) throw errno("ENOENT");
      return 19;
    },
    inspect: () => "missing",
    backoff: fixed(500),
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out).toEqual({ kind: "ready", protocol: 19 });
  expect(calls).toBe(3);
  expect(clock.slept).toEqual([500, 500]);
});

test("a socket that is there but unserved is waited for too", async () => {
  const clock = fakeClock();
  let calls = 0;

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      calls++;
      if (calls < 2) throw errno("ECONNREFUSED");
      return 19;
    },
    inspect: () => "socket",
    backoff: fixed(500),
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out.kind).toBe("ready");
  expect(calls).toBe(2);
});

test("a protocol mismatch is fatal, and is never waited on", async () => {
  const clock = fakeClock();
  const err = new ProtocolMismatchError(19, 4);

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      throw err;
    },
    inspect: () => "socket",
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out).toEqual({ kind: "fatal", err, pathKind: "socket" });
  expect(clock.slept).toEqual([]);
});

test("a path that is not a socket is fatal, and is never waited on", async () => {
  const clock = fakeClock();

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      throw errno("ENOENT");
    },
    inspect: () => "not-a-socket",
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out.kind).toBe("fatal");
  expect(clock.slept).toEqual([]);
});

test("a socket that cannot be examined is fatal, and is never waited on", async () => {
  const clock = fakeClock();

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      throw errno("EACCES");
    },
    inspect: () => "unreadable",
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out.kind).toBe("fatal");
  expect(clock.slept).toEqual([]);
});

test("a failure paddock cannot diagnose is fatal, not retried", async () => {
  const clock = fakeClock();
  // No errno, and the socket is fine: this is a paddock bug or a herdr error
  // that already reads as a sentence. Retrying it would hide it for 60s and
  // then report it as "herdr never appeared", which is a different problem.
  const err = new Error("Cannot read properties of undefined (reading 'read')");

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      throw err;
    },
    inspect: () => "socket",
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out).toEqual({ kind: "fatal", err, pathKind: "socket" });
  expect(clock.slept).toEqual([]);
});

test("gives up once the budget is spent, reporting what it waited", async () => {
  const clock = fakeClock();
  let calls = 0;

  const out = await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      calls++;
      throw errno("ENOENT");
    },
    inspect: () => "missing",
    budgetMs: 10_000,
    backoff: fixed(4_000),
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(out.kind).toBe("gaveUp");
  if (out.kind !== "gaveUp") throw new Error("unreachable");
  expect(out.waitedMs).toBe(8_000);
  expect(out.attempts).toBe(3);
  expect(calls).toBe(3);
});

test("never sleeps past the budget", async () => {
  const clock = fakeClock();

  await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      throw errno("ENOENT");
    },
    inspect: () => "missing",
    budgetMs: 10_000,
    // A backoff longer than what is left must not be slept: the operator asked
    // for a bounded wait, and 15s of it would overshoot a 10s budget by half.
    backoff: fixed(15_000),
    sleep: clock.sleep,
    now: clock.now,
  });

  expect(clock.total).toBeLessThanOrEqual(10_000);
});

test("says it is waiting once, not once per attempt", async () => {
  const clock = fakeClock();
  const waiting: SocketPathKind[] = [];
  let calls = 0;

  await connectWithWait({
    socketPath: SOCKET,
    connect: async () => {
      calls++;
      if (calls < 4) throw errno("ENOENT");
      return 19;
    },
    inspect: () => "missing",
    backoff: fixed(500),
    sleep: clock.sleep,
    now: clock.now,
    onWaiting: (_err, pathKind) => waiting.push(pathKind),
  });

  expect(waiting).toEqual(["missing"]);
});

// The wait has to be reachable from a SPAWNED paddock, not only from a test
// that can inject a budget: the only way to exercise the real startup path is
// to run the binary, and `tests/startup-errors.test.ts` does exactly that.
// Without this seam, asserting the refusal for an absent socket costs a full
// wait per test.
test("the wait budget comes from the environment, defaulting to 60s", () => {
  expect(resolveWaitMs({})).toBe(DEFAULT_WAIT_MS);
  expect(resolveWaitMs({ PADDOCK_HERDR_WAIT_MS: "5000" })).toBe(5000);
});

test("a zero budget restores the immediate refusal", () => {
  expect(resolveWaitMs({ PADDOCK_HERDR_WAIT_MS: "0" })).toBe(0);
});

test("an unusable budget falls back to the default rather than to no wait", () => {
  // Same reasoning as `resolveHost`: a half-written env line must not silently
  // change behaviour. Falling back to 0 would quietly restore the very bug
  // this module exists to fix.
  for (const value of ["", "   ", "soon", "-1", "1.5e9x", "NaN"]) {
    expect(
      resolveWaitMs({ PADDOCK_HERDR_WAIT_MS: value }),
      `${JSON.stringify(value)} is not a budget`,
    ).toBe(DEFAULT_WAIT_MS);
  }
});
