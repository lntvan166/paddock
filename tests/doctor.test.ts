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
