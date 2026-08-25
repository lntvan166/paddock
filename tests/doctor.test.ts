import { expect, test } from "bun:test";
import { doctorReport, runDoctor } from "@server/doctor";

// Exit codes are the contract install.sh reads, so they are asserted directly:
// 0 compatible, 1 incompatible, 2 undetermined. The installer treats 2 as a
// friendly skip and must never fail on it, so collapsing 1 and 2 into "non-zero"
// would turn "herdr is not running yet" into "your install is broken".
test("a matching protocol reports compatible", () => {
  const r = doctorReport(19, { kind: "answered", protocol: 19, version: "0.8.0" });
  expect(r.code).toBe(0);
  expect(r.text).toContain("19");
  expect(r.text).toContain("0.8.0");
});

test("an older herdr reports incompatible, in the same words the server uses", () => {
  const r = doctorReport(19, { kind: "answered", protocol: 16 });
  expect(r.code).toBe(1);
  expect(r.text).toContain("older");
  expect(r.text).toContain("16");
});

// SUPERSEDED, deliberately. This asserted that a newer herdr also reports
// incompatible, which was the old policy: any drift, either direction, scored 1.
// It was measured wrong — herdr 0.8.0 → 0.8.2 moved the protocol 19 → 20 and
// changed nothing paddock reads, yet paddock refused to start and `doctor` told
// install.sh the install was broken. Only OLDER is incompatible now; the newer
// case is asserted just below, and the field-level check that replaced the
// version comparison lives in `src/server/herdr/shape.ts`.
test("a newer herdr is not scored as incompatible", () => {
  expect(doctorReport(19, { kind: "answered", protocol: 20 }).code).toBe(0);
});

// Distinct from incompatible: nothing was learned about herdr at all. Installing
// paddock before herdr, or while herdr is stopped, is a legitimate order.
test("an unreachable herdr is undetermined, not incompatible", () => {
  const r = doctorReport(19, { kind: "unreachable", message: "no herdr socket at /nope" });
  expect(r.code).toBe(2);
  expect(r.text).toContain("no herdr socket at /nope");
});

test("runDoctor reports compatible when the ping matches", async () => {
  const code = await runDoctor({
    socketPath: "/nope",
    expected: 19,
    ping: async () => ({ protocol: 19, version: "0.8.0" }),
    print: () => {},
  });
  expect(code).toBe(0);
});

test("runDoctor reports incompatible when the ping disagrees", async () => {
  const code = await runDoctor({
    socketPath: "/nope",
    expected: 19,
    ping: async () => ({ protocol: 16 }),
    print: () => {},
  });
  expect(code).toBe(1);
});

// A doctor that crashed on an unreachable socket would be useless in exactly
// the case it exists for.
test("runDoctor reports undetermined when the ping throws", async () => {
  const code = await runDoctor({
    socketPath: "/nope",
    expected: 19,
    ping: async () => { throw new Error("ENOENT"); },
    print: () => {},
  });
  expect(code).toBe(2);
});

// ---------------------------------------------------------------------------
// Direction matters. `install.sh` reads these codes — 0 compatible,
// 1 incompatible, 2 undetermined — so calling a newer herdr "incompatible"
// made a working setup look like a broken install.
// ---------------------------------------------------------------------------

test("a NEWER herdr is compatible, and says so without failing", () => {
  const r = doctorReport(19, { kind: "answered", protocol: 20 });
  expect(r.code).toBe(0);
  expect(r.text).toContain("20");
  expect(r.text).toContain("19");
  // Named as newer, not as a mismatch: the operator needs to know which side
  // is ahead, because only one of the two directions is actionable.
  expect(r.text).toMatch(/newer/i);
});

test("an OLDER herdr is still incompatible", () => {
  // The direction that genuinely lacks what paddock reads.
  const r = doctorReport(20, { kind: "answered", protocol: 19 });
  expect(r.code).toBe(1);
});

test("an exact match reports neither newer nor older", () => {
  const r = doctorReport(20, { kind: "answered", protocol: 20 });
  expect(r.code).toBe(0);
  expect(r.text).not.toMatch(/newer|older/i);
});

// The same hole as `checkProtocol`, and here it lies to install.sh: with two
// ordered comparisons, a non-numeric protocol satisfies neither, so doctor fell
// through to "looks compatible" with code 0 while printing
// "herdr reports undefined". install.sh treats 0 as all-good and prints
// nothing. The old `!==` scored it 1.
test("a non-numeric protocol is incompatible, not compatible", () => {
  const r = doctorReport(20, { kind: "answered", protocol: undefined as unknown as number });
  expect(r.code).toBe(1);
  expect(r.text).not.toContain("looks compatible");
});

test("a string protocol is incompatible too", () => {
  expect(doctorReport(20, { kind: "answered", protocol: "20" as unknown as number }).code).toBe(1);
});

test("doctor reports whether cloudflared is present", () => {
  const yes = doctorReport(3, { kind: "answered", protocol: 3 }, { cloudflared: "/somewhere/cloudflared" });
  expect(yes.text).toContain("cloudflared");
  expect(yes.text).toContain("/somewhere/cloudflared");

  const no = doctorReport(3, { kind: "answered", protocol: 3 }, { cloudflared: null });
  expect(no.text).toContain("cloudflared");
  expect(no.text).toMatch(/not installed/i);
  // Absent cloudflared is NOT a herdr problem: install.sh reads this code,
  // so it must not become non-zero over an optional binary.
  expect(no.code).toBe(0);
});

test("the cloudflared line is omitted when herdr is the problem", () => {
  // A protocol mismatch answers with herdr's own message and nothing else;
  // adding an unrelated line to it would bury the finding.
  const bad = doctorReport(3, { kind: "answered", protocol: 2 }, { cloudflared: null });
  expect(bad.code).toBe(1);
  expect(bad.text).not.toContain("cloudflared");
});

// The exit code already said which of three answers this was; the text did
// not. install.sh branches on the code and never reads the text, so the
// wording is free — but an operator reading the terminal gets the same
// three-way distinction the installer has always had.
test("the report's glyph matches its exit code", () => {
  expect(doctorReport(19, { kind: "answered", protocol: 19 }).text).toStartWith("✓");
  expect(doctorReport(19, { kind: "answered", protocol: 16 }).text).toStartWith("✗");
  expect(doctorReport(19, { kind: "unreachable", message: "no herdr socket at /nope" }).text)
    .toStartWith("⚠");
});

test("a newer herdr is ✓, matching its exit code of 0", () => {
  const r = doctorReport(19, { kind: "answered", protocol: 20 });
  expect(r.code).toBe(0);
  expect(r.text).toStartWith("✓");
});
