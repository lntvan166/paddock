import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentRow } from "@web/components/AgentRow";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

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
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} />);
  expect(host.textContent).toContain("blocked");
});
