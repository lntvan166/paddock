import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentCard, showAcknowledge } from "@web/components/AgentCard";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const hasDismiss = async (a: ReturnType<typeof agent>) => {
  const host = await render(<AgentCard agent={a} now={a.stateSince} />);
  return [...host.querySelectorAll("button")].some((b) => /dismiss/i.test(b.textContent ?? ""));
};

test("an idle core agent with an unseen turn offers Dismiss", async () => {
  const a = agent({ origin: "core", state: "idle", turn: 3, seen: 2 });
  expect(showAcknowledge(a)).toBe(true);
  expect(await hasDismiss(a)).toBe(true);
});

test("a done core agent whose seen has reached its turn offers none", async () => {
  const a = agent({ origin: "core", state: "done", turn: 3, seen: 3 });
  expect(showAcknowledge(a)).toBe(false);
  expect(await hasDismiss(a)).toBe(false);
});

test("a herdr done agent still offers Dismiss until acknowledged", async () => {
  expect(showAcknowledge(agent({ state: "done", acknowledgedAt: null }))).toBe(true);
  expect(showAcknowledge(agent({ state: "done", acknowledgedAt: 5 }))).toBe(false);
  expect(showAcknowledge(agent({ state: "idle" }))).toBe(false);
});

test("a done core agent with no turn offers no Dismiss: there is nothing it could write", async () => {
  const a = agent({ origin: "core", state: "done", turn: null, seen: null });
  expect(showAcknowledge(a)).toBe(false);
  expect(await hasDismiss(a)).toBe(false);
});
