import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentRow } from "@web/components/AgentRow";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the row carries the harness tile", async () => {
  const host = await render(<AgentRow agent={agent({ harness: "codex" })} now={0} />);
  expect(host.querySelector(".tile")?.getAttribute("aria-label")).toBe("codex");
});

test("the state sits in the trailing column as a dot and a word, not on the tile", async () => {
  // The data-terminal redesign moved it off the tile's corner: a 7px dot on a
  // 28px tile was decoded, a word in the trailing column is read.
  const host = await render(<AgentRow agent={agent()} now={0} />);
  expect(host.querySelector(".tile-badge")).toBeNull();
  expect(host.querySelector(".row-trail .state-word .dot")).not.toBeNull();
});

test("the state is still carried as text, because colour is never the only channel", async () => {
  const host = await render(<AgentRow agent={agent({ state: "blocked" })} now={0} />);
  expect(host.querySelector(".state-word")?.textContent).toBe("Blocked");
});

test("a core agent's row carries the app mark", async () => {
  const host = await render(<AgentRow agent={agent({ origin: "core", agentId: "hc.t1" })} now={0} />);
  expect(host.querySelector(".origin-mark")?.textContent).toBe("app");
});

test("a herdr agent's row carries none", async () => {
  const host = await render(<AgentRow agent={agent()} now={0} />);
  expect(host.querySelector(".origin-mark")).toBeNull();
});

test("an error agent reads Error", async () => {
  const host = await render(<AgentRow agent={agent({ state: "error" })} now={0} />);
  expect(host.querySelector(".state-word")?.textContent).toBe("Error");
});
