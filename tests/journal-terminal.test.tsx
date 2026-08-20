// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { rememberHistory } from "@web/pane-cache";
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


test("a journal-hinted agent whose /history answers reconstruction falls back, not blank", async () => {
  // Correction 4, and the review's Critical finding: `hasJournal: true` is a
  // HINT that this pane is worth trying, not a guarantee the server can
  // actually read it — the session ref can be missing, the file can be gone,
  // even though the harness has an adapter. `source: "reconstruction"` is the
  // server saying so, and the pane must hand itself over to the reconstructed
  // path entirely rather than staying pinned to empty journal lines forever.
  //
  // Seeded well past HISTORY_PAGE (200) so the granted first page of
  // reconstruction does NOT exhaust `history.settled` — the button must stay
  // available afterward, showing the reconstruction's own remaining count.
  const seeded = Array.from({ length: 205 }, (_, i) => `old line ${i}`);
  rememberHistory("j4:p1", { settled: seeded, gaps: 0 });

  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/history": () => ({
      ok: true,
      lines: [],
      source: "reconstruction",
      hasMore: false,
      cursor: null,
      detail: "no session ref for this pane",
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j4:p1", hasJournal: true })} onBack={() => {}} />,
  );
  await settle();

  (host.querySelector(".term-earlier") as HTMLButtonElement).click();
  await settle();

  // The reconstructed lines rendered — the operator got SOMETHING for this
  // tap, not a permanently empty pane.
  expect(host.textContent).toContain("old line 204");
  // And the affordance survived: there is more reconstructed history behind
  // it, reported the way the reconstructed path always has.
  const earlier = host.querySelector(".term-earlier");
  expect(earlier).not.toBeNull();
  expect(earlier?.textContent).toContain("5 lines");
});

test("a rejected /history request is surfaced, not swallowed, and the button survives", async () => {
  // The Important finding: a transient failure is not "no more history".
  // `journalDone` must not latch, and the pane's main output must not be
  // replaced by the full-screen error banner either — this is a failed
  // ACTION, the same category as a failed key press or reply, not a failed
  // initial load.
  const fn = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/history")) {
      return new Response(JSON.stringify({ ok: false, detail: "herdr unreachable" }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(screenOf(["out"])), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = fn as unknown as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j5:p1", hasJournal: true })} onBack={() => {}} />,
  );
  await settle();

  (host.querySelector(".term-earlier") as HTMLButtonElement).click();
  await settle();

  expect(host.querySelector(".term-note.warn")?.textContent).toContain("herdr unreachable");
  // Not the full-load error path: the pane itself is still on screen.
  expect(host.querySelector(".term-error")).toBeNull();
  // And the operator can still try again — the affordance was not hidden.
  expect(host.querySelector(".term-earlier")).not.toBeNull();
});

test("a double-tap on Show earlier fires exactly one request", async () => {
  // The Minor finding: ordinary touch behaviour on a phone, and the naive
  // handler would fire the fetch twice against the same, not-yet-advanced
  // cursor — duplicating the page it prepends.
  const { calls, fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/history": () => ({
      ok: true,
      lines: ["you · 09:00", "one turn, fetched once", ""],
      source: "journal",
      hasMore: true,
      cursor: "42",
      detail: null,
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "j6:p1", hasJournal: true })} onBack={() => {}} />,
  );
  await settle();

  const button = host.querySelector(".term-earlier") as HTMLButtonElement;
  // Both fire before React has re-rendered to reflect `disabled` — the
  // synchronous ref guard, not the DOM attribute, is what this test pins.
  button.click();
  button.click();
  await settle();
  await settle();

  expect(calls.filter((c) => c.url.endsWith("/history")).length).toBe(1);
  const occurrences = (host.textContent?.match(/one turn, fetched once/g) ?? []).length;
  expect(occurrences).toBe(1);
});
