import { expect, test } from "bun:test";
import { parseAnsi, parseAnsiLine } from "@web/ansi";

const ESC = "";

test("a line with no escapes is one unstyled span", () => {
  const spans = parseAnsiLine("plain text");
  expect(spans).toEqual([{ text: "plain text" }]);
});

test("an empty line still produces a span, so it occupies a row", () => {
  expect(parseAnsiLine("")).toEqual([{ text: "" }]);
});

test("truecolor foreground is parsed, which is what herdr actually sends", () => {
  // Measured against herdr 0.8.0: agent output is almost entirely 38;2;r;g;b.
  const spans = parseAnsiLine(`${ESC}[38;2;255;193;7mwarning${ESC}[0m`);
  expect(spans).toEqual([{ text: "warning", fg: "rgb(255,193,7)" }]);
});

test("truecolor background is parsed", () => {
  const spans = parseAnsiLine(`${ESC}[48;2;38;79;120msel${ESC}[0m`);
  expect(spans[0]).toEqual({ text: "sel", bg: "rgb(38,79,120)" });
});

test("an extended-colour sequence consumes its own parameters", () => {
  // THE classic SGR bug: 38;2;r;g;b read as independent codes also sets
  // whatever 2 and 4 mean (dim, underline). The RGB values must be swallowed.
  const spans = parseAnsiLine(`${ESC}[38;2;1;2;4mx${ESC}[0m`);
  expect(spans[0]).toEqual({ text: "x", fg: "rgb(1,2,4)" });
  expect(spans[0]!.dim).toBeUndefined();
  expect(spans[0]!.underline).toBeUndefined();

  // Same for the 256-colour form: `38;5;4` is blue, not blue-plus-underline.
  const idx = parseAnsiLine(`${ESC}[38;5;4my${ESC}[0m`);
  expect(idx[0]!.underline).toBeUndefined();
  expect(idx[0]!.fg).toBe("#2472c8");
});

test("bold, italic and their resets are tracked", () => {
  const spans = parseAnsiLine(`${ESC}[1mB${ESC}[22mN${ESC}[3mI${ESC}[23mN2`);
  expect(spans.map((s) => [s.text, s.bold ?? false, s.italic ?? false]))
    .toEqual([["B", true, false], ["N", false, false], ["I", false, true], ["N2", false, false]]);
});

test("reset clears every attribute at once", () => {
  const spans = parseAnsiLine(`${ESC}[1;4;38;2;9;9;9mstyled${ESC}[0mbare`);
  expect(spans[1]).toEqual({ text: "bare" });
});

test("a bare CSI m is a reset", () => {
  const spans = parseAnsiLine(`${ESC}[1mB${ESC}[mplain`);
  expect(spans[1]).toEqual({ text: "plain" });
});

test("non-SGR escapes are dropped, never printed as text", () => {
  // A cursor-movement sequence rendered literally is worse than no colour:
  // it puts mojibake in the middle of the transcript.
  const spans = parseAnsiLine(`${ESC}[2Kclean${ESC}[1;5Hhere`);
  expect(spans.map((s) => s.text).join("")).toBe("cleanhere");
  expect(spans.map((s) => s.text).join("")).not.toContain(ESC);
});

test("style carries ACROSS lines, because terminals do not reset at newline", () => {
  // A TUI that opens a colour on one row and closes it three rows later is
  // normal. Parsing each line from a clean slate loses the colour on every
  // row but the first.
  const lines = parseAnsi([`${ESC}[38;2;1;2;3mopen`, "still coloured", `closed${ESC}[0m`]);
  expect(lines[0]![0]!.fg).toBe("rgb(1,2,3)");
  expect(lines[1]![0]!.fg).toBe("rgb(1,2,3)");
  expect(lines[2]![0]!.fg).toBe("rgb(1,2,3)");
});

test("reverse video swaps foreground and background at paint time", () => {
  const spans = parseAnsiLine(`${ESC}[38;2;1;1;1;48;2;9;9;9;7mrev${ESC}[0m`);
  expect(spans[0]!.fg).toBe("rgb(9,9,9)");
  expect(spans[0]!.bg).toBe("rgb(1,1,1)");
});

test("the 256-colour cube and greyscale ramp resolve", () => {
  expect(parseAnsiLine(`${ESC}[38;5;0mx`)[0]!.fg).toBe("#000000");
  expect(parseAnsiLine(`${ESC}[38;5;196mx`)[0]!.fg).toBe("rgb(255,0,0)");
  expect(parseAnsiLine(`${ESC}[38;5;232mx`)[0]!.fg).toBe("rgb(8,8,8)");
});

test("basic and bright indexed colours resolve", () => {
  expect(parseAnsiLine(`${ESC}[31mx`)[0]!.fg).toBe("#cd3131");
  expect(parseAnsiLine(`${ESC}[91mx`)[0]!.fg).toBe("#f14c4c");
  expect(parseAnsiLine(`${ESC}[42mx`)[0]!.bg).toBe("#0dbc79");
});

test("real herdr output parses without leaking escapes into the text", () => {
  // The exact shape observed on the wire (invented content, per the
  // public-repo rule): a reset, a background run, then coloured text.
  const line =
    `${ESC}[0m${ESC}[48;2;55;55;55m  ${ESC}[0m` +
    `${ESC}[38;2;255;255;255m${ESC}[48;2;55;55;55mapi-refactor${ESC}[0m`;
  const spans = parseAnsiLine(line);
  const text = spans.map((s) => s.text).join("");
  expect(text).toBe("  api-refactor");
  expect(text).not.toContain(ESC);
  const coloured = spans.find((s) => s.text === "api-refactor");
  expect(coloured).toEqual({ text: "api-refactor", fg: "rgb(255,255,255)", bg: "rgb(55,55,55)" });
});
