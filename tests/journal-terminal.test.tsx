// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { agent, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  // A stub left installed leaks into every test file that runs after this one.
  globalThis.fetch = realFetch;
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

test("an agent with a journal fetches earlier lines instead of reading the cache", async () => {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/history": () => ({
      ok: true,
      lines: ["you · 13:04", "fix the flaky test", ""],
      source: "journal",
      hasMore: false,
      cursor: null,
      detail: null,
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j1:p1", hasJournal: true })} onBack={() => {}} />,
  );
  await settle();

  (host.querySelector(".term-earlier") as HTMLButtonElement).click();
  await settle();

  expect(calls.some((c) => c.url.endsWith("/history"))).toBe(true);
  expect(host.textContent).toContain("fix the flaky test");
});

test("an agent with no journal never calls the route", async () => {
  // Nothing regresses for a plain shell pane: it keeps the client-side
  // reconstruction it has today.
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["out"]),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j2:p1", hasJournal: false })} onBack={() => {}} />,
  );
  await settle();

  // There is no reconstructed history yet for a freshly-mounted agent, so
  // "Show earlier" is not even offered — nothing to click, and nothing
  // fetched either way.
  const earlier = host.querySelector(".term-earlier");
  if (earlier) (earlier as HTMLButtonElement).click();
  await settle();

  expect(calls.some((c) => c.url.endsWith("/history"))).toBe(false);
});

test("a journal line carrying a menu cannot render as a live option", async () => {
  // Belt and braces over the server's stripMenu: the blend has no divider, so
  // a stale "❯ 1. Yes" above the live screen would read as the live prompt.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/history": () => ({
      ok: true,
      lines: ["agent · 13:06", "❯ 1. Yes", ""],
      source: "journal",
      hasMore: false,
      cursor: null,
      detail: null,
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j3:p1", hasJournal: true })} onBack={() => {}} />,
  );
  await settle();

  (host.querySelector(".term-earlier") as HTMLButtonElement).click();
  await settle();

  expect(host.querySelectorAll("button.term-option")).toHaveLength(0);
});
