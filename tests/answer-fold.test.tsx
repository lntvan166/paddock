import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

/**
 * Folding the composer while an answer panel is on screen.
 *
 * Measured on a 390x844 viewport with a question dialog up: the transcript got
 * 359px and the chrome below it 439 — the operator reads less than half the
 * screen at exactly the moment they need to read before answering. The Keys row
 * and the reply field are the redundant part there, because the panel above is
 * how the question gets answered.
 *
 * It folds, it is never REMOVED, and the bar that replaces it says what is
 * inside it — a nameless glyph is a control you have to discover by poking, and
 * on touch there is no hover to discover it with.
 */
const OPTIONS_PROMPT = {
  question: "Do you want to proceed?",
  options: [
    { key: "1", label: "Yes", selected: true },
    { key: "2", label: "No", selected: false },
  ],
  selected: "1. Yes",
  notes: null,
  commit: "digit",
  raw: "",
};

/** A parse that failed: no panel at all, so the composer is the only answer. */
const NO_PANEL_PROMPT = {
  question: null,
  options: null,
  selected: null,
  notes: null,
  commit: "digit",
  raw: "",
};

async function mount(prompt: unknown, state: "blocked" | "working" = "blocked") {
  const { fn } = stubFetch({
    "/output": () => screenOf(["Do you want to proceed?"]),
    "/prompt": () => prompt,
    "/commands": () => ({ ok: true, commands: [] }),
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state })} onBack={() => {}} />);
  await settle();
  await settle();
  return host;
}

test("the composer folds away while an answer panel is on screen", async () => {
  const host = await mount(OPTIONS_PROMPT);
  expect(host.querySelectorAll(".term-reply").length, "the reply field is still taking space").toBe(0);
});

test("the fold is a named control, not a bare glyph", async () => {
  // On touch there is no hover to reveal what a chevron means.
  const host = await mount(OPTIONS_PROMPT);
  const bar = host.querySelector(".term-fold") as HTMLElement;
  expect(bar).not.toBeNull();
  expect(bar.textContent ?? "").toMatch(/reply/i);
  expect(bar.textContent ?? "").toMatch(/keys/i);
});

test("tapping the bar brings the composer back", async () => {
  const host = await mount(OPTIONS_PROMPT);
  await click(host.querySelector(".term-fold") as HTMLElement);
  expect(host.querySelectorAll(".term-reply").length).toBe(1);
});

test("once opened it stays open, and does not re-fold underneath the operator", async () => {
  const host = await mount(OPTIONS_PROMPT);
  await click(host.querySelector(".term-fold") as HTMLElement);
  // A poll lands, the screen is re-read, the panel is still there.
  await settle();
  await settle();
  expect(host.querySelectorAll(".term-reply").length, "it folded again on its own").toBe(1);
});

test("nothing folds when the parse produced no panel", async () => {
  // The reply field is then the ONLY way to answer, which is the fallback this
  // project keeps for exactly the prompts it refuses to read.
  const host = await mount(NO_PANEL_PROMPT);
  expect(host.querySelectorAll(".term-reply").length).toBe(1);
  expect(host.querySelectorAll(".term-fold").length).toBe(0);
});

test("nothing folds on a pane with no question at all", async () => {
  // A working agent has no panel and no popup; the composer is the whole point
  // of the screen.
  const host = await mount(NO_PANEL_PROMPT, "working");
  expect(host.querySelectorAll(".term-reply").length).toBe(1);
  expect(host.querySelectorAll(".term-fold").length).toBe(0);
});
