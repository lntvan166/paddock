import { expect, test } from "bun:test";
import { agentIdFromHash, paneHash } from "@shared/route";

test("the new form round-trips", () => {
  expect(agentIdFromHash(paneHash("w1:p1"))).toBe("w1:p1");
  expect(paneHash("w1:p1")).toBe("#/pane/w1%3Ap1");
});

test("links already sent to Telegram keep working forever", () => {
  expect(agentIdFromHash("#/agent/w1%3Ap1")).toBe("w1:p1");
});

test("a malformed escape lands on the list rather than crashing", () => {
  expect(agentIdFromHash("#/pane/%")).toBeNull();
  expect(agentIdFromHash("#/pane/")).toBeNull();
});
