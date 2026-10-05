import { expect, test } from "bun:test";
import { startRoute } from "@server/lifecycle/start";

const rec = { pid: 1, args: "paddock", port: 8787, version: "0.9.0", startedAt: 1 };

test("a paddock already serving is published, not duplicated", () => {
  expect(startRoute({ kind: "running", state: rec }, "absent").kind).toBe("publish-running");
  expect(startRoute({ kind: "running", state: { ...rec, managedBy: "systemd" } }, "active").kind)
    .toBe("publish-running");
});

test("nothing running and no service: start serves its own", () => {
  expect(startRoute({ kind: "none" }, "absent").kind).toBe("serve");
  expect(startRoute({ kind: "stale", state: rec }, "absent").kind).toBe("serve");
});

test("a registered service that is not serving yet is a refusal naming herdr", () => {
  // Serving our own here would fight the service for the port the moment
  // herdr comes up.
  const r = startRoute({ kind: "none" }, "registered");
  expect(r.kind).toBe("refuse");
  expect(r.kind === "refuse" && r.message).toContain("herdr");
  expect(r.kind === "refuse" && r.message).toContain("paddock local");
});

test("unreadable state falls through to serve, where preflight reports it", () => {
  expect(startRoute({ kind: "unreadable", error: "EACCES" }, "absent").kind).toBe("serve");
});
