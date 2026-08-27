// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, fire, render, settle, stubFetch, typeInto, unmount } from "./support/render";

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
  const field = host.querySelector<HTMLTextAreaElement>("#term-reply-input");
  if (!field) throw new Error("no reply field");
  return { host, field, calls };
}

const sentText = (calls: { url: string; body: unknown }[]) =>
  (calls.find((c) => c.url.includes("/text"))?.body as { text: string } | undefined)?.text;

test("the reply field is multi-line, and starts at one row", async () => {
  // A three-sentence instruction to an agent scrolled out of sight in a
  // single-line input, so the operator committed text they could not read.
  // One row at rest: the transcript is what the screen is for.
  const { field } = await mount();

  expect(field.tagName).toBe("TEXTAREA");
  // The ATTRIBUTE, not the property: happy-dom returns `rows` as a string
  // where the DOM says number, and the intent here is the markup.
  expect(field.getAttribute("rows")).toBe("1");
});

test("Return inserts a newline rather than sending", async () => {
  // The whole point. A textarea does this natively — asserted so a future
  // keydown handler cannot quietly take it back.
  const { field, calls } = await mount();
  await typeInto(field, "first line");

  await fire(field, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  expect(sentText(calls), "nothing was sent").toBeUndefined();
});

test("Ctrl+Enter sends, so a keyboard has not lost its shortcut", async () => {
  // A regression this GUARDS AGAINST introducing: in the single-line field,
  // Return submitted. Moving to a textarea takes that away, and a desktop
  // client would have been left with no keyboard send at all.
  const { field, calls } = await mount();
  await typeInto(field, "ship it");

  await fire(field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();

  expect(sentText(calls)).toBe("ship it");
});

test("Cmd+Enter sends too, because a Mac has no Ctrl there", async () => {
  const { field, calls } = await mount();
  await typeInto(field, "ship it");

  await fire(field, new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
  await settle();

  expect(sentText(calls)).toBe("ship it");
});

test("a multi-line reply reaches the agent with its newlines intact", async () => {
  // What the field is FOR. Asserted at paddock's own boundary: whether the
  // harness treats a newline as a submit is its business, and unproven here.
  const { field, calls } = await mount();

  await typeInto(field, "do this:\nthen that");
  await fire(field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();

  expect(sentText(calls)).toBe("do this:\nthen that");
});

test("Ctrl+Enter on an empty field sends nothing", async () => {
  const { field, calls } = await mount();

  await fire(field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();

  expect(sentText(calls)).toBeUndefined();
});
