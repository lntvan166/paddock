// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { prunePanes } from "@web/pane-cache";
import { agent, click, fire, render, settle, stubFetch, typeInto, unmount } from "./support/render";

/*
 * A draft typed into Claude Code's own input at the desk, offered for pulling
 * into the reply field so the reply replaces it instead of being fused onto it.
 * Invented draft words; the box shape is the one measured (see draft.test.ts).
 */

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; prunePanes(new Set()); });

const RULE = "─".repeat(40);
const screen = (input: string) => {
  const lines = ["● done", RULE, input, RULE, "  Opus 5.5"];
  return { lines, source: "visible", digest: digestOf(lines) };
};
const DRAFT = "❯\u00a0sửa lỗi auth giúp mình";
const EMPTY = '❯\u00a0\u001b[0m\u001b[2mTry "write a test for <filepath>"\u001b[0m';

const APP_AGENT = agent({ agentId: "hc.t7", origin: "core", harness: "claude", state: "idle" });

async function mount(input: string, a = APP_AGENT) {
  const { fn, calls } = stubFetch({
    "/output": () => screen(input),
    "/commands": () => ({ ok: true, commands: [] }),
    "/text": () => ({ ok: true, lines: screen(EMPTY).lines, source: "visible" }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={a} onBack={() => {}} />);
  await settle();
  const field = host.querySelector<HTMLTextAreaElement>("#term-reply-input")!;
  const strip = () => host.querySelector("[data-field=desk-draft]");
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  return { host, field, calls, strip, button };
}

const textBody = (calls: { url: string; body: unknown }[]) =>
  calls.find((c) => c.url.includes("/text"))?.body as { text: string; replaceDraft?: string } | undefined;

test("a draft at the desk is shown; pulling it in puts it in the field, ahead of what was typed", async () => {
  const m = await mount(DRAFT);
  expect(m.strip()?.textContent).toContain("sửa lỗi auth giúp mình");
  await typeInto(m.field, "rồi chạy test");
  await click(m.button("Pull in"));
  expect(m.field.value).toBe("sửa lỗi auth giúp mình\nrồi chạy test");
  expect(m.strip()?.textContent).toContain("Replaces the desk draft");
});

test("sending after a pull asks the server to replace exactly the pulled draft", async () => {
  const m = await mount(DRAFT);
  await click(m.button("Pull in"));
  await fire(m.field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();
  expect(textBody(m.calls)).toEqual({ text: "sửa lỗi auth giúp mình", replaceDraft: "sửa lỗi auth giúp mình" });
});

test("Undo puts the field back as it was, and the reply is then sent without replacing", async () => {
  const m = await mount(DRAFT);
  await typeInto(m.field, "chỉ câu này");
  await click(m.button("Pull in"));
  await click(m.button("Undo"));
  expect(m.field.value).toBe("chỉ câu này");
  await fire(m.field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();
  expect(textBody(m.calls)).toEqual({ text: "chỉ câu này" });
});

test("nothing is offered for an empty box, another harness, a terminal herdr agent, or a busy agent", async () => {
  expect((await mount(EMPTY)).strip()).toBeNull();
  await unmount();
  expect((await mount(DRAFT, { ...APP_AGENT, harness: "codex" })).strip()).toBeNull();
  await unmount();
  expect((await mount(DRAFT, { ...APP_AGENT, agentId: "w1:p1", origin: "herdr" })).strip()).toBeNull();
  await unmount();
  expect((await mount(DRAFT, { ...APP_AGENT, state: "working" })).strip()).toBeNull();
});

test("while a reply is in flight the box's text is not offered back as a desk draft", async () => {
  // The core pastes a reply into the box before it presses Enter, and may
  // hold the send; a phone offered the operator's own message back to pull.
  let release!: () => void;
  const { fn } = stubFetch({
    "/output": () => screen(DRAFT),
    "/commands": () => ({ ok: true, commands: [] }),
  });
  const slow = async (input: any, init?: any) => {
    if (String(input).includes("/text")) {
      await new Promise<void>((r) => { release = r; });
      return new Response(JSON.stringify({ ok: true, lines: [], source: "visible" }), { headers: { "content-type": "application/json" } });
    }
    return fn(input, init);
  };
  globalThis.fetch = slow as typeof fetch;
  const host = await render(<AgentTerminal agent={APP_AGENT} onBack={() => {}} />);
  await settle();
  expect(host.querySelector("[data-field=desk-draft]")).not.toBeNull();
  const field = host.querySelector<HTMLTextAreaElement>("#term-reply-input")!;
  await typeInto(field, "câu khác");
  await fire(field, new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await settle();
  expect(host.querySelector("[data-field=desk-draft]")).toBeNull();
  release();
  await settle();
});
