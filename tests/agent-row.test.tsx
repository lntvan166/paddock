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

// A finish the operator has already read sits in Idle, and its row has to say
// so: the core keeps reporting `done` after `herdr.seen` reaches the turn, and
// a row reading "Finished" under an Idle header told the operator three agents
// still had news after they had opened every one.
test("a core agent whose turn has been seen reads Idle, not Finished", async () => {
  const host = await render(
    <AgentRow agent={agent({ origin: "core", agentId: "hc.t1", state: "done", turn: 3, seen: 3 })} now={0} />,
  );
  expect(host.querySelector(".state-word")?.textContent).toBe("Idle");
});

test("a core agent with an unseen turn still reads Finished", async () => {
  const host = await render(
    <AgentRow agent={agent({ origin: "core", agentId: "hc.t1", state: "done", turn: 4, seen: 3 })} now={0} />,
  );
  expect(host.querySelector(".state-word")?.textContent).toBe("Finished");
});

test("a dismissed herdr finish reads Idle", async () => {
  const host = await render(<AgentRow agent={agent({ state: "done", acknowledgedAt: 1 })} now={0} />);
  expect(host.querySelector(".state-word")?.textContent).toBe("Idle");
});
