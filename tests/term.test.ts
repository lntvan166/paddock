import { expect, test } from "bun:test";
import { glyph, paint, useColour } from "@server/term";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("NO_COLOR wins on presence, whatever its value", () => {
  expect(useColour({}, true)).toBe(true);
  expect(useColour({}, false)).toBe(false);
  expect(useColour({ NO_COLOR: "1" }, true)).toBe(false);
  // The convention is that the variable's PRESENCE is the signal, so an empty
  // value still disables colour.
  expect(useColour({ NO_COLOR: "" }, true)).toBe(false);
});

// The rule tunnel/display.ts already enforces, applied to hints: colour
// decorates and never informs, so a piped log and a terminal read identically.
test("stripping every escape from a painted line returns the plain one", () => {
  const line = "  to reach this from your phone: `paddock tunnel`";
  expect(strip(paint(line, true))).toBe(paint(line, false));
});

test("without colour, paint is the identity — the backticks are the delimiter", () => {
  const line = "  no herdr at all: `paddock --demo` runs with synthetic agents";
  expect(paint(line, false)).toBe(line);
});

test("a backticked span is emphasised and keeps its backticks", () => {
  const out = paint("run `paddock doctor` first", true);
  expect(out).toContain("\x1b[");
  expect(out).toContain("`paddock doctor`");
});

test("every span on a line is painted, not just the first", () => {
  const out = paint("`paddock status` shows it and `paddock stop` stops it", true);
  expect(strip(out)).toBe("`paddock status` shows it and `paddock stop` stops it");
  // Two opening sequences, one per span.
  expect(out.match(/\x1b\[1;36m/g)).toHaveLength(2);
});

test("a line with no backticks is untouched", () => {
  const line = "paddock: port 8787 is already in use";
  expect(paint(line, true)).toBe(line);
});

test("multi-line input is painted throughout", () => {
  const out = paint("first `a`\nsecond `b`", true);
  expect(strip(out)).toBe("first `a`\nsecond `b`");
  expect(out.match(/\x1b\[1;36m/g)).toHaveLength(2);
});

// An unmatched backtick is text, not the start of a span that swallows the rest
// of the line. Deliberately not "helpful" about it.
test("an unpaired backtick is left alone", () => {
  expect(paint("a stray ` here", true)).toBe("a stray ` here");
});

test("an empty span is not treated as a command", () => {
  expect(paint("nothing `` here", true)).toBe("nothing `` here");
});

// Colour is decided per stream. A run with stdout piped and stderr on the
// terminal must not write escape bytes into the file — `paddock status >
// out.txt` is an ordinary thing to type, and this is the assertion that keeps
// `say` from reading `stderr.isTTY` by mistake.
test("say and warn consult their OWN stream's tty-ness", async () => {
  const { say, warn } = await import("@server/term");
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const stdoutTty = process.stdout.isTTY;
  const stderrTty = process.stderr.isTTY;
  const noColor = "NO_COLOR" in process.env;
  try {
    if (noColor) delete process.env.NO_COLOR;
    console.log = (l: string) => void out.push(l);
    console.error = (l: string) => void err.push(l);
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

    say("piped `paddock status`");
    warn("terminal `paddock stop`");

    expect(out[0]).toBe("piped `paddock status`");
    expect(err[0]).toContain("\x1b[");
  } finally {
    console.log = log;
    console.error = error;
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTty, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: stderrTty, configurable: true });
    if (noColor) process.env.NO_COLOR = "";
  }
});

test("one glyph per outcome, and the third is 'could not decide'", () => {
  expect(glyph("yes")).toBe("✓");
  expect(glyph("no")).toBe("✗");
  expect(glyph("unknown")).toBe("⚠");
});

// The whole reason the glyph exists rather than colour alone: a pipe, a CI
// log, NO_COLOR and a colourblind reader all keep the distinction.
test("stripping every escape from a painted glyph line returns the plain one", () => {
  const line = "✓ paddock 0.2.0 — running";
  expect(strip(paint(line, true))).toBe(paint(line, false));
});

test("a leading glyph is coloured, and keeps its indentation", () => {
  const out = paint("  ⚠ paddock — could not read state (EACCES)", true);
  expect(out.startsWith("  \x1b[")).toBe(true);
  expect(strip(out)).toBe("  ⚠ paddock — could not read state (EACCES)");
});

test("each outcome gets its own colour, and only the glyph is painted", () => {
  expect(paint("✓ ok", true)).toContain("\x1b[32m✓");
  expect(paint("✗ no", true)).toContain("\x1b[31m✗");
  expect(paint("⚠ hm", true)).toContain("\x1b[33m⚠");
  // The text after the glyph carries no escapes of its own.
  expect(paint("✓ ok", true).endsWith(" ok")).toBe(true);
});

// Every line of a multi-line block, because doctor's report is one string.
test("a glyph is painted on every line of a block, not only the first", () => {
  const out = paint("✓ first\n⚠ second", true);
  expect(strip(out)).toBe("✓ first\n⚠ second");
  expect(out).toContain("\x1b[32m✓");
  expect(out).toContain("\x1b[33m⚠");
});

// A glyph mid-sentence is prose, not an outcome marker.
test("a glyph that is not leading is left alone", () => {
  expect(paint("the ✓ means compatible", true)).toBe("the ✓ means compatible");
});
