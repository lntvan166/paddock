// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { HostHeader } from "@web/components/HostHeader";
import { agent, render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * Navigation left this header.
 *
 * Three tests lived here and have moved rather than been dropped:
 *
 * - "the settings button is the entry point to #/settings" and "the spaces
 *   button is the entry point to #/spaces" are now `tests/tab-bar.test.tsx`,
 *   which asserts three labelled destinations with exactly one marked current.
 *
 * - "no Spaces control when there is no tree to show — a control that always
 *   errors is worse" encoded a decision this branch REVISES, so its protection
 *   was moved rather than deleted. The header used to hide the Spaces control
 *   when `spacesAvailable` was false, because the destination 404s with no
 *   herdr session. A three-tab bar cannot drop to two — three is Material 3's
 *   floor, and Apple says not to hide a tab whose content is unavailable but
 *   to explain the emptiness instead. So the tab stays and the DESTINATION was
 *   made honest: `tests/spaces-view.test.tsx` asserts that with no capability
 *   the screen SAYS there is no herdr session, rather than erroring. The
 *   original objection was that the control was broken, and it no longer is.
 */
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
    />,
  );
  const text = (host.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("1 idle");
  expect(text).not.toContain("needs you");
});
