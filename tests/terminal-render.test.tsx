// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported. Not a stylistic import order — moving this
// line breaks every test in the file.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { agent, render, settle, stubFetch, textsOf, unmount } from "./support/render";

const realFetch = globalThis.fetch;
/** Every pref this file writes. Cleared after each test for the reason
 *  `tests/settings-view.test.tsx` records: Bun runs every test file in ONE
 *  process, so a key left set here is read as an operator's stored choice by
 *  `tests/prefs.test.ts` and by any later file that calls `readPrefs()`. */
const PREF_KEYS = ["paddock.term.keypad", "paddock.term.keypad.auto"];

afterEach(async () => {
  await unmount();
  // A stub left installed leaks into every test file that runs after this one.
  globalThis.fetch = realFetch;
  for (const k of PREF_KEYS) localStorage.removeItem(k);
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

  expect(textsOf(host, ".term-option-label")).toEqual([
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
  expect(textsOf(host, ".term-option-label")).toEqual(["Yes", "No"]);
  expect(host.querySelector('.term-option[aria-pressed="true"] .term-option-label')?.textContent).toBe("Yes");
  // And the preview is not also there saying it again.
  //
  // Counted rather than `expect(el).toBeNull()`: on failure Bun serialises the
  // received value into the diff, and a happy-dom element drags the whole
  // window object in with it — the run stops being readable and takes minutes.
  // A number says the same thing and fails in one line.
  expect(host.querySelectorAll(".term-selected").length).toBe(0);
});

test("the secondary key row collapses, and the committing keys never do", async () => {
  // Asked for: a collapse button, with the pad visible by default. Only the
  // second row goes — up/down/Enter are how a prompt is answered, and the pad
  // is documented as present in every state for exactly that reason.
  localStorage.setItem("paddock.term.keypad", "compact");
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "working" })} onBack={() => {}} />);
  await settle();

  expect(host.querySelectorAll(".term-keys-secondary").length).toBe(0);
  // The row that commits an answer is still there.
  expect(textsOf(host, ".term-keys-primary .term-key")).toEqual(["↑", "↓", "⏎ Enter"]);
});

test("a blocked agent opens a collapsed pad, and cannot close an open one", async () => {
  // Expand-only. Revealing a key the operator is about to want costs nothing;
  // taking one away mid-tap is the hazard the always-present rule exists for.
  localStorage.setItem("paddock.term.keypad", "compact");
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  expect(host.querySelectorAll(".term-keys-secondary").length).toBe(1);
  // And the operator's stored choice is untouched — the agent opened it, which
  // is not the same as the operator choosing to.
  expect(localStorage.getItem("paddock.term.keypad")).toBe("compact");
});

test("auto-expand can be declined, and then a blocked agent leaves the pad alone", async () => {
  localStorage.setItem("paddock.term.keypad", "compact");
  localStorage.setItem("paddock.term.keypad.auto", "0");
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  expect(host.querySelectorAll(".term-keys-secondary").length).toBe(0);
});

test("the header spends its width on the agent's name, not on labels", async () => {
  // Reported from a phone: the title bar had grown enough buttons that the
  // agent's own name — the reason the screen exists — was squeezed out. So the
  // two labels that carried nothing a glyph could not are gone: the back
  // button's word, and the state spelled out beside a dot that already says it.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(
    <AgentTerminal agent={agent({ name: "schema-migration", state: "working" })} onBack={() => {}} />,
  );
  await settle();

  // The name is present and is the only prose in the title block.
  expect(host.querySelector(".term-title strong")?.textContent).toBe("schema-migration");
  // The state is a dot, and for a working agent the word is only for
  // assistive tech.
  expect(host.querySelector(".term-title .sr-only")?.textContent).toBe("working");
  expect(host.querySelectorAll(".term-title .term-state").length).toBe(0);
  expect(host.querySelector(".term-header")?.textContent).not.toContain("Agents");

  // Wrap and Keys are separate controls. Sharing a class made a selector
  // written for one silently match the other, by DOM order rather than intent.
  expect(host.querySelectorAll(".term-wrap-toggle").length).toBe(1);
  expect(host.querySelectorAll(".term-keys-toggle").length).toBe(1);
  // No aria-label: the visible text IS the accessible name, and `aria-pressed`
  // carries the state. An aria-label that does not contain the visible label is
  // a WCAG 2.5.3 hazard for voice control, and it bought nothing here.
  expect(host.querySelector(".term-keys-toggle")?.textContent?.trim()).toBe("Keys");
  expect(host.querySelector(".term-keys-toggle")?.hasAttribute("aria-label")).toBe(false);
});

test("after an arrow tap the border moves and the preview reappears", async () => {
  // THE regression this file failed to catch, shipped in v0.6.0. The dedupe
  // guard tested `options.some(o => o.selected)`, and `options` is fetched once
  // per blocked agent while `press()` patches only `selected` — so the frozen
  // flag kept the preview hidden for the whole prompt, while the accent border
  // stayed on the option the cursor had left. One wrong signal and no right
  // ones, in the mechanism that exists to stop the operator arrowing one step
  // too far into a persistent grant.
  //
  // `prompt.selected` is now the single fresh source for both.
  const { fn } = stubFetch({
    "/output": () => screenOf(["menu"]),
    "/prompt": () => ({
      question: "Do you want to proceed?",
      options: [
        { key: "1", label: "Yes", selected: true },
        { key: "2", label: "No", selected: false },
      ],
      selected: "1. Yes",
      raw: "",
    }),
    // The live screen after ↓: the cursor is on option 2. `options` is NOT
    // re-fetched, exactly as in production.
    "/key": () => ({ ok: true, ...screenOf(["menu"]), selected: "2. No" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();
  await settle();

  // On load the border marks Yes, and the preview is correctly suppressed as a
  // duplicate of it.
  const pressed = () =>
    [...host.querySelectorAll(".term-option")].map((b) => b.getAttribute("aria-pressed"));
  expect(pressed()).toEqual(["true", "false"]);
  expect(host.querySelectorAll(".term-selected").length).toBe(0);

  const down = [...host.querySelectorAll(".term-key")].find((b) => b.textContent?.trim() === "↓");
  (down as HTMLButtonElement).click();
  await settle();
  await settle();

  // The border followed the cursor...
  expect(pressed()).toEqual(["false", "true"]);
  // ...and because it did, the preview stays a duplicate rather than becoming
  // the only correct signal. Either behaviour is safe; a stale border with no
  // preview is not.
  expect(host.querySelector(".term-option[aria-pressed='true'] .term-option-label")?.textContent).toBe("No");
});

test("a blocked agent keeps its state word visible, not only its colour", async () => {
  // The palette pairs red with green, which is the classic indistinguishable
  // pair, and this header has no visible section heading to fall back on the way
  // the list does. So the one state where a missed distinction has a consequence
  // says so in words; the other three spend the width on the agent's name.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  expect(host.querySelector(".term-title .term-state")?.textContent).toBe("blocked");
});
