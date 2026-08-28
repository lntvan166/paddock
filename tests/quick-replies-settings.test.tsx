// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { QuickRepliesSection } from "@web/components/settings/QuickRepliesSection";
import { MAX_QUICK_REPLIES, MAX_QUICK_REPLY_LEN, readQuickReplies } from "@web/prefs";
import { click, render, textsOf, typeInto, unmount } from "./support/render";

afterEach(async () => {
  await unmount();
  localStorage.removeItem("paddock.quick.replies");
});

const field = (host: HTMLElement) =>
  host.querySelector<HTMLInputElement>("#quick-reply-new")!;
const addButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>(".quick-reply-add")!;

test("the current replies are listed", async () => {
  localStorage.setItem("paddock.quick.replies", JSON.stringify(["Yes", "Ship it"]));

  const host = await render(<QuickRepliesSection />);

  expect(textsOf(host, ".quick-reply-text")).toEqual(["Yes", "Ship it"]);
});

test("adding one keeps it, on this device", async () => {
  const host = await render(<QuickRepliesSection />);

  await typeInto(field(host), "Ship it");
  await click(addButton(host));

  expect(textsOf(host, ".quick-reply-text")).toContain("Ship it");
  // Persisted, not merely on screen: the terminal reads this on mount.
  expect(readQuickReplies()).toContain("Ship it");
  expect(field(host).value, "the field clears, ready for the next").toBe("");
});

test("removing one keeps it removed", async () => {
  localStorage.setItem("paddock.quick.replies", JSON.stringify(["Yes", "No"]));
  const host = await render(<QuickRepliesSection />);

  await click(host.querySelector(".quick-reply-remove"));

  expect(textsOf(host, ".quick-reply-text")).toEqual(["No"]);
  expect(readQuickReplies()).toEqual(["No"]);
});

test("a duplicate is refused, and says why", async () => {
  // Silently dropping it would look like the button did nothing.
  localStorage.setItem("paddock.quick.replies", JSON.stringify(["Yes"]));
  const host = await render(<QuickRepliesSection />);

  await typeInto(field(host), "Yes");
  await click(addButton(host));

  expect(host.querySelector(".quick-reply-note")?.textContent).toContain("already");
  expect(textsOf(host, ".quick-reply-text")).toEqual(["Yes"]);
});

test("an over-long reply is refused, and says why", async () => {
  // Storage is untouched here, so the section starts from the defaults — the
  // assertion is that the list is UNCHANGED, not that it is empty.
  const host = await render(<QuickRepliesSection />);
  const before = textsOf(host, ".quick-reply-text");

  await typeInto(field(host), "x".repeat(MAX_QUICK_REPLY_LEN + 1));
  await click(addButton(host));

  expect(host.querySelector(".quick-reply-note")?.textContent).toContain("too long");
  expect(textsOf(host, ".quick-reply-text"), "nothing was added").toEqual(before);
});

test("an empty field cannot be added", async () => {
  const host = await render(<QuickRepliesSection />);

  expect(addButton(host).disabled, "nothing to add").toBe(true);

  await typeInto(field(host), "   ");
  expect(addButton(host).disabled, "whitespace is nothing").toBe(true);
});

test("at the cap it stops accepting, and says so", async () => {
  const full = Array.from({ length: MAX_QUICK_REPLIES }, (_, i) => `r${i}`);
  localStorage.setItem("paddock.quick.replies", JSON.stringify(full));
  const host = await render(<QuickRepliesSection />);

  await typeInto(field(host), "one more");

  expect(addButton(host).disabled).toBe(true);
  expect(host.textContent).toContain(`${MAX_QUICK_REPLIES}`);
});

test("clearing the list is allowed, and is not the same as never setting one", async () => {
  // The terminal hides its Quick control entirely for an empty list, so this
  // has to persist as empty rather than falling back to the defaults.
  localStorage.setItem("paddock.quick.replies", JSON.stringify(["Yes"]));
  const host = await render(<QuickRepliesSection />);

  await click(host.querySelector(".quick-reply-remove"));

  expect(readQuickReplies()).toEqual([]);
});
