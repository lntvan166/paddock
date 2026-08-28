// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, click, render, settle, stubFetch, textsOf, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem("paddock.term.keypad");
  localStorage.removeItem("paddock.term.keypad.auto");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

async function mount() {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["$ ready"]),
    "/commands": () => ({ ok: true, commands: [] }),
    "/text": () => ({ ok: true, lines: ["$ sent"] }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  return { host, calls };
}

const sentTexts = (calls: { url: string; body: unknown }[]) =>
  calls.filter((c) => c.url.includes("/text")).map((c) => (c.body as { text: string }).text);

test("Quick sits to the right of Keys, and says its own name", async () => {
  const { host } = await mount();

  const row = host.querySelector(".term-controls");
  const kids = [...(row?.children ?? [])];
  const keysAt = kids.findIndex((k) => k.classList.contains("term-keys-toggle"));
  const quickAt = kids.findIndex((k) => k.classList.contains("term-quick-toggle"));

  expect(keysAt).toBeGreaterThanOrEqual(0);
  expect(quickAt, "Quick follows Keys").toBeGreaterThan(keysAt);
  // Glyph BESIDE the word, never instead of it: the visible text is this
  // control's accessible name, and an icon alone leaves a button a
  // voice-control user cannot say — the WCAG 2.5.3 hazard `KeypadToggle`
  // already records.
  expect(kids[quickAt]?.textContent).toContain("Quick");
});

test("it is closed at rest, because the transcript is what the screen is for", async () => {
  const { host } = await mount();

  expect(host.querySelector(".term-quick")).toBeNull();
  expect(host.querySelector(".term-quick-toggle")?.getAttribute("aria-expanded")).toBe("false");
});

test("opening it offers the replies, and nothing has been sent", async () => {
  const { host, calls } = await mount();

  await click(host.querySelector(".term-quick-toggle"));

  expect(textsOf(host, ".term-quick-action")).toEqual(["Yes", "Go ahead", "Approve"]);
  expect(sentTexts(calls), "opening a panel must not talk to the agent").toEqual([]);
});

test("tapping one sends that exact text", async () => {
  // The label IS the payload. That is what keeps these clear of the rule
  // against guessing a keystroke for a blocked agent: a button reading
  // "Go ahead" types `Go ahead`, which is what the operator would have typed.
  const { host, calls } = await mount();
  await click(host.querySelector(".term-quick-toggle"));

  await click(host.querySelectorAll(".term-quick-action")[1]);

  expect(sentTexts(calls)).toEqual(["Go ahead"]);
});

test("the panel closes once something is sent", async () => {
  // Both a receipt and a guard: an open panel under a thumb invites the second
  // tap that sends a reply twice.
  const { host } = await mount();
  await click(host.querySelector(".term-quick-toggle"));

  await click(host.querySelector(".term-quick-action"));

  expect(host.querySelector(".term-quick")).toBeNull();
});

test("a half-typed reply survives a quick send", async () => {
  // The field is the operator's. A quick action sends ITS OWN text and leaves
  // whatever was being written alone — silently discarding a draft would be
  // the worse surprise.
  const { host, calls } = await mount();
  const field = host.querySelector<HTMLTextAreaElement>("#term-reply-input")!;
  await typeInto(field, "one moment, checking");
  await click(host.querySelector(".term-quick-toggle"));

  await click(host.querySelector(".term-quick-action"));

  expect(sentTexts(calls)).toEqual(["Yes"]);
  expect(field.value, "the draft is untouched").toBe("one moment, checking");
});

test("Quick closes again on a second tap", async () => {
  const { host } = await mount();
  const toggle = host.querySelector(".term-quick-toggle");

  await click(toggle);
  expect(host.querySelector(".term-quick")).not.toBeNull();

  await click(toggle);
  expect(host.querySelector(".term-quick")).toBeNull();
});
