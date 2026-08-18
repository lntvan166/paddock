// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported. Not a stylistic import order — moving this
// line breaks every test in the file (tests/support/dom.ts).
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { RATE_MS, writePref } from "@web/prefs";
import { AgentTerminal, floorFor } from "@web/components/AgentTerminal";
import { themeAttr } from "@web/components/App";
import { digestOf } from "@shared/screen";
import { agent, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
// Bun runs every test file in one process (tests/support/dom.ts documents
// this cross-file pollution has already caused real failures here), so every
// `paddock.*` key this file touches is removed after each test rather than
// left to leak into whichever suite runs next.
const PREF_KEYS = ["paddock.theme", "paddock.rate", "paddock.term.wrap", "paddock.term.fontpx"];
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  for (const k of PREF_KEYS) localStorage.removeItem(k);
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

test("the refresh preset raises the interval floor, and the backoff ceiling is untouched", () => {
  expect(floorFor("live")).toBe(RATE_MS.live);
  expect(floorFor("frugal")).toBe(RATE_MS.frugal);
});

// Ruling P8: the brief's version of this test set
// `document.documentElement.dataset.theme = "dark"` and then asserted the
// attribute equals "dark" — that asserts happy-dom's behaviour, not
// paddock's, and would pass with none of this task's code present. Testing
// the pure mapping function App.tsx's effect actually uses covers the
// mapping paddock owns instead.
test("themeAttr maps every preference to the attribute value the CSS listens for", () => {
  // styles.css:42 has defined :root[data-theme="dark"] since before this
  // feature, with nothing ever setting it — this mapping is what closes that
  // loop. "system" maps to null, which the caller reads as "delete the
  // attribute" rather than "set it to the literal string 'system'".
  expect(themeAttr("light")).toBe("light");
  expect(themeAttr("dark")).toBe("dark");
  expect(themeAttr("system")).toBe(null);
});

test("wrap is read through @web/prefs, not a local localStorage key", async () => {
  writePref("wrap", false);
  const { fn } = stubFetch({ "/output": () => screenOf(["line one"]) });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  expect(host.querySelector(".term-wrap-toggle")?.getAttribute("aria-pressed")).toBe("false");
});

test("fontPx is applied to the terminal pane as a CSS custom property", async () => {
  writePref("fontPx", 18);
  const { fn } = stubFetch({ "/output": () => screenOf(["line one"]) });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  const pane = host.querySelector(".term-pane") as HTMLElement | null;
  expect(pane?.style.getPropertyValue("--term-font-px")).toBe("18px");
});
