import { afterEach, expect, test } from "bun:test";
import "./support/dom";
import {
  DEFAULT_QUICK_REPLIES,
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LEN,
  normaliseQuickReplies,
  readQuickReplies,
  writeQuickReplies,
} from "@web/prefs";

const KEY = "paddock.quick.replies";
afterEach(() => { localStorage.removeItem(KEY); });

// ---- normalising, which is the whole of the validation --------------------

test("blank and whitespace-only entries are dropped, the rest trimmed", () => {
  expect(normaliseQuickReplies([" Yes ", "", "   ", "Go ahead"]))
    .toEqual(["Yes", "Go ahead"]);
});

test("duplicates collapse, keeping the first", () => {
  // Two identical rows in the panel are two identical buttons — a mis-tap
  // hazard with no upside.
  expect(normaliseQuickReplies(["Yes", "Yes", "yes"])).toEqual(["Yes", "yes"]);
});

test("anything that is not a string is dropped", () => {
  // Only reachable through hand-edited storage, which is exactly when a
  // `.map(String)` would put "null" or "[object Object]" on a button.
  expect(normaliseQuickReplies(["Yes", 3, null, { a: 1 }, "No"])).toEqual(["Yes", "No"]);
});

test("an over-long entry is dropped, because a quick reply is short by definition", () => {
  const essay = "x".repeat(MAX_QUICK_REPLY_LEN + 1);
  expect(normaliseQuickReplies(["Yes", essay])).toEqual(["Yes"]);
});

test("the list is capped", () => {
  const many = Array.from({ length: MAX_QUICK_REPLIES + 5 }, (_, i) => `reply ${i}`);
  expect(normaliseQuickReplies(many)).toHaveLength(MAX_QUICK_REPLIES);
});

test("a non-array is not a list at all", () => {
  expect(normaliseQuickReplies("Yes")).toBeNull();
  expect(normaliseQuickReplies(null)).toBeNull();
  expect(normaliseQuickReplies({ 0: "Yes" })).toBeNull();
});

// ---- reading and writing ---------------------------------------------------

test("never stored means the defaults", () => {
  expect(readQuickReplies()).toEqual([...DEFAULT_QUICK_REPLIES]);
});

test("stored empty means EMPTY, not the defaults", () => {
  // The distinction that matters: an operator who removed every reply must not
  // have them handed back on the next load. Absence and emptiness are
  // different answers.
  writeQuickReplies([]);
  expect(readQuickReplies()).toEqual([]);
});

test("what was written is what comes back, commas and all", () => {
  // A comma is why this is JSON rather than `writePref`, whose scalar path
  // would store `String(list)` and read it back split in the wrong places.
  const list = ["Yes, please", "Go ahead", "Approve"];
  writeQuickReplies(list);
  expect(readQuickReplies()).toEqual(list);
});

test("unparseable storage falls back to the defaults rather than throwing", () => {
  localStorage.setItem(KEY, "{not json");
  expect(readQuickReplies()).toEqual([...DEFAULT_QUICK_REPLIES]);
});

test("a stored list is normalised on the way out too", () => {
  // Hand-edited storage, or a list written by an older build with looser rules.
  localStorage.setItem(KEY, JSON.stringify([" Yes ", "", "Yes"]));
  expect(readQuickReplies()).toEqual(["Yes"]);
});
