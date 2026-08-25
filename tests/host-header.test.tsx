// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { HostHeader } from "@web/components/HostHeader";
import { agent, click, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the settings button is the entry point to #/settings", async () => {
  // A view reachable only by typing a hash into the address bar is not a
  // delivered feature — this proves a real, tappable entry point exists and
  // that it is wired to the settings route, not merely present as inert
  // decoration.
  // A plain `let` reassigned only inside the closure below narrows to its
  // initial value under TS control-flow analysis (it cannot prove the
  // closure ran) — a mutable holder object sidesteps that.
  const calls: string[] = [];
  const host = await render(
    <HostHeader
      hostId="dev-box" agents={[]}
      onOpenSettings={() => { calls.push("#/settings"); }}
      onOpenSpaces={() => {}}
    />,
  );

  const button = host.querySelector('button[aria-label="Settings"]') as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  await click(button);
  expect(calls).toEqual(["#/settings"]);
});

test("no Spaces control when there is no tree to show — a control that always errors is worse", async () => {
  // `--demo` has no herdr session, so `GET /api/spaces` 404s honestly and the
  // Spaces screen can only render its error state. The header offered the
  // button regardless, in the mode README screenshots come from. `routes.ts`
  // records the same defect class for `/ack`'s Dismiss button.
  //
  // Capability, never a demo flag and never anything about the device: `null`
  // here is the server having said it has no tree.
  const host = await render(
    <HostHeader
      hostId="dev-box" agents={[]}
      onOpenSettings={() => {}}
      onOpenSpaces={null}
    />,
  );

  expect(host.querySelector('button[aria-label="Spaces"]')).toBeNull();
  // The rest of the header is untouched — this hides one control, not a row.
  expect(host.querySelector('button[aria-label="Settings"]')).not.toBeNull();
});

test("the spaces button is the entry point to #/spaces", async () => {
  const calls: string[] = [];
  const host = await render(
    <HostHeader
      hostId="dev-box" agents={[]}
      onOpenSettings={() => {}}
      onOpenSpaces={() => { calls.push("#/spaces"); }}
    />,
  );

  const button = host.querySelector('button[aria-label="Spaces"]') as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  await click(button);
  expect(calls).toEqual(["#/spaces"]);

  // The label is DRAWN, not written. This button carried `▦` (U+25A6), whose
  // coverage in mobile system fonts paddock does not get to assume — and
  // AgentTerminal already records what a tofu box costs: a button whose label
  // is a rendering failure, here on the only route into #/spaces.
  expect(button!.querySelector("svg")).not.toBeNull();
  expect(button!.textContent).toBe("");
});

test("the summary counts by section, so it cannot contradict the section headers", async () => {
  // The defect this guards: counting `blocked` + `done` by raw state made the
  // header read "2 needs you" over sections reading "NEEDS YOU · 1" and
  // "READY · 1", and tallied an acknowledged finish — which renders under
  // Idle — as needing attention.
  const host = await render(
    <HostHeader
      hostId="dev-box"
      agents={[
        agent({ agentId: "a", name: "schema-migration", state: "blocked" }),
        agent({ agentId: "b", name: "lint-config", state: "done", acknowledgedAt: null }),
        agent({ agentId: "c", name: "api-refactor", state: "working" }),
      ]}
      onOpenSettings={() => {}}
      onOpenSpaces={() => {}}
    />,
  );
  const text = (host.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("1 needs you");
  expect(text).toContain("1 ready");
  expect(text).toContain("1 working");
});

test("an acknowledged finish is counted as idle, not as needing attention", async () => {
  const host = await render(
    <HostHeader
      hostId="dev-box"
      agents={[agent({ agentId: "d", name: "docs-cleanup", state: "done", acknowledgedAt: 1 })]}
      onOpenSettings={() => {}}
      onOpenSpaces={() => {}}
    />,
  );
  const text = (host.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("1 idle");
  expect(text).not.toContain("needs you");
});
