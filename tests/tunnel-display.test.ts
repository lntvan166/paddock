import { expect, test } from "bun:test";
import { render, useColour, type DisplayState } from "@server/tunnel/display";
import { qrMatrix } from "@server/qr";
import { QR_ROWS_THRESHOLD, FULL_ROWS_THRESHOLD } from "@server/tunnel/run";

const T0 = 1_700_000_000_000;
const state = (over: Partial<DisplayState> = {}): DisplayState => ({
  url: "https://quiet-harbor-8f31.trycloudflare.com",
  code: "4F7KQP2M",
  codeExpiresAt: T0 + 372_000,
  paired: 1,
  startedAt: T0 - 1_380_000,
  deadline: null,
  now: T0,
  qr: null,
  compact: false,
  ...over,
});

test("the block carries the URL, the dashed code and both clocks", () => {
  const out = render(state(), false);
  expect(out).toContain("https://quiet-harbor-8f31.trycloudflare.com");
  expect(out).toContain("4F7K-QP2M");
  expect(out).toContain("23m 0s elapsed");
  expect(out).toContain("expires in 6m 12s");
});

test("the paired count is shown, and reads naturally for one", () => {
  expect(render(state({ paired: 0 }), false)).toContain("paired: no devices yet");
  expect(render(state({ paired: 1 }), false)).toContain("paired: 1 device");
  expect(render(state({ paired: 3 }), false)).toContain("paired: 3 devices");
});

test("the warning names what the code is protecting", () => {
  const out = render(state(), false);
  expect(out).toMatch(/public/i);
  expect(out).toContain("docs/deploy-cloudflare.md");
});

test("a deadline adds a closing clock, and its absence removes it", () => {
  expect(render(state({ deadline: T0 + 4_320_000 }), false)).toContain("closes in 1h 12m");
  expect(render(state(), false)).not.toContain("closes in");
});

test("colour decorates and never informs", () => {
  const ESC = /\x1b\[[0-9;]*m/g;

  // Table-driven: verify strip-equality across all branches that render() exercises.
  const cases = [
    { name: "paired: 0 (no devices)", overrides: { paired: 0 } },
    { name: "paired: 1 (1 device)", overrides: { paired: 1 } },
    { name: "paired: 3 (plural)", overrides: { paired: 3 } },
    { name: "deadline: null (no closes line)", overrides: { deadline: null } },
    { name: "deadline: set (closes line)", overrides: { deadline: T0 + 4_320_000 } },
    // The QR is the one thing on screen whose colour is not decoration —
    // forced black-on-white is what stops it rendering inverted. It stays
    // inside the rule because the GLYPHS carry the symbol and survive
    // stripping; only the escapes differ between these two renders.
    {
      name: "qr present",
      overrides: { qr: qrMatrix("https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M") },
    },
    {
      name: "qr present, compact",
      overrides: {
        qr: qrMatrix("https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M"),
        compact: true,
      },
    },
  ];

  for (const { name, overrides } of cases) {
    const plain = render(state(overrides), false);
    const colour = render(state(overrides), true);
    expect(plain).not.toMatch(ESC);
    expect(colour).toMatch(ESC);
    // Stripping every escape from the coloured render gives the plain one back,
    // so a piped log and a terminal read identically.
    try {
      expect(colour.replace(ESC, "")).toBe(plain);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
});

test("colour is off unless stdout is a tty, and NO_COLOR always wins", () => {
  expect(useColour({}, true)).toBe(true);
  expect(useColour({}, false)).toBe(false);
  expect(useColour({ NO_COLOR: "1" }, true)).toBe(false);
  // The convention is that the variable's PRESENCE is the signal.
  expect(useColour({ NO_COLOR: "" }, true)).toBe(false);
});

const QR = qrMatrix("https://quiet-harbor-8f31.trycloudflare.com/#4F7KQP2M");

test("the QR sits between the URL and the code, in both layouts", () => {
  // One block order, so the QR does not move when a terminal is resized.
  for (const compact of [false, true]) {
    const lines = render(state({ qr: QR, compact }), false).split("\n");
    const url = lines.findIndex((l) => l.includes("trycloudflare.com"));
    const qr = lines.findIndex((l) => l.includes("█") || l.includes("▀") || l.includes("▄"));
    const code = lines.findIndex((l) => l.includes("4F7K-QP2M"));
    expect(url).toBeGreaterThanOrEqual(0);
    expect(qr).toBeGreaterThan(url);
    expect(code).toBeGreaterThan(qr);
  }
});

test("compact drops the prose and keeps the state", () => {
  const lines = render(state({ qr: QR, compact: true, deadline: T0 + 4_320_000 }), false);
  // Gone: the warning paragraph and the ^C hint.
  expect(lines).not.toContain("a quick tunnel is public");
  expect(lines).not.toContain("deploy-cloudflare.md");
  expect(lines).not.toContain("^C to close");
  // Kept: the two lines that change while an operator watches.
  expect(lines).toContain("paired:");
  expect(lines).toContain("closes in");
  expect(lines).toContain("4F7K-QP2M");
  expect(lines).toContain("trycloudflare.com");
});

test("the full layout keeps everything it kept before", () => {
  const lines = render(state({ qr: QR, compact: false }), false);
  expect(lines).toContain("a quick tunnel is public");
  expect(lines).toContain("deploy-cloudflare.md");
  expect(lines).toContain("^C to close");
});

test("compact without a QR is still the trimmed block", () => {
  // compact is a HEIGHT decision and qr is a width/tty one; they are
  // independent inputs and must not be entangled.
  const lines = render(state({ qr: null, compact: true }), false);
  expect(lines).not.toContain("^C to close");
  expect(lines).toContain("4F7K-QP2M");
  expect(lines).not.toMatch(/[█▀▄]/);
});

test("no QR renders exactly the block that shipped before", () => {
  const lines = render(state({ qr: null, compact: false }), false);
  expect(lines).not.toMatch(/[█▀▄]/);
  expect(lines).toContain("a quick tunnel is public");
  expect(lines).toContain("^C to close");
});

// The thresholds in run.ts are only correct if the block they admit actually
// FITS. `draw` writes `${block()}\n`, so a block of N lines occupies N + 1
// terminal rows — without that trailing row the block scrolls and the
// once-a-second \x1b[H\x1b[J repaint tears. This is the assertion that ties
// render()'s real output to the numbers wantsQr/wantsCompact are built on.
test("each layout fits the terminal its threshold admits", () => {
  const withDeadline = { deadline: T0 + 4_320_000 };

  // Trimmed: the smallest terminal wantsQr accepts must hold the block AND the
  // trailing newline.
  const trimmed = render(state({ qr: QR, compact: true, ...withDeadline }), false);
  expect(trimmed.split("\n")).toHaveLength(26);
  expect(trimmed.split("\n").length + 1).toBeLessThanOrEqual(QR_ROWS_THRESHOLD);

  // Full: same, at the taller threshold.
  const full = render(state({ qr: QR, compact: false, ...withDeadline }), false);
  expect(full.split("\n")).toHaveLength(33);
  expect(full.split("\n").length + 1).toBeLessThanOrEqual(FULL_ROWS_THRESHOLD);
});
