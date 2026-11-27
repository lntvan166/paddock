// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { PaneTerminal } from "@web/components/PaneTerminal";
import { digestOf } from "@shared/screen";
import { prunePanes } from "@web/pane-cache";
import { click, render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); prunePanes(new Set()); });

const SCREEN = ["● reply two", "❯ "];
const ALL = ["$ build", "ok", "● reply one", ...SCREEN];
const load = async () => ({ lines: SCREEN, source: "visible", digest: digestOf(SCREEN) });

test("the terminal's own scrollback waits behind Show earlier, and then is there", async () => {
  const el = await render(
    <PaneTerminal paneId="hc.t7" title="api-refactor" onBack={() => {}} load={load} seedHistory={async () => ALL} />,
  );
  await settle();
  // Seeded as OLDER history: not on the page until asked for.
  expect(el.textContent).not.toContain("$ build");
  await click(el.querySelector(".term-earlier"));
  expect(el.textContent).toContain("$ build");
  expect(el.textContent).toContain("● reply one");
  // The screen is not repeated above itself.
  expect((el.textContent ?? "").split("● reply two").length - 1).toBe(1);
});
