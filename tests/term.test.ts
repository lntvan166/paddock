import { expect, test } from "bun:test";
import { paint, useColour } from "@server/term";

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
