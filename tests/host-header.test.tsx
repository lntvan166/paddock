// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { HostHeader } from "@web/components/HostHeader";
import { render, unmount } from "./support/render";

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
      hostId="dev-box" agents={[]} latestKnown={null}
      onOpenSettings={() => { calls.push("#/settings"); }}
    />,
  );

  const button = host.querySelector('button[aria-label="Settings"]') as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  button?.click();
  expect(calls).toEqual(["#/settings"]);
});

test("a known newer version renders the dim update line, not a banner", async () => {
  const host = await render(
    <HostHeader hostId="dev-box" agents={[]} latestKnown="9.9.9" onOpenSettings={() => {}} />,
  );
  expect(host.textContent).toContain("paddock 9.9.9 available — run: paddock update");
});

test("no known newer version renders no update line at all", async () => {
  const host = await render(
    <HostHeader hostId="dev-box" agents={[]} latestKnown={null} onOpenSettings={() => {}} />,
  );
  expect(host.textContent).not.toContain("available — run: paddock update");
});
