// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { MachineToggle } from "@web/components/MachineToggle";
import { AgentRow } from "@web/components/AgentRow";
import { agent, click, render, settle, stubFetch, textsOf, unmount } from "./support/render";

/*
 * The Agents screen's machine switch and the machine mark. Invented machine
 * name (`build-box`) only.
 */

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; });

const settings = (machines: "local" | "all", envOverride: "local" | "all" | null = null) =>
  ({ agents: { machines, envOverride } });

const local = agent({ agentId: "hc.t1", origin: "core" });
const remote = agent({ agentId: "hc.build-box/t1", origin: "core", machine: "build-box" });

test("hidden when every agent is on this machine and all are shown: nothing to hide", async () => {
  const f = stubFetch({ "/api/settings": () => settings("all") });
  globalThis.fetch = f.fn as never;
  const el = await render(<MachineToggle agents={[local]} />);
  await settle();
  expect(el.querySelector("[data-field=machine-toggle]")).toBeNull();
});

test("shown when another machine's agent is listed, and a tap writes the scope at once", async () => {
  let scope: "local" | "all" = "all";
  const f = stubFetch({ "/api/settings": () => settings(scope) });
  globalThis.fetch = f.fn as never;
  const el = await render(<MachineToggle agents={[local, remote]} />);
  await settle();
  expect(el.querySelector("[data-field=machine-toggle]")).not.toBeNull();
  scope = "local";
  await click(el.querySelector('[role=radio][value="local"]') ?? [...el.querySelectorAll("[role=radio]")].find((n) => n.textContent === "This machine"));
  await settle();
  expect(f.calls.at(-1)).toEqual({ url: "/api/settings", body: { agents: { machines: "local" } } });
  // Still shown under `local` though nothing remote is listed any more: it is
  // the way back.
  const again = await render(<MachineToggle agents={[local]} />);
  await settle();
  expect(again.querySelector("[data-field=machine-toggle]")).not.toBeNull();
});

test("absent while PADDOCK_MACHINES decides", async () => {
  const f = stubFetch({ "/api/settings": () => settings("local", "local") });
  globalThis.fetch = f.fn as never;
  const el = await render(<MachineToggle agents={[local, remote]} />);
  await settle();
  expect(el.querySelector("[data-field=machine-toggle]")).toBeNull();
});

test("another machine's agent carries its machine's name; this machine's carries none", async () => {
  const el = await render(<div><AgentRow agent={remote} now={0} /><AgentRow agent={local} now={0} /></div>);
  expect(textsOf(el, "[data-machine]")).toEqual(["build-box"]);
});
