// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Finding, HostHeader } from "@web/components/HostHeader";
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
test("the finding names the agent that has waited longest-changed first, as the sections order it", async () => {
  // The defect the old counts sentence guarded: counting `blocked` + `done` by
  // raw state made the header contradict the sections under it. The finding
  // takes its agent from `groupAgents`, the same grouping the sections use.
  const host = await render(
    <Finding
      now={120_000}
      agents={[
        agent({ agentId: "a", name: "schema-migration", state: "blocked", stateSince: 0, stateSinceExact: true }),
        agent({ agentId: "b", name: "lint-config", state: "done", acknowledgedAt: null }),
        agent({ agentId: "c", name: "api-refactor", state: "working" }),
      ]}
    />,
  );
  const text = (host.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("schema-migration has waited 2m for you.");
  expect(text).not.toContain("lint-config");
});

test("with nobody blocked, the finding names the finished agent", async () => {
  const host = await render(
    <Finding
      now={300_000}
      agents={[agent({ agentId: "b", name: "lint-config", state: "done", acknowledgedAt: null, stateSince: 0, stateSinceExact: true })]}
    />,
  );
  expect((host.textContent ?? "").replace(/\s+/g, " ")).toContain("lint-config finished 5m ago.");
});

test("an acknowledged finish is counted as idle, not as needing attention", async () => {
  const host = await render(
    <Finding now={0} agents={[agent({ agentId: "d", name: "docs-cleanup", state: "done", acknowledgedAt: 1 })]} />,
  );
  const text = (host.textContent ?? "").replace(/\s+/g, " ");
  expect(text).toContain("1 idle");
  expect(text).toContain("Nothing needs you.");
  expect(text).not.toContain("finished");
});

test("the title is the screen's noun, and the host is a chip beside it", async () => {
  const host = await render(<HostHeader hostId="dev-box" />);
  expect(host.querySelector("h1")?.textContent).toBe("Agents");
  expect(host.querySelector(".host-chip")?.textContent).toBe("dev-box");
});

test("the default host id is not worth a chip", async () => {
  const host = await render(<HostHeader hostId="local" />);
  expect(host.querySelector(".host-chip")).toBeNull();
});

test("under a minute, the finding still reads as a sentence", async () => {
  // `elapsedLabel` says "now" under a minute; "has waited now for you" is not
  // English, and it was on screen the moment an agent stopped.
  const host = await render(
    <Finding now={10_000} agents={[agent({ agentId: "a", name: "perf-audit", state: "blocked", stateSince: 0, stateSinceExact: true })]} />,
  );
  expect((host.textContent ?? "").replace(/\s+/g, " ")).toContain("perf-audit just stopped and needs you.");
});
