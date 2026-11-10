import { expect, test } from "bun:test";
import { paintToLines } from "@server/herdr-core/screen";
import { parseAnsiLine } from "@web/ansi";

/**
 * herdr-core's `terminal.read` is text only, so an app agent's screen reached
 * paddock without a single colour. The core's first paint to an observer
 * (`terminal.attach` with `observe: true`) does carry them, as a VT redraw;
 * `paintToLines` replays it and emits lines in the SGR the browser already
 * parses (`web/ansi.ts`).
 */

const enc = (s: string) => new TextEncoder().encode(s);

// The head of a real first paint, measured on a throwaway terminal (probe
// 2026-11-10): soft reset, mode resets, clear, tab stops, then the cells.
const MEASURED =
  "\x18\x1b[!p\x1b[?2026l\x1b[?1000l\x1b[?1049l\x1b[H\x1b[2J\x1b[3g\x1b[9G\x1bH\x1b[H" +
  "\x1b[0m\x1b[38;5;1mred\x1b[0m \x1b[0m\x1b[1m\x1b[38;5;2mbold-green\x1b[0m plain\x1b[2;1H\x1b[0m";

const spans = (line: string) => parseAnsiLine(line).filter((s) => s.text !== "");

test("a measured first paint keeps its colours and its text", async () => {
  const lines = await paintToLines(enc(MEASURED), 40, 3);
  const first = spans(lines[0]!);
  expect(first.map((s) => s.text).join("")).toBe("red bold-green plain");
  const red = first.find((s) => s.text === "red")!;
  const green = first.find((s) => s.text === "bold-green")!;
  expect(red.fg).toBeDefined();
  expect(green.fg).toBeDefined();
  expect(green.fg).not.toBe(red.fg);
  expect(green.bold).toBe(true);
  expect(first.find((s) => s.text.includes("plain"))!.fg).toBeUndefined();
});

test("truecolor, dim, italic, underline and inverse survive", async () => {
  const lines = await paintToLines(
    enc("\x1b[38;2;10;20;30mtc\x1b[0m \x1b[2md\x1b[0m \x1b[3mi\x1b[0m \x1b[4mu\x1b[0m \x1b[7mr\x1b[0m"),
    20, 1,
  );
  const s = spans(lines[0]!);
  expect(s.find((x) => x.text === "tc")!.fg).toBe("rgb(10,20,30)");
  expect(s.find((x) => x.text === "d")!.dim).toBe(true);
  expect(s.find((x) => x.text === "i")!.italic).toBe(true);
  expect(s.find((x) => x.text === "u")!.underline).toBe(true);
  // Carried as SGR 7: the browser parser resolves inverse itself.
  expect(lines[0]).toContain("\x1b[7m");
});

test("Vietnamese, wide characters and trailing blanks come out as text, not cells", async () => {
  const lines = await paintToLines(enc("thử thấy\r\n漢字ok\r\n"), 20, 3);
  expect(spans(lines[0]!).map((s) => s.text).join("")).toBe("thử thấy");
  expect(spans(lines[1]!).map((s) => s.text).join("")).toBe("漢字ok");
  // No padding to the terminal's width.
  expect(lines[0]!.endsWith(" ")).toBe(false);
});

test("history above the screen is kept, oldest first", async () => {
  const text = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\r\n");
  const lines = await paintToLines(enc(text), 20, 3, 10);
  const plain = lines.map((l) => spans(l).map((s) => s.text).join(""));
  expect(plain.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => `line ${i}`));
});

test("trailing empty rows of the screen are dropped", async () => {
  const lines = await paintToLines(enc("only\r\n"), 20, 6);
  expect(lines).toEqual([expect.stringContaining("only")]);
});
