import { expect, test } from "bun:test";
import { qrMatrix, type QrMatrix } from "@server/qr";

// The real payload shape: a quick-tunnel URL with the code in the fragment.
const URL_ = "https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M";

// One 7x7 finder pattern, exactly as the QR spec fixes it: a dark ring, a
// light ring inside it, and a 3x3 dark core. Independent of the payload, so it
// asserts the ENCODING is structurally a QR rather than asserting our own
// output back at us.
const FINDER = [
  "#######",
  "#     #",
  "# ### #",
  "# ### #",
  "# ### #",
  "#     #",
  "#######",
];

const finderAt = (m: QrMatrix, top: number, left: number): string[] =>
  FINDER.map((_, r) =>
    FINDER[r]!.split("").map((_, c) => (m.isDark(top + r, left + c) ? "#" : " ")).join(""),
  );

test("the payload encodes as a version 3 symbol", () => {
  // Version 3 is 29 modules. This is a consequence of ECC level L: at level M
  // the same payload needs version 4 (33), whose modules are smaller on screen
  // and therefore slower to scan. If this fails at 33, the ECC level regressed.
  expect(qrMatrix(URL_).size).toBe(29);
});

test("all three finder patterns are present and correctly oriented", () => {
  const m = qrMatrix(URL_);
  expect(finderAt(m, 0, 0)).toEqual(FINDER);
  expect(finderAt(m, 0, m.size - 7)).toEqual(FINDER);
  expect(finderAt(m, m.size - 7, 0)).toEqual(FINDER);
});

test("there is no fourth finder — that corner carries data", () => {
  // A transposed or mirrored matrix would put one here. Cheap, and it catches
  // the single most likely rendering bug.
  const m = qrMatrix(URL_);
  expect(finderAt(m, m.size - 7, m.size - 7)).not.toEqual(FINDER);
});

test("the timing pattern alternates along row 6 and column 6", () => {
  // Spec-fixed: between the finders, row 6 and column 6 alternate dark/light
  // starting dark at index 8. Scanners use these to establish module pitch.
  const m = qrMatrix(URL_);
  for (let i = 8; i < m.size - 8; i++) {
    const shouldBeDark = i % 2 === 0;
    expect(m.isDark(6, i)).toBe(shouldBeDark);
    expect(m.isDark(i, 6)).toBe(shouldBeDark);
  }
});

test("the dark module is set", () => {
  // Always dark, at (4 * version + 9, 8) — (21, 8) for version 3.
  expect(qrMatrix(URL_).isDark(21, 8)).toBe(true);
});

// render() runs once a second and the payload changes only when the code
// rotates. Identity, not a counter: it proves the cache without exposing
// test-only API from the module.
test("the same payload returns the same object, a different one does not", () => {
  const a = qrMatrix(URL_);
  expect(qrMatrix(URL_)).toBe(a);
  const other = qrMatrix("https://quiet-harbor-8f31.trycloudflare.com/#ZZZZZZZZ");
  expect(other).not.toBe(a);
  // And the cache does not serve a stale matrix under a new payload.
  expect(qrMatrix(URL_)).not.toBe(other);
});

test("the quiet zone is NOT baked into the matrix", () => {
  // size is the bare module count. The 4-module margin belongs to the
  // renderer, which is what lets display.ts own the whole look.
  const m = qrMatrix(URL_);
  expect(m.size).toBe(29);
  // A matrix carrying its own quiet zone would be light in the top-left
  // corner; a bare one starts with a finder.
  expect(m.isDark(0, 0)).toBe(true);
});

// Captured from the pinned encoder, and verified by scanning the rendered
// symbol with a phone — not merely by the structural tests above, which cannot
// catch a changed data encoding or mask choice: every finder pattern would
// still be in place while the symbol resolved to something else, or to
// nothing.
//
// If this fails after a dependency bump, do NOT regenerate it blindly. Render
// the new output, scan it, and find out what changed first — a golden captured
// from a broken encoder pins the breakage.
const GOLDEN = [
  "#######.......##..##..#######",
  "#.....#.#####..##.#...#.....#",
  "#.###.#.#.###.#..##...#.###.#",
  "#.###.#....##.#.....#.#.###.#",
  "#.###.#.#.#..#.##...#.#.###.#",
  "#.....#.#...#.##.#.#..#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  "........###......##.#........",
  "##.#..##....###.#.##..###.##.",
  "..#..#..#..###..###...#..#..#",
  "#...#.###.#..#....####.#####.",
  "..#..#.#######.##.#.##.#..##.",
  "#####.#.#.#..##.###...#..#.##",
  ".##.#..#.##..#.....###.......",
  "###..####.#####.....##..#####",
  "#..#.#..#...##.###..#..###.#.",
  "#.##.#####..#...##..##.....#.",
  ".###.#..#...###.#.#..###.#..#",
  "#...#.##....###.....#..##..##",
  "..#.#..######.#..#.#.##....##",
  "#.######..##.####...#####.#..",
  "........#.......#####...#.###",
  "#######.#.#......##.#.#.#..#.",
  "#.....#....#.#.##...#...###..",
  "#.###.#..#..##.###..#####..##",
  "#.###.#.#....#....#.#.#.###..",
  "#.###.#...##..#..##.....###.#",
  "#.....#.###.###..##.##.....#.",
  "#######.#.###.#..#..##..#..#.",
];

test("the pinned encoder still produces the symbol that was verified to scan", () => {
  const m = qrMatrix(URL_);
  const actual = GOLDEN.map((_, r) =>
    GOLDEN[r]!.split("").map((_, c) => (m.isDark(r, c) ? "#" : ".")).join(""),
  );
  expect(actual).toEqual(GOLDEN);
});
