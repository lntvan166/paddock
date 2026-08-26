// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported. Not a stylistic import order — moving this
// line breaks every test in the file.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import type { Agent } from "@shared/types";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { agent, click, render, settle, stubFetch, textsOf, unmount } from "./support/render";

const realFetch = globalThis.fetch;
/** Every pref this file writes. Cleared after each test for the reason
 *  `tests/settings-view.test.tsx` records: Bun runs every test file in ONE
 *  process, so a key left set here is read as an operator's stored choice by
 *  `tests/prefs.test.ts` and by any later file that calls `readPrefs()`. */
const PREF_KEYS = ["paddock.term.keypad", "paddock.term.keypad.auto", "paddock.rate"];

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
  await click(down);
  await settle();
  await settle();

  expect(calls.some((c) => c.url.includes("/key"))).toBe(true);
  expect(host.querySelector(".term-selected")?.textContent).toContain("2. Option 2");
});

test("the keypad opens itself only when it is the only way to answer", async () => {
  // This test used to require the pad in EVERY state, to stop it moving under
  // the operator's thumb. The hazard was real; the rule was wider than the
  // hazard. What actually moves under a thumb is a pad that CLOSES itself, and
  // nothing here ever closes one — see the following test, which is the half of
  // the old assertion worth keeping.
  //
  // What changed: the pad costs 106px of a 390x844 phone, and on a parsed
  // prompt it is a duplicate path. Tapping an option calls `answerWithKey` with
  // the agent's own digit, in one tap, and cannot be off by one the way arrowing
  // to it can. So it opens itself for a blocked agent whose prompt the parser
  // REFUSED, which is the case where no option buttons exist at all.
  for (const state of ["idle", "working", "done"] as const) {
    const { fn } = stubFetch({
      "/output": () => screenOf(["out"]),
      "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
    });
    globalThis.fetch = fn as typeof fetch;
    const host = await render(<AgentTerminal agent={agent({ state })} onBack={() => {}} />);
    await settle();
    expect(textsOf(host, ".term-key"), `${state} has nothing to answer`).toEqual([]);
    await unmount();
  }

  // Blocked, parser refused: the pad is the floor, so it opens.
  {
    const { fn } = stubFetch({
      "/output": () => screenOf(["menu"]),
      "/prompt": () => ({ question: null, options: null, selected: "3. Chat", raw: "" }),
    });
    globalThis.fetch = fn as typeof fetch;
    const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
    await settle();
    expect(textsOf(host, ".term-key")).toContain("⏎ Enter");
    await unmount();
  }

  // Blocked with real options: the buttons answer in one tap, so the pad stays
  // out of the way and `Keys` is one tap from bringing it back.
  {
    const { fn } = stubFetch({
      "/output": () => screenOf(["Do you want to proceed?"]),
      "/prompt": () => ({
        question: "Do you want to proceed?",
        options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
        selected: null, raw: "",
      }),
    });
    globalThis.fetch = fn as typeof fetch;
    const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
    await settle();
    expect(textsOf(host, ".term-option").length).toBe(2);
    expect(textsOf(host, ".term-key"), "options already are the arrows").toEqual([]);
    expect(host.querySelector(".term-keys-toggle")).not.toBeNull();
    await unmount();
  }
});

test("the pad never closes itself once it is open", async () => {
  // The invariant the old "present in every state" rule existed to protect, and
  // the one that must survive the pad becoming closable: a pad that vanished as
  // the agent's screen changed would move under a reaching thumb. The automatic
  // transition is expand-only — it declines to OPEN, it never closes.
  //
  // Proved through the stored preference, which is the strongest form available
  // in one mount: `/prompt` is fetched once per blocked agent, so options cannot
  // go from refused to parsed without a state change. An operator holding
  // `full` opens a blocked agent WITH real options — the exact state that
  // chooses `hidden` on a fresh default — and the pad is still there.
  localStorage.setItem("paddock.term.keypad", "full");
  const { fn } = stubFetch({
    "/output": () => screenOf(["Do you want to proceed?"]),
    "/prompt": () => ({
      question: "Do you want to proceed?",
      options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
      selected: null, raw: "",
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();
  expect(textsOf(host, ".term-option").length).toBe(2);
  expect(textsOf(host, ".term-key"), "the operator's open pad survives a parsed prompt")
    .toContain("⏎ Enter");
});

test("one tap on Keys brings the pad back", async () => {
  // The whole basis for hiding it by default: it is never more than one tap
  // away, for the Esc or the Tab that no option button carries.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent({ state: "working" })} onBack={() => {}} />);
  await settle();
  expect(textsOf(host, ".term-key")).toEqual([]);

  const toggle = host.querySelector(".term-keys-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect(textsOf(host, ".term-key")).toContain("⏎ Enter");
  expect(host.querySelector(".term-keys-toggle")?.getAttribute("aria-expanded")).toBe("true");
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

  // `data-keypad`, not a layout class: nothing renders `.term-keys-secondary`
  // any more, so asserting its absence would have passed no matter what the
  // pad did — a guard that cannot fail is worth less than none.
  expect(host.querySelector('.term-keys[data-keypad="full"]')).toBeNull();
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

  // Asserted on `data-keypad`, not on a layout class. This read
  // `.term-keys-secondary`, which was the class the `full` pad's second row
  // happened to carry — so a relayout broke a test about STATE. The attribute
  // is the fact; the classes are how it is drawn.
  expect(host.querySelector('.term-keys[data-keypad="full"]')).not.toBeNull();
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

  // `data-keypad`, not a layout class: nothing renders `.term-keys-secondary`
  // any more, so asserting its absence would have passed no matter what the
  // pad did — a guard that cannot fail is worth less than none.
  expect(host.querySelector('.term-keys[data-keypad="full"]')).toBeNull();
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

  // Keys is the bar's only toggle now. Wrap moved to Settings' Terminal card,
  // where an identical control had always also lived — the bar and the settings
  // screen were two doors onto one global pref, and the bar's was the one an
  // operator had to look at while reading a transcript.
  //
  // The class assertion stays as a TOMBSTONE rather than being deleted: it
  // pinned a real defect (Wrap and Keys once shared a class, so a selector
  // written for one silently matched the other by DOM order), and asserting the
  // removed control is absent is what stops it being reintroduced by habit.
  expect(host.querySelectorAll(".term-wrap-toggle").length).toBe(0);
  expect(host.querySelectorAll(".term-keys-toggle").length).toBe(1);
  // No aria-label: the visible text IS the accessible name. An aria-label that
  // does not contain the visible label is a WCAG 2.5.3 hazard for voice
  // control, and when this control grew a third state the tempting fix was
  // exactly that — `aria-label="Keys: arrows and Enter"` against a visible
  // "Keys ·". `aria-expanded` carries the state instead, which is the attribute
  // for a disclosure, and the decorative dots are hidden from the name rather
  // than spoken as punctuation.
  const keysToggle = host.querySelector(".term-keys-toggle")!;
  expect(keysToggle.textContent?.trim()).toBe("Keys");
  expect(keysToggle.hasAttribute("aria-label")).toBe(false);
  expect(keysToggle.hasAttribute("aria-expanded")).toBe(true);
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
  //
  // The pad is opened explicitly because this test's subject is what an ARROW
  // does to the border, and a blocked agent with parsed options now hides the
  // pad by default — the option buttons answer in one tap, so the arrows are a
  // duplicate path there. An operator who still wants them holds `full`, which
  // is exactly the state being set up here.
  localStorage.setItem("paddock.term.keypad", "full");
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
  await click(down);
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

test("a state change re-reads the transcript, so a screen is never frozen at the state it opened in", async () => {
  // Guards `load`'s `agent.state` dependency in `AgentTerminal`, which the body
  // of that callback never reads: it is there so `PaneTerminal` — which re-reads
  // whenever `load` changes identity — asks again when the agent moves. Until
  // now the only thing defending it was a comment, and a comment does not fail a
  // build. A transcript frozen at the moment the view opened is the thing an
  // operator is most likely to misread as current.
  //
  // The refresh preset is pinned to its slowest so the POLL cannot be what
  // produces the second read. `frugal` is 3 s; this test finishes in
  // milliseconds.
  localStorage.setItem("paddock.rate", "frugal");
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["one line"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  // A wrapper so the flip goes through React the way a delta does: same
  // element, same position, new `agent` object — never a remount, which would
  // re-read for a different reason entirely.
  function Harness() {
    const [state, setState] = useState<Agent["state"]>("working");
    return (
      <>
        <button type="button" id="flip" onClick={() => setState("idle")}>flip</button>
        <AgentTerminal agent={agent({ state })} onBack={() => {}} />
      </>
    );
  }

  const host = await render(<Harness />);
  await settle();
  const readsOnMount = calls.filter((c) => c.url.includes("/output")).length;
  expect(readsOnMount).toBeGreaterThan(0);

  await click(host.querySelector("#flip"));
  await settle();

  expect(calls.filter((c) => c.url.includes("/output")).length).toBeGreaterThan(readsOnMount);
});

test("the blocked pill says its word without an illegible glyph", async () => {
  // lucide scales stroke with size, so at size=11 the stroke was 0.92px, the
  // circle 9.2px, and the "!" inside it a 1.8px bar over a sub-pixel dot. It
  // was also redundant: only `blocked` ever renders this pill, so there is no
  // green pill to confuse it with and the pill itself is the shape channel.
  const { fn } = stubFetch({
    "/output": () => screenOf(["out"]),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state: "blocked" })} onBack={() => {}} />);
  await settle();

  const pill = host.querySelector(".term-title .term-state")!;
  expect(pill.textContent).toContain("blocked");
  expect(pill.querySelector("svg")).toBeNull();
});
