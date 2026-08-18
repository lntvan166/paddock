import "./support/dom";
import { expect, test } from "bun:test";
import { RATE_MS, readPrefs, writePref } from "@web/prefs";

test("defaults are returned when nothing is stored", () => {
  expect(readPrefs()).toEqual({ theme: "system", rate: "live", wrap: false, fontPx: 13 });
});

test("the existing wrap key is reused verbatim, so no operator's setting resets", () => {
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
  expect(() => writePref("theme", "dark")).not.toThrow();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
});

test("the three refresh presets are the ones the spec names", () => {
  expect(RATE_MS).toEqual({ live: 250, balanced: 1_000, frugal: 3_000 });
});
