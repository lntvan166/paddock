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
