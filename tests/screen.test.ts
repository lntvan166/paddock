import { expect, test } from "bun:test";
import { applyPatch, diffScreens, digestOf } from "@shared/screen";

const screen = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const ESC = String.fromCharCode(27);

test("the digest is deterministic and identical for identical input", () => {
  expect(digestOf(["a", "b"])).toBe(digestOf(["a", "b"]));
  expect(digestOf([])).toBe(digestOf([]));
});

test("any change at all moves the digest, including a colour-only one", () => {
  const grey = [`${ESC}[38;2;136;136;136m* Working${ESC}[0m`];
  const orange = [`${ESC}[38;2;255;193;7m* Working${ESC}[0m`];
  // Identical visible text, different escape: this is the spinner changing
  // colour. Missing it would leave a stale screen on display, which is the
  // whole reason the digest is taken over the raw bytes and not the text.
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  expect(strip(grey[0]!)).toBe(strip(orange[0]!));
  expect(digestOf(grey)).not.toBe(digestOf(orange));
});

test("line ORDER matters, so a scrolled screen is never called unchanged", () => {
  expect(digestOf(["a", "b"])).not.toBe(digestOf(["b", "a"]));
});

test("a line boundary cannot be forged by embedding a separator", () => {
  // Naive joining lets ["a\nb"] and ["a","b"] collide.
  expect(digestOf(["a\nb"])).not.toBe(digestOf(["a", "b"]));
});

test("a patch reproduces the target screen exactly", () => {
  // THE invariant. If this can fail, the operator sees a screen that never
  // existed, which is worse than a slow one.
  const cases: [string[], string[]][] = [
    [screen(63), screen(63).map((l, i) => (i === 40 ? "spinner tick" : l))],
    [screen(63), screen(63, "y")],
    [screen(63), screen(20)],
    [screen(20), screen(63)],
    [[], screen(5)],
    [screen(5), []],
    [screen(10), screen(10)],
  ];
  for (const [prev, next] of cases) {
    expect(applyPatch(prev, diffScreens(prev, next))).toEqual(next);
  }
});

test("a one-line change produces a one-line patch", () => {
  // The whole point: a spinner frame must not cost a whole screen. Measured on
  // a live agent, the MEDIAN update changes exactly one line.
  const prev = screen(63);
  const next = prev.map((l, i) => (i === 62 ? "thinking, 1.2k tokens" : l));
  const patch = diffScreens(prev, next);
  expect(patch.changed).toHaveLength(1);
  expect(patch.changed[0]).toEqual([62, "thinking, 1.2k tokens"]);
  expect(patch.length).toBe(63);
});

test("a shrinking screen carries its new length, not just changed lines", () => {
  // Without `length`, the client would keep trailing lines the agent cleared.
  const patch = diffScreens(screen(63), screen(10));
  expect(patch.length).toBe(10);
  expect(applyPatch(screen(63), patch)).toHaveLength(10);
});

test("an identical screen produces an empty patch", () => {
  const s = screen(63);
  expect(diffScreens(s, s).changed).toEqual([]);
});

test("the patch digest matches the screen it reproduces", () => {
  // What lets the client self-check: apply, recompute, and ask for a full
  // screen on disagreement rather than displaying something corrupted.
  const prev = screen(63);
  const next = prev.map((l, i) => (i === 3 ? "changed" : l));
  const patch = diffScreens(prev, next);
  expect(patch.digest).toBe(digestOf(next));
  expect(digestOf(applyPatch(prev, patch))).toBe(patch.digest);
});

test("applying a patch does not mutate the screen it was applied to", () => {
  // The previous screen is still held in the cache and reused; mutating it
  // would corrupt the next comparison in a way no single test would catch.
  const prev = screen(10);
  const copy = [...prev];
  applyPatch(prev, diffScreens(prev, screen(10, "z")));
  expect(prev).toEqual(copy);
});

test("apply(prev, diff(prev, next)) === next for many random screens", () => {
  // Deterministic pseudo-random, so a failure is reproducible rather than a
  // once-in-a-hundred-runs mystery. The invariant is the whole safety story:
  // if a patch can ever produce a screen that is not `next`, the operator is
  // shown terminal output that never existed.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const line = () => Math.floor(rnd() * 8).toString(36).repeat(1 + Math.floor(rnd() * 5));
  const make = () => Array.from({ length: Math.floor(rnd() * 70) }, line);

  for (let i = 0; i < 400; i++) {
    const prev = make();
    const next = make();
    const patch = diffScreens(prev, next);
    expect(applyPatch(prev, patch)).toEqual(next);
    expect(digestOf(applyPatch(prev, patch))).toBe(patch.digest);
  }
});

test("the digest is two independently-seeded halves, not one 32-bit value", () => {
  // A single 32-bit digest collides by birthday at roughly 65k distinct
  // screens, which a long session reaches. A collision reports "unchanged"
  // for a screen that changed: the pane freezes with no error anywhere, which
  // is the worst failure this transport can have. Structure is asserted
  // because a collision itself cannot practically be provoked in a test.
  const d = digestOf(["some screen"]);
  const halves = d.split("-");
  expect(halves).toHaveLength(2);
  expect(halves[0]).not.toBe(halves[1]);
  expect(halves.every((h) => h.length > 0)).toBe(true);
});

test("lines are joined on a byte that cannot occur in terminal output", () => {
  // Joining on a space or a newline lets a scrolled screen hash equal to an
  // unscrolled one: ["a b"] and ["a","b"] would be indistinguishable.
  expect(digestOf(["a b"])).not.toBe(digestOf(["a", "b"]));
  expect(digestOf(["a\nb"])).not.toBe(digestOf(["a", "b"]));
  expect(digestOf(["a", "", "b"])).not.toBe(digestOf(["a", "b"]));
});
