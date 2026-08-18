import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { RATE_MS, readPrefs, writePref } from "@web/prefs";

/**
 * Bun runs every test file in one process (tests/support/dom.ts documents
 * this cross-file pollution has already caused real failures here). Every
 * test below writes into the shared happy-dom localStorage, so every key
 * this module touches is removed after each test — not per-test
 * `removeItem` calls a later test could forget to add.
 */
const ALL_KEYS = ["paddock.theme", "paddock.rate", "paddock.term.wrap", "paddock.term.fontpx"];
afterEach(() => {
  for (const k of ALL_KEYS) localStorage.removeItem(k);
});

test("defaults are returned when nothing is stored", () => {
  // wrap defaults to true: reading is the common case, and a folded table is
  // recoverable with one tap whereas scrolling every prose line is a
  // permanent tax (AgentTerminal.tsx's former readWrap() rationale, now
  // owned here).
  // fontPx defaults to null — "no explicit preference" — NOT to a number.
  // styles.css sizes .term-pane with
  // `clamp(0.62rem, 2.3vw, 0.78rem)` as the fallback behind
  // `var(--term-font-px, …)`, and AgentTerminal only writes that property
  // when a real preference exists. A numeric default meant the property was
  // always written, so the responsive clamp never applied to anybody.
  expect(readPrefs()).toEqual({ theme: "system", rate: "live", wrap: true, fontPx: null });
});

test("the existing wrap key is reused verbatim, so no operator's setting resets", () => {
  localStorage.setItem("paddock.term.wrap", "1");
  expect(readPrefs().wrap).toBe(true);
});

test("wrap distinguishes 'never stored' from 'explicitly turned off'", () => {
  // The bug this guards against: `raw(KEYS.wrap) === "1"` alone answers
  // `false` for both an absent key and a stored `"0"`, which silently flips
  // the default for every operator who never opened the setting. Absent must
  // fall back to the default (`true`); only a stored `"0"` means `false`.
  expect(localStorage.getItem("paddock.term.wrap")).toBe(null);
  expect(readPrefs().wrap).toBe(true);

  localStorage.setItem("paddock.term.wrap", "0");
  expect(readPrefs().wrap).toBe(false);

  localStorage.setItem("paddock.term.wrap", "1");
  expect(readPrefs().wrap).toBe(true);
});

test("a throwing localStorage yields defaults instead of a blank screen", () => {
  // Safari private mode throws outright on access — install.ts:48 documents
  // this. An uncaught throw here would take the whole settings view down.
  const real = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError"); },
  });
  expect(() => readPrefs()).not.toThrow();
  expect(readPrefs().theme).toBe("system");
  // Matches the original readWrap()'s catch path: a storage access that
  // throws must fall back to wrap's true default, not to false.
  expect(readPrefs().wrap).toBe(true);
  expect(() => writePref("theme", "dark")).not.toThrow();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
});

test("the three refresh presets are the ones the spec names", () => {
  expect(RATE_MS).toEqual({ live: 250, balanced: 1_000, frugal: 3_000 });
});

// --- Validation fallbacks: a hand-edited or stale value must not reach the UI ---

test("an unrecognised stored theme falls back to the default", () => {
  localStorage.setItem("paddock.theme", "banana");
  expect(readPrefs().theme).toBe("system");
});

test("an unrecognised stored rate falls back to the default", () => {
  localStorage.setItem("paddock.rate", "warp-speed");
  expect(readPrefs().rate).toBe("live");
});

test("a non-numeric stored fontPx falls back to the default", () => {
  localStorage.setItem("paddock.term.fontpx", "abc");
  expect(readPrefs().fontPx).toBe(null);
});

test("a literal 'NaN' stored fontPx falls back to the default", () => {
  localStorage.setItem("paddock.term.fontpx", "NaN");
  expect(readPrefs().fontPx).toBe(null);
});

test("a stored fontPx below the 10px floor falls back to the default", () => {
  localStorage.setItem("paddock.term.fontpx", "9");
  expect(readPrefs().fontPx).toBe(null);
});

test("a stored fontPx above the 22px ceiling falls back to the default", () => {
  localStorage.setItem("paddock.term.fontpx", "23");
  expect(readPrefs().fontPx).toBe(null);
});

test("the fontPx boundaries themselves are accepted, being inclusive", () => {
  localStorage.setItem("paddock.term.fontpx", "10");
  expect(readPrefs().fontPx).toBe(10);
  localStorage.setItem("paddock.term.fontpx", "22");
  expect(readPrefs().fontPx).toBe(22);
});

// --- writePref round-trips: prove it serializes correctly, not just "doesn't throw" ---

test("writePref round-trips theme", () => {
  writePref("theme", "dark");
  expect(readPrefs().theme).toBe("dark");
});

test("writePref round-trips rate", () => {
  writePref("rate", "frugal");
  expect(readPrefs().rate).toBe("frugal");
});

test("writePref round-trips wrap true", () => {
  writePref("wrap", true);
  expect(localStorage.getItem("paddock.term.wrap")).toBe("1");
  expect(readPrefs().wrap).toBe(true);
});

test("writePref round-trips wrap false, persisting as '0' rather than falling through to default", () => {
  localStorage.setItem("paddock.term.wrap", "1");
  writePref("wrap", false);
  expect(localStorage.getItem("paddock.term.wrap")).toBe("0");
  expect(readPrefs().wrap).toBe(false);
});

test("writePref round-trips fontPx", () => {
  writePref("fontPx", 18);
  expect(readPrefs().fontPx).toBe(18);
});

test("writing a null fontPx REMOVES the key rather than storing the string 'null'", () => {
  // "Back to automatic" has to leave storage in the same state as "never
  // touched", or the clamp is only in charge until the operator opens the
  // field once. `String(null)` would persist the literal "null", which
  // readPrefs would then have to launder back to a default on every read.
  writePref("fontPx", 18);
  expect(localStorage.getItem("paddock.term.fontpx")).toBe("18");
  writePref("fontPx", null);
  expect(localStorage.getItem("paddock.term.fontpx")).toBe(null);
  expect(readPrefs().fontPx).toBe(null);
});
