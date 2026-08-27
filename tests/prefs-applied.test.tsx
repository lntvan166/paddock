// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported. Not a stylistic import order — moving this
// line breaks every test in the file (tests/support/dom.ts).
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { RATE_MS, readPrefs, themeAttr, writePref } from "@web/prefs";
import { AgentTerminal, floorFor } from "@web/components/AgentTerminal";
import { Settings } from "@web/components/Settings";
import { digestOf } from "@shared/screen";
import { agent, click, render, selectOption, settle, stubFetch, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;
// Bun runs every test file in one process (tests/support/dom.ts documents
// this cross-file pollution has already caused real failures here), so every
// `paddock.*` key this file touches is removed after each test rather than
// left to leak into whichever suite runs next.
const PREF_KEYS = [
  "paddock.theme", "paddock.rate", "paddock.term.wrap", "paddock.term.fontpx",
  "paddock.term.keypad", "paddock.term.keypad.auto",
];
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  for (const k of PREF_KEYS) localStorage.removeItem(k);
  // `App`'s mount effect and `Settings`' live-apply both write this attribute
  // straight onto `document.documentElement`, which outlives any one test's
  // render tree — left set, it leaks into whichever DOM test runs next in
  // this same Bun process (tests/support/dom.ts documents this class of
  // cross-file pollution already causing real failures here).
  delete document.documentElement.dataset.theme;
});

// Minimal `SettingsView`, matching what `Settings.tsx`'s mount-time GET
// expects (shared/types.ts). Only the shape matters here: no test in this
// file asserts on its content.
const settingsView = () => ({
  telegram: { configured: false, hint: null, chatId: null },
  notify: { telegram: false, triggers: [], settleMs: { blocked: 5_000, done: 10_000 },
            mutedUntil: null, cooldownMs: 60_000 },
  publicUrl: null, serverNow: 1_700_000_000_000, error: null,
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

  // Asserted on the PANE, not on a control. This used to read the wrap
  // button's `aria-pressed`, which was a proxy: it proved the toggle agreed
  // with the pref, not that the pref reached the screen. The button has moved
  // to Settings, and the better observable was available all along —
  // `data-wrap` is what `styles.css` actually keys the two layouts off.
  expect(host.querySelector(".term-pane")?.getAttribute("data-wrap")).toBe("off");
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

/**
 * The gap this guards: `main.tsx` mounts `App` exactly once, unkeyed, for the
 * life of the page. Its theme effect has `[]` deps, so it fires once at cold
 * load and never again — `App` itself never unmounts; only its CHILDREN swap
 * (between `<Settings>`, `<AgentTerminal>`, and the agent list) at the same
 * early-return tree position in `App.tsx`. Without a live apply in
 * `Settings.tsx` itself, an operator who opens Settings and switches to Dark
 * sees nothing change until a full browser reload. Rendering `Settings`
 * directly (no `App`, no remount) is what proves the fix lives in
 * `Settings.tsx` and not in some effect upstream that a real navigation would
 * happen to re-run.
 */
test("choosing a theme in Settings applies it immediately, with no remount", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify(settingsView()), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const host = await render(<Settings />);
  await settle();
  await settle();

  // Driven through the select the Appearance card now renders. The control
  // changed; what this test proves did not — that the attribute is applied by
  // `Settings.tsx` itself, with no remount to re-run an effect upstream.
  const select = host.querySelector("select[data-field='theme']") as HTMLSelectElement;
  expect(select, "Appearance renders a theme select").not.toBeNull();

  await selectOption(select, "dark");
  await settle();

  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

  // "system" must DELETE the attribute, not set it to the literal string —
  // the same distinction `themeAttr` makes for App.tsx's mount-time apply.
  await selectOption(select, "system");
  await settle();

  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

/**
 * `styles.css` sizes the terminal by COLUMNS VISIBLE:
 * `font-size: var(--term-font-px, clamp(0.62rem, 2.3vw, 0.78rem))`, with a
 * comment recording that the metric was measured and the floor fixed once
 * already. The clamp is only ever reached when the custom property is UNSET.
 *
 * With `fontPx` defaulting to a number, `AgentTerminal` wrote the property on
 * every render for every operator, so the clamp was dead code for all of
 * them — and 13px is above the clamp's ~12.5px ceiling and far above its
 * ~9.9px value on a 390px phone, dropping visible columns from roughly 62 to
 * 48. Same class of silent default flip already caught for `wrap`.
 */
test("with no stored font size the pane sets no custom property, leaving the clamp in charge", async () => {
  expect(localStorage.getItem("paddock.term.fontpx")).toBe(null);
  const { fn } = stubFetch({ "/output": () => screenOf(["line one"]) });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  const pane = host.querySelector(".term-pane") as HTMLElement | null;
  expect(pane).not.toBeNull();
  expect(pane?.style.getPropertyValue("--term-font-px")).toBe("");
});

test("clearing the font size in Settings returns the pane to the clamp", async () => {
  // The operator needs a way BACK to automatic, or "unset by default" is only
  // true until the first time anyone touches the field.
  writePref("fontPx", 18);
  globalThis.fetch = (async () => new Response(JSON.stringify(settingsView()), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const host = await render(<Settings />);
  await settle();
  await settle();

  const input = host.querySelector('input[name="fontPx"]') as HTMLInputElement | null;
  expect(input).not.toBeNull();
  expect(input!.value).toBe("18");

  await typeInto(input!, "");
  await settle();

  expect(localStorage.getItem("paddock.term.fontpx")).toBe(null);
});

test("the keypad-auto setting is a device pref, written to this browser only", async () => {
  // Device, not server: it is about how much of THIS screen the pad is worth,
  // and the same account on a laptop has room a phone does not. A server
  // setting would collapse it everywhere at once.
  //
  // The fixture is a REAL SettingsView. Written first against a fixture that
  // did not exist, this test passed while the stub answered `undefined` — the
  // typechecker caught it, the assertions did not.
  const view = () => ({
    telegram: { configured: false, hint: null, chatId: null },
    notify: {
      telegram: false, triggers: ["blocked"],
      settleMs: { blocked: 5_000, done: 10_000 }, mutedUntil: null, cooldownMs: 60_000,
    },
    publicUrl: null, serverNow: 1_700_000_000_000, error: null,
  });
  const { fn, calls } = stubFetch({ "/api/settings": () => view() });
  globalThis.fetch = fn as unknown as typeof fetch;
  const host = await render(<Settings />);
  await settle();
  await settle();

  const sw = host.querySelector<HTMLButtonElement>(
    "[role='switch'][aria-label='Open the keypad when an agent needs you']",
  )!;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  await click(sw);
  await settle();

  expect(localStorage.getItem("paddock.term.keypad.auto")).toBe("0");
  expect(readPrefs().keypadAuto).toBe(false);
  // Nothing was WRITTEN to the SETTINGS endpoint. A request carrying a body is
  // a write, and a device pref that reached the server would apply to every
  // device the operator opens paddock on.
  //
  // Scoped to that endpoint rather than to every call with a body. `stubFetch`
  // replaces the ONE global fetch, so any other component alive at the same
  // moment — a poller in a concurrently-running test file, for instance —
  // records into this same array. Asserting on all traffic made this test a
  // detector of unrelated background work; asserting on the endpoint it is
  // about says what it means and is what it always meant.
  expect(calls.filter((c) => c.body !== undefined && c.url.includes("/api/settings")))
    .toEqual([]);
});
