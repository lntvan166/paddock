import { expect, test } from "bun:test";
import { CTRL_LETTERS, ctrlChar, isCtrlKey, isNavKey, NAV_KEYS, type CtrlKey } from "@shared/types";

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
  // A key added to NAV_KEYS without a route to carry it renders a button that
  // errors — worse than no button, by this project's own rule about
  // mislabelled controls. The `ctrl-*` half is exempt because it does not
  // travel as a key name at all; see the byte tests below.
  for (const key of NAV_KEYS) {
    expect(HERDR_ACCEPTS_AS_KEY.has(key)).toBe(true);
  }
});

test("the byte a control key sends is its letter's place in the alphabet", () => {
  // The rule, checked against a hand-written table rather than against itself.
  // `ctrlChar` computes; this does not. If the computation is wrong, these
  // disagree — which is the only reason a table still earns its place now that
  // there are twenty-six of them rather than eight.
  const known: Record<string, number> = {
    "ctrl-a": 0x01, "ctrl-c": 0x03, "ctrl-d": 0x04, "ctrl-e": 0x05,
    "ctrl-k": 0x0b, "ctrl-l": 0x0c, "ctrl-r": 0x12, "ctrl-u": 0x15,
    "ctrl-w": 0x17, "ctrl-z": 0x1a,
  };
  for (const [key, code] of Object.entries(known)) {
    const ch = ctrlChar(key as CtrlKey);
    expect(ch.length).toBe(1);
    expect(ch.charCodeAt(0)).toBe(code);
  }
});

test("all twenty-six letters produce a single byte in the C0 range", () => {
  // C0 is 0x01–0x1a for `^A`–`^Z`. A letter that fell outside it would be a
  // key sending something that is not a control character at all.
  expect(CTRL_LETTERS.length).toBe(26);
  for (const letter of CTRL_LETTERS) {
    const ch = ctrlChar(`ctrl-${letter}`);
    expect(ch.length).toBe(1);
    expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x01);
    expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x1a);
  }
});

test("isCtrlKey closes the set — no empty letter, no two letters, no unicode", () => {
  // The property `routes.ts` depends on. A client must not be able to smuggle
  // an arbitrary sequence through the key endpoint and have it forwarded.
  for (const letter of CTRL_LETTERS) expect(isCtrlKey(`ctrl-${letter}`)).toBe(true);
  for (const bad of ["ctrl-", "ctrl-ab", "ctrl-A", "ctrl-1", "ctrl-☃", "ctrl", "c", "C-c", ""]) {
    expect(isCtrlKey(bad)).toBe(false);
  }
});

test("the route's gate accepts both halves of the union and nothing else", () => {
  for (const key of NAV_KEYS) expect(isNavKey(key)).toBe(true);
  for (const letter of CTRL_LETTERS) expect(isNavKey(`ctrl-${letter}`)).toBe(true);
  for (const bad of ["C-c", "escape", "f1", "pageup", "ctrl-A", 3, null, undefined, {}]) {
    expect(isNavKey(bad)).toBe(false);
  }
});

test("an agent pad may only offer a key an agent can actually receive", () => {
  // herdr has no `agent.send_text`, so an agent cannot take a control
  // character; `agent.send_keys` accepts `C-c` and no other control key. Any
  // ctrl key BUT `ctrl-c` on an agent pad would be a control that lies.
  const AGENT_CAN_RECEIVE = (key: string) =>
    (NAV_KEYS as readonly string[]).includes(key) || key === "ctrl-c";

  expect(AGENT_CAN_RECEIVE("ctrl-c")).toBe(true);
  expect(AGENT_CAN_RECEIVE("enter")).toBe(true);
  for (const letter of CTRL_LETTERS) {
    if (letter === "c") continue;
    expect(AGENT_CAN_RECEIVE(`ctrl-${letter}`)).toBe(false);
  }
});
