// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported. Not a stylistic import order — moving this
// line breaks every test in the file.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { agent, render, settle, stubFetch, textsOf, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  // A stub left installed leaks into every test file that runs after this one.
  globalThis.fetch = realFetch;
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

/**
 * These cover the three defects that reached the browser in one cycle and were
 * all found by hand. Each is an EFFECT or a piece of wiring — reachable only
 * from a rendered component, which is why a repo with no DOM environment could
 * not have caught any of them.
 */

test("the pane paints the agent's output on mount", async () => {
  const { fn } = stubFetch({ "/output": () => screenOf(["first line", "second line"]) });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  expect(host.querySelector(".term-pane")?.textContent).toContain("first line");
  expect(host.querySelector(".term-pane")?.textContent).toContain("second line");
});

test("a failed read surfaces where the output would have been, never a blank pane", async () => {
  // A blank pane that means "the read failed" is indistinguishable from one
  // that means "this agent produced nothing".
  const fn = async () => new Response(JSON.stringify({ ok: false, detail: "herdr unreachable" }), {
    status: 502, headers: { "content-type": "application/json" },
  });
  globalThis.fetch = fn as unknown as typeof fetch;

  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  expect(host.querySelector(".term-error")?.textContent).toContain("herdr unreachable");
});

test("option buttons carry the agent's own labels, verbatim", async () => {
  // Labels are never reordered, summarised, or replaced with a generic
  // "Approve": the middle option of a permission prompt is routinely a
  // persistent grant, and collapsing it would be genuinely ambiguous.
  const { fn } = stubFetch({
    "/output": () => screenOf(["Do you want to proceed?"]),
    "/prompt": () => ({
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", selected: true },
        { key: "2", label: "Yes, and don't ask again for: curl *", selected: false },
        { key: "3", label: "No", selected: false },
      ],
      selected: "1. Yes",
      raw: "",
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  expect(textsOf(host, ".term-option")).toEqual([
    "Yes",
    "Yes, and don't ask again for: curl *",
    "No",
  ]);
});

test("the Enter preview shows what is selected, and FOLLOWS the cursor", async () => {
  // THE regression this suite exists for. The preview appeared on load and
  // vanished on the first arrow-down, because `/prompt` strips ANSI while
  // `/key` re-reads the live screen with colour kept — so it broke precisely
  // when it was protecting against arrowing one step too far.
  let pressed = 0;
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["menu"]),
    "/prompt": () => ({ question: "Proceed?", options: null, selected: "1. Yes", raw: "" }),
    "/key": () => {
      pressed++;
      return { ok: true, ...screenOf(["menu"]), selected: `${pressed + 1}. Option ${pressed + 1}` };
    },
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();
  expect(host.querySelector(".term-selected")?.textContent).toContain("1. Yes");

  const down = [...host.querySelectorAll(".term-key")].find((b) => b.textContent?.trim() === "↓");
  expect(down).toBeTruthy();
  (down as HTMLButtonElement).click();
  await settle();
  await settle();

  expect(calls.some((c) => c.url.includes("/key"))).toBe(true);
  expect(host.querySelector(".term-selected")?.textContent).toContain("2. Option 2");
});

test("the keypad is present in EVERY state, not only when blocked", async () => {
  // A pad that appeared and vanished as the agent's state changed would move
  // under the operator's thumb.
  for (const state of ["idle", "working", "done", "blocked"] as const) {
    const { fn } = stubFetch({
      "/output": () => screenOf(["out"]),
      "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
    });
    globalThis.fetch = fn as typeof fetch;
    const host = await render(<AgentTerminal agent={agent({ state })} onBack={() => {}} />);
    await settle();
    expect(textsOf(host, ".term-key")).toContain("⏎ Enter");
    await unmount();
  }
});

test("no option buttons are rendered when the parser refuses", async () => {
  // `options: null` is an outcome, not an error: the keypad is the floor, and
  // inventing buttons from an unparsed prompt is the one failure this project
  // refuses outright.
  const { fn } = stubFetch({
    "/output": () => screenOf(["menu"]),
    "/prompt": () => ({ question: null, options: null, selected: "3. Chat about this", raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  expect(host.querySelectorAll(".term-option")).toHaveLength(0);
  expect(host.querySelector(".term-selected")?.textContent).toContain("3. Chat about this");
});

test("the Enter preview is not repeated when a button already shows the selection", async () => {
  // Asked directly: are the option buttons and the arrow keys not duplicates?
  // The buttons are not — they cannot be off by one the way arrowing can. What
  // WAS duplicated is this preview restating an option the accent border
  // already marks, costing a bordered band and a rule on a phone screen.
  const { fn } = stubFetch({
    "/output": () => screenOf(["Do you want to proceed?"]),
    "/prompt": () => ({
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", selected: true },
        { key: "2", label: "No", selected: false },
      ],
      selected: "1. Yes",
      raw: "",
    }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();
  await settle();

  // The buttons are there, and the selected one is marked.
  expect(textsOf(host, ".term-option")).toEqual(["Yes", "No"]);
  expect(host.querySelector('.term-option[aria-pressed="true"]')?.textContent).toBe("Yes");
  // And the preview is not also there saying it again.
  //
  // Counted rather than `expect(el).toBeNull()`: on failure Bun serialises the
  // received value into the diff, and a happy-dom element drags the whole
  // window object in with it — the run stops being readable and takes minutes.
  // A number says the same thing and fails in one line.
  expect(host.querySelectorAll(".term-selected").length).toBe(0);
});
