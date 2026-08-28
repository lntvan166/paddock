// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, fire, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem("paddock.term.keypad");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

async function mount() {
  const { fn } = stubFetch({
    "/output": () => screenOf(["one", "two", "three"]),
    "/commands": () => ({ ok: true, commands: [] }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();
  return host;
}

/**
 * happy-dom performs no layout, so `scrollHeight` and `clientHeight` are 0 and
 * the pane always reads as "at the bottom". That is exactly the resting state
 * this asserts, and the scrolled-away state is driven by setting the numbers
 * the handler reads — the handler's arithmetic is the thing under test, not the
 * browser's layout.
 */
function scrollAway(pane: HTMLElement) {
  Object.defineProperty(pane, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(pane, "clientHeight", { value: 200, configurable: true });
  pane.scrollTop = 0;
}

test("following the tail, there is no control to offer", async () => {
  // Its ABSENCE is the indicator that you are following. A button that is
  // always there says nothing.
  const host = await mount();
  expect(host.querySelector(".term-to-bottom")).toBeNull();
});

test("scrolled away from the tail, the control appears", async () => {
  const host = await mount();
  const pane = host.querySelector<HTMLElement>(".term-pane")!;

  scrollAway(pane);
  await fire(pane, new Event("scroll", { bubbles: true }));

  const button = host.querySelector(".term-to-bottom");
  expect(button).not.toBeNull();
  expect(button?.textContent).toContain("Latest");
});

test("tapping it returns to the tail, and the control goes with it", async () => {
  const host = await mount();
  const pane = host.querySelector<HTMLElement>(".term-pane")!;
  scrollAway(pane);
  await fire(pane, new Event("scroll", { bubbles: true }));

  const button = host.querySelector(".term-to-bottom")!;
  await fire(button, new MouseEvent("click", { bubbles: true }));

  expect(pane.scrollTop, "back at the tail").toBe(1000);
  expect(host.querySelector(".term-to-bottom"), "and it stops offering").toBeNull();
});
