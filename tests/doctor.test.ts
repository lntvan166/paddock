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

test("a newer herdr also reports incompatible", () => {
  expect(doctorReport(19, { kind: "answered", protocol: 20 }).code).toBe(1);
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
