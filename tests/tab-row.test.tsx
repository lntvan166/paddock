import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { render, textsOf, unmount } from "./support/render";
import { TabRow } from "@web/components/TabRow";
import type { Tab } from "@shared/types";

afterEach(async () => { await unmount(); });

const pane = (paneId: string, over: Partial<Tab["panes"][number]> = {}): Tab["panes"][number] => ({
  paneId, harness: "claude", name: "api-refactor", title: "t",
  cwd: "/srv/project", state: "working", ...over,
});

const SINGLE: Tab = { tabId: "w1:t1", label: "migrate-up", panes: [pane("w1:p1")] };

const SPLIT: Tab = {
  tabId: "w2:t1", label: "backfill",
  panes: [pane("w2:p1"), pane("w2:p2", { paneId: "w2:p2", harness: null, name: null, title: "bash", cwd: "/srv/project/logs", state: null })],
};

test("a tab holding one pane IS that pane — the row opens it directly", async () => {
  // The whole reason a drill-down is affordable on a flat herd: every tab on
  // the machine this was measured against holds one pane, so every tab row is
  // one tap from an agent. If this regresses, the second level costs a tap and
  // buys nothing.
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  const row = host.querySelector("[data-tab-row]")!;
  expect(row.querySelector("a")?.getAttribute("href")).toBe("#/pane/w1%3Ap1");
  expect(host.querySelectorAll("[data-pane-row]").length).toBe(0);
});

test("a tab holding several panes shows them, and still opens its root pane", async () => {
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  expect(host.querySelector("[data-tab-row] .tab-head > a")?.getAttribute("href")).toBe("#/pane/w2%3Ap1");
  const subs = [...host.querySelectorAll("[data-pane-row] a")].map((a) => a.getAttribute("href"));
  expect(subs).toEqual(["#/pane/w2%3Ap1", "#/pane/w2%3Ap2"]);
});

test("a pane with no agent is shown, marked, and never given a state it lacks", async () => {
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  const shell = host.querySelector('[data-pane-row][data-state="none"]')!;
  expect(shell).not.toBeNull();
  expect(shell.querySelector(".dot-none")).not.toBeNull();
  expect(shell.textContent).toContain("no agent");
  expect(shell.textContent).not.toContain("idle");
});

test("a shell is labelled by its folder, never by its prompt", async () => {
  // §16.6. `title` on that fixture is "bash" and its cwd's last segment is
  // "logs" — so the label proves which field was read.
  const host = await render(<TabRow tab={SPLIT} onChanged={() => {}} />);
  expect(textsOf(host, ".pane-name")).toContain("logs");
});

test("an unnamed tab is labelled by its number, not left blank", async () => {
  // herdr returns a tab's NUMBER as a string when it has no label, so null
  // here means the operator never named it. The row still has to say
  // something, and the tabId is a herdr coordinate and correct and useless.
  const host = await render(
    <TabRow tab={{ tabId: "w3:t2", label: null, panes: [pane("w3:p1")] }} onChanged={() => {}} />,
  );
  expect(textsOf(host, "[data-tab-row] .tab-name")).toEqual(["api-refactor"]);
});

test("the tab's actions are reachable at rest, and announce the row's visible label", async () => {
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  const dots = [...host.querySelectorAll("[data-tab-row] button[aria-label]")]
    .filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("Actions"));
  expect(dots.length).toBe(1);
  expect(dots[0]!.hasAttribute("disabled")).toBe(false);
  expect(dots[0]!.getAttribute("aria-label")).toContain("migrate-up");
});

test("the ⋯ is a sibling of the link, never inside it", async () => {
  // A <button> inside an <a> is invalid HTML and unreachable by keyboard —
  // the trap RowActions and SpaceRow both carry notes about.
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  expect(host.querySelector("a button")).toBeNull();
});

test("a named tab shows the agent under it, because the two are different facts", async () => {
  // `migrate-up` is what the operator called the TAB; `api-refactor` is what
  // the agent calls itself. The row said only the first, so a tab renamed for
  // the work no longer told you which agent was doing it.
  const host = await render(<TabRow tab={SINGLE} onChanged={() => {}} />);
  expect(textsOf(host, ".tab-name")).toEqual(["migrate-up"]);
  expect(textsOf(host, ".tab-agent")).toEqual(["api-refactor"]);
});

test("an unnamed tab does not print the same name twice", async () => {
  // With no tab label the row already falls back to the pane's own label, so a
  // subtitle would repeat it verbatim. `paneIdentity` is nullable for exactly
  // this reason — "there is nothing to add" has to be expressible, or every
  // merged row grows a duplicate.
  const unnamed: Tab = { tabId: "w1:t9", label: null, panes: [pane("w1:p9")] };
  const host = await render(<TabRow tab={unnamed} onChanged={() => {}} />);
  expect(textsOf(host, ".tab-name")).toEqual(["api-refactor"]);
  expect(host.querySelectorAll(".tab-agent").length).toBe(0);
});

test("a shell pane contributes no agent line", async () => {
  // A pane with no harness is labelled by its folder, not by an agent name.
  // Rendering that folder as "the agent" would be a claim the tree cannot
  // support.
  const shell: Tab = {
    tabId: "w1:t8", label: "scratch",
    panes: [pane("w1:p8", { harness: null, name: null, title: "bash", cwd: "/srv/project", state: null })],
  };
  const host = await render(<TabRow tab={shell} onChanged={() => {}} />);
  expect(host.querySelectorAll(".tab-agent").length).toBe(0);
});
