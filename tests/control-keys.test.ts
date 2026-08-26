import { expect, test } from "bun:test";
import { CTRL_CHAR, isCtrlKey, NAV_KEYS, type NavKey } from "@shared/types";

/**
 * herdr's REAL `pane.send_keys` vocabulary, measured on a throwaway pane
 * against 0.8.2 by sending each candidate and recording what came back.
 *
 * The schema advertises an unconstrained `string[]`; the implementation
 * enforces this. Four control keys shipped doing nothing because one of them
 * was verified and the other three were assumed.
 */
const HERDR_ACCEPTS_AS_KEY = new Set([
  "up", "down", "left", "right", "enter", "esc", "escape",
  "tab", "space", "backspace", "C-c", "f1", "f2",
]);

test("every nav key paddock sends is one herdr actually accepts", () => {
  // The guard that was missing. A key added to NAV_KEYS without a route to
  // carry it renders a button that errors — which is worse than no button,
  // by this project's own rule about mislabelled controls.
  for (const key of NAV_KEYS) {
    if (isCtrlKey(key)) continue; // travels as text, checked below
    expect(HERDR_ACCEPTS_AS_KEY.has(key)).toBe(true);
  }
});

test("every control key carries the byte its name claims", () => {
  // ^A is 0x01 and each letter counts up from there — the table is explicit
  // rather than computed, so this is the check that it was transcribed right.
  const expected: Record<string, number> = {
    "ctrl-a": 0x01, "ctrl-c": 0x03, "ctrl-d": 0x04, "ctrl-e": 0x05,
    "ctrl-l": 0x0c, "ctrl-u": 0x15, "ctrl-w": 0x17, "ctrl-z": 0x1a,
  };
  for (const [key, code] of Object.entries(expected)) {
    const ch = CTRL_CHAR[key as NavKey];
    expect(ch).toBeDefined();
    expect(ch!.length).toBe(1);
    expect(ch!.charCodeAt(0)).toBe(code);
  }
});

test("a control key's byte is derivable from its letter, so no entry is a typo", () => {
  // Belt and braces on the table above: `^X` is the letter's position in the
  // alphabet. Any hand-entered codepoint that disagrees is a typo, and a typo
  // here sends a DIFFERENT control character than the button promises.
  for (const key of NAV_KEYS) {
    if (!isCtrlKey(key)) continue;
    const letter = key.slice("ctrl-".length);
    expect(letter.length).toBe(1);
    expect(CTRL_CHAR[key]!.charCodeAt(0)).toBe(letter.charCodeAt(0) - 96);
  }
});

test("isCtrlKey and CTRL_CHAR agree about every key", () => {
  for (const key of NAV_KEYS) {
    expect(isCtrlKey(key)).toBe(CTRL_CHAR[key] !== undefined);
  }
});
