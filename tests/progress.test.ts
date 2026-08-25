import { expect, test } from "bun:test";
import { bar } from "@server/term";
import { barProgress, lineProgress, makeProgress } from "@server/progress";

test("the bar is exactly the width it was asked for", () => {
  for (const f of [0, 0.25, 0.5, 0.99, 1]) {
    expect(bar(f, 20)).toHaveLength(20);
  }
});

test("empty, half and full read as they should", () => {
  expect(bar(0, 10)).toBe("[        ]");
  expect(bar(0.5, 10)).toBe("[===>    ]");
  expect(bar(1, 10)).toBe("[========]");
});

// A server that overshoots its own content-length must not crash an update.
test("a fraction outside 0..1 is clamped, not rejected", () => {
  expect(bar(1.5, 10)).toBe("[========]");
  expect(bar(-1, 10)).toBe("[        ]");
  expect(bar(Number.NaN, 10)).toBe("[        ]");
  expect(bar(Number.POSITIVE_INFINITY, 10)).toBe("[========]");
});

// Below eight columns there is no bar that means anything; the caller prints
// the percentage alone rather than drawing two brackets and calling it a bar.
test("too narrow to mean anything returns empty", () => {
  expect(bar(0.5, 7)).toBe("");
  expect(bar(0.5, 0)).toBe("");
  expect(bar(0.5, -10)).toBe("");
});

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
};

test("the line sink says the size once and nothing after", () => {
  const said: string[] = [];
  const p = lineProgress((s) => said.push(s));
  p.start("paddock-linux-x86_64", 87_031_808);
  p.advance(1_000_000);
  p.advance(1_000_000);
  p.done();
  expect(said).toEqual(["paddock: downloading paddock-linux-x86_64 (83 MB)"]);
});

// No content-length means no denominator to invent.
test("the line sink drops the size when it was never sent", () => {
  const said: string[] = [];
  const p = lineProgress((s) => said.push(s));
  p.start("paddock-linux-x86_64", null);
  expect(said).toEqual(["paddock: downloading paddock-linux-x86_64"]);
});

test("the bar sink draws percent, counts and rate", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 10 * 1_048_576);
  c.tick(1000);
  p.advance(5 * 1_048_576);
  const last = out[out.length - 1] ?? "";
  expect(last).toContain("50%");
  expect(last).toContain("5/10 MB");
  expect(last).toContain("MB/s");
  expect(last).toContain("[");
});

// An 83 MB download arrives in far more chunks than an eye can follow, and a
// redraw per chunk is a write syscall per chunk.
test("the bar redraws at most ten times a second", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 100 * 1_048_576);
  out.length = 0;
  for (let i = 0; i < 50; i++) { c.tick(10); p.advance(1_048_576); }
  // 500ms of ticks at 10ms each: five redraws, not fifty.
  expect(out.length).toBeLessThanOrEqual(6);
});

test("done erases the bar so the next line lands clean", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", 1_048_576);
  c.tick(1000); p.advance(1_048_576);
  p.done();
  expect(out[out.length - 1]).toBe("\r\x1b[2K");
});

// Width is read per redraw, not captured once: a terminal resized mid-download
// must not leave a tail of the previous, wider line.
test("width is re-read on every redraw", () => {
  const out: string[] = [];
  const c = clock();
  let cols = 80;
  const p = barProgress({ write: (s) => out.push(s), columns: () => cols, now: c.now });
  p.start("asset", 100 * 1_048_576);
  c.tick(1000); p.advance(50 * 1_048_576);
  const wide = (out[out.length - 1] ?? "").length;
  cols = 30;
  c.tick(1000); p.advance(1_048_576);
  expect((out[out.length - 1] ?? "").length).toBeLessThan(wide);
});

test("no content-length means a byte counter, not a fabricated percentage", () => {
  const out: string[] = [];
  const c = clock();
  const p = barProgress({ write: (s) => out.push(s), columns: () => 80, now: c.now });
  p.start("asset", null);
  c.tick(1000); p.advance(45 * 1_048_576);
  const last = out[out.length - 1] ?? "";
  expect(last).toContain("45 MB");
  expect(last).not.toContain("%");
});

test("a pipe gets lines and a tty gets a bar", () => {
  const said: string[] = [];
  const written: string[] = [];
  const stream = { isTTY: false, columns: 80, write: (s: string) => { written.push(s); } };
  makeProgress({ log: (s) => said.push(s), env: {}, stream }).start("asset", 1_048_576);
  expect(said).toHaveLength(1);
  expect(written).toHaveLength(0);

  said.length = 0; written.length = 0;
  makeProgress({
    log: (s) => said.push(s), env: {},
    stream: { ...stream, isTTY: true }, now: () => 0,
  }).start("asset", 1_048_576);
  expect(written.length).toBeGreaterThan(0);
});

// Strictly NO_COLOR governs colour, and an uncoloured bar would be defensible
// — but a redrawn line is motion, and the environments that set it are
// overwhelmingly the ones capturing output to a file.
test("NO_COLOR on a tty still gets lines, not a bar", () => {
  const said: string[] = [];
  const written: string[] = [];
  makeProgress({
    log: (s) => said.push(s),
    env: { NO_COLOR: "" },
    stream: { isTTY: true, columns: 80, write: (s: string) => { written.push(s); } },
  }).start("asset", 1_048_576);
  expect(said).toHaveLength(1);
  expect(written).toHaveLength(0);
});
