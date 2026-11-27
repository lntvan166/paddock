import { expect, test } from "bun:test";
import { socketWriter } from "@server/socket-writer";

/*
 * Bun's `socket.write` writes what fits and returns the count. Measured: a
 * 240 KB `terminal.put` line was cut short and the core waited for the rest.
 */

function fakeSocket(budget: number[]) {
  const got: number[] = [];
  return {
    got,
    write(data: Uint8Array) {
      const n = Math.min(budget.shift() ?? data.length, data.length);
      got.push(...data.subarray(0, n));
      return n;
    },
  };
}

test("what the socket did not take is written on drain, in order, after what came before it", () => {
  const sock = fakeSocket([3, 0, 0]); // takes 3 bytes, then is full twice
  const w = socketWriter();
  w.attach(sock);
  w.write(new Uint8Array([1, 2, 3, 4, 5]));
  w.write(new Uint8Array([6, 7]));
  expect(sock.got).toEqual([1, 2, 3]);
  expect(w.queued()).toBe(4);
  w.drain(); // still full
  expect(sock.got).toEqual([1, 2, 3]);
  w.drain(); // room again
  expect(sock.got).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(w.queued()).toBe(0);
});

test("writes before the socket is attached wait for it", () => {
  const w = socketWriter();
  w.write(new Uint8Array([9]));
  const sock = fakeSocket([]);
  w.attach(sock);
  expect(sock.got).toEqual([9]);
});
