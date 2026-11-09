import { expect, test } from "bun:test";
import { CORE_PREFIX, coreId, isCoreId, rawCoreId } from "@shared/origin";
import { sectionFor } from "@shared/types";
import { agent } from "./support/render";

test("coreId round-trips and is never a herdr id", () => {
  expect(coreId("t7")).toBe("hc.t7");
  expect(CORE_PREFIX).toBe("hc.");
  expect(rawCoreId(coreId("t7"))).toBe("t7");
  expect(isCoreId(coreId("t7"))).toBe(true);
  expect(isCoreId("w1:p1")).toBe(false);
  expect(() => rawCoreId("w1:p1")).toThrow();
});

test("core and herdr agents with the same name keep distinct ids", () => {
  const h = agent({ agentId: "w1:p1", name: "api-refactor" });
  const c = agent({ agentId: coreId("w1:p1"), name: "api-refactor", origin: "core" });
  expect(h.agentId).not.toBe(c.agentId);
});

test("error is needs-you", () => {
  expect(sectionFor(agent({ state: "error" }))).toBe("needs-you");
});

test("a core idle agent with turn above seen is ready", () => {
  const core = { origin: "core" as const, state: "idle" as const };
  expect(sectionFor(agent({ ...core, turn: 5, seen: 3 }))).toBe("ready-unseen");
  expect(sectionFor(agent({ ...core, turn: 3, seen: 3 }))).toBe("idle");
  expect(sectionFor(agent({ ...core, turn: null, seen: 3 }))).toBe("idle");
  expect(sectionFor(agent({ origin: "core", state: "working", turn: 5, seen: 3 }))).toBe("working");
  expect(sectionFor(agent({ origin: "core", state: "blocked", turn: 5, seen: 3 }))).toBe("needs-you");
});

test("a core agent with no seen label uses the herdr rule", () => {
  expect(sectionFor(agent({ origin: "core", state: "idle", turn: 5, seen: null }))).toBe("idle");
  expect(sectionFor(agent({ origin: "core", state: "done", seen: null }))).toBe("ready-unseen");
});

test("a herdr agent is unchanged", () => {
  expect(sectionFor(agent({ state: "idle" }))).toBe("idle");
  expect(sectionFor(agent({ state: "done" }))).toBe("ready-unseen");
  expect(sectionFor(agent({ state: "done", acknowledgedAt: 1 }))).toBe("idle");
  expect(sectionFor(agent({ state: "idle", turn: 9, seen: 1 }))).toBe("idle");
});
