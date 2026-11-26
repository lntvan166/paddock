// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { MachinesSection } from "@web/components/settings/MachinesSection";
import { createApp } from "@server/routes";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";
import { render, settle, stubFetch, textsOf, unmount } from "./support/render";

/*
 * Settings → Machines lists each machine the Herdr app added, and its line.
 * Invented machine names only.
 */

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; });

const LIST = [
  { name: "build-box", host: "build-host", state: "connected", sinceMs: null, why: null },
  { name: "lab", host: "lab-host", state: "unreachable", sinceMs: 1_700_000_000_000, why: "ssh: connect timed out" },
];

test("each added machine is listed with its line, and a machine that is not connected says why", async () => {
  const { fn } = stubFetch({ "/api/machines": () => ({ machines: LIST }) });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<MachinesSection machines="all" setMachines={() => {}} envOverride={null} />);
  await settle();
  const rows = textsOf(host, "[data-field=machine-list] li");
  expect(rows[0]).toContain("build-box");
  expect(rows[0]).toContain("Connected");
  expect(rows[1]).toContain("Unreachable");
  expect(rows[1]).toContain("ssh: connect timed out");
  expect(host.querySelectorAll("[data-field=machine-list] .warn")).toHaveLength(1);
});

test("the route answers from the core, and says when no core is connected", async () => {
  const mk = (machines: () => Promise<unknown>) => createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    actions: {} as never, machines: machines as never,
  });
  const up = await mk(async () => LIST).request("/api/machines");
  expect(await up.json()).toEqual({ machines: LIST });
  const down = await mk(async () => null).request("/api/machines");
  expect(down.status).toBe(503);
});
