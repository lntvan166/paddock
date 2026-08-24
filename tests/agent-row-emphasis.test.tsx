import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentRow, emphasisFor } from "@web/components/AgentRow";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("emphasis is derived from the section, not from the state", () => {
  // The ladder answers "how much of your attention does this GROUP deserve".
  // Deriving it from state would put the decision in two places the first time
  // a state maps somewhere new.
  expect(emphasisFor("needs-you")).toBe("alert");
  expect(emphasisFor("ready-unseen")).toBe("card");
  expect(emphasisFor("working")).toBe("bare");
  expect(emphasisFor("idle")).toBe("bare");
});

test("an alert row is a bordered, tinted card", async () => {
  // The container IS the second channel: urgency has to survive greyscale,
  // which a hue-only dot does not.
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} emphasis="alert" />);
  expect((host.querySelector(".row") as HTMLElement).dataset.emphasis).toBe("alert");
});

test("a working row stays bare, so the alert above it still stands out", async () => {
  const host = await render(<AgentRow agent={agent()} now={0} emphasis="bare" />);
  expect((host.querySelector(".row") as HTMLElement).dataset.emphasis).toBe("bare");
});

test("the row carries the harness tile", async () => {
  const host = await render(<AgentRow agent={agent({ harness: "codex" })} now={0} />);
  expect(host.querySelector(".tile")?.getAttribute("aria-label")).toBe("codex");
});

test("the status dot is overlaid on the tile, not placed beside it", async () => {
  // At 390px an overlaid dot costs nothing where a sibling dot costs a column.
  const host = await render(<AgentRow agent={agent()} now={0} />);
  expect(host.querySelector(".tile-badge .dot")).not.toBeNull();
});

test("the state is still carried as text, because colour is never the only channel", async () => {
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} emphasis="alert" />);
  expect(host.textContent).toContain("blocked");
});
