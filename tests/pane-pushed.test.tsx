// FIRST: React reads `document` at import time.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { PaneTerminal } from "@web/components/PaneTerminal";
import { diffScreens, digestOf } from "@shared/screen";
import { prunePanes } from "@web/pane-cache";
import { deliverScreen, type ScreenFrame } from "@web/store";
import { render, settle, unmount } from "./support/render";

/*
 * A pane the server pushes screens to (see `src/server/screen-stream.ts`).
 * Invented agent name and output only.
 */

afterEach(async () => {
  await unmount();
  prunePanes(new Set());
});

const ID = "hc.t1";
const OPENING = ["$ api-refactor", "thinking"];

function loader() {
  const calls: (string | null)[] = [];
  const load = async (since: string | null) => {
    calls.push(since);
    return { lines: OPENING, source: "visible", digest: digestOf(OPENING) };
  };
  return { load, calls };
}

const push = async (f: ScreenFrame) => { await act(async () => { deliverScreen(f); }); };
const frame = (base: string[] | null, next: string[]): ScreenFrame => ({
  type: "screen", agentId: ID, base: base === null ? null : digestOf(base), patch: diffScreens(base ?? [], next), source: "visible",
});

test("a pushed patch on top of the screen held is drawn without a read", async () => {
  const l = loader();
  const el = await render(<PaneTerminal paneId={ID} streamId={ID} title="api-refactor" onBack={() => {}} load={l.load} />);
  await settle();
  const reads = l.calls.length;
  await push(frame(OPENING, ["$ api-refactor", "wrote 3 files"]));
  expect(el.textContent).toContain("wrote 3 files");
  expect(l.calls.length).toBe(reads);
});

test("a whole pushed screen is drawn whatever was held", async () => {
  const l = loader();
  const el = await render(<PaneTerminal paneId={ID} streamId={ID} title="api-refactor" onBack={() => {}} load={l.load} />);
  await settle();
  await push(frame(null, ["fresh screen"]));
  expect(el.textContent).toContain("fresh screen");
  expect(el.textContent).not.toContain("thinking");
});

test("a patch made against another screen is not drawn; without a socket the pane reads over HTTP", async () => {
  const l = loader();
  const el = await render(<PaneTerminal paneId={ID} streamId={ID} title="api-refactor" onBack={() => {}} load={l.load} />);
  await settle();
  const reads = l.calls.length;
  await push(frame(["some", "other", "screen"], ["never", "drawn"]));
  await settle();
  expect(el.textContent).not.toContain("never");
  // No socket in a test, so the resync cannot be asked for: HTTP instead.
  expect(l.calls.length).toBe(reads + 1);
});

test("a frame for another agent, or for a pane with no stream, is ignored", async () => {
  const l = loader();
  const el = await render(<PaneTerminal paneId={ID} title="api-refactor" onBack={() => {}} load={l.load} />);
  await settle();
  await push(frame(null, ["pushed"]));
  expect(el.textContent).not.toContain("pushed");
  await push({ ...frame(null, ["elsewhere"]), agentId: "hc.t2" });
  expect(el.textContent).not.toContain("elsewhere");
});
