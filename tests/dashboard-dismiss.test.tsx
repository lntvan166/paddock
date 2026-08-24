import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentCard, showAcknowledge } from "@web/components/AgentCard";
import { sectionFor } from "@shared/types";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a finished agent lands in a section the dashboard renders as a card", () => {
  // The regression this guards: `done` + unacknowledged moved to its own
  // section, and the dashboard rendered that section as a bare row — which
  // dropped the Dismiss button, the only way to clear a finished agent from a
  // phone. Both sections that can contain a dismissable agent must be card
  // sections.
  const finished = agent({ state: "done", acknowledgedAt: null });
  expect(showAcknowledge(finished)).toBe(true);
  expect(["needs-you", "ready-unseen"]).toContain(sectionFor(finished));
});

test("the card actually offers Dismiss for a finished agent", async () => {
  const host = await render(
    <AgentCard agent={agent({ state: "done", acknowledgedAt: null })} now={0} />,
  );
  expect(host.textContent).toContain("Dismiss");
});

test("a blocked agent is not dismissable, since it has not finished", async () => {
  const host = await render(
    <AgentCard agent={agent({ state: "blocked" })} now={0} />,
  );
  expect(host.textContent).not.toContain("Dismiss");
});
