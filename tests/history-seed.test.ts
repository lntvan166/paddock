import { expect, test } from "bun:test";
import { scrollbackAbove } from "@web/history";
import { coreJournalSession, REVIVE_SESSION, toCoreAgent } from "@server/herdr-core/adapter";
import type { CoreTerminal } from "@shared/herdr-core-api";

/*
 * An app agent's history: its terminal's real scrollback, and its Claude Code
 * journal when the Revive mod has labelled the session. Invented content.
 */

test("what is above the screen is found by matching the screen, not by counting rows", () => {
  const all = ["$ build", "ok", "● reply one", "● reply two", "────", "❯ ", "────", ""];
  const screen = ["● reply two", "────", "❯ ", "────"];
  expect(scrollbackAbove(all, screen)).toEqual(["$ build", "ok", "● reply one"]);
});

test("a screen that cannot be found gives nothing rather than a seam", () => {
  expect(scrollbackAbove(["a", "b"], ["not there"])).toBeNull();
});

test("an empty screen leaves the whole history, without its trailing blank lines", () => {
  expect(scrollbackAbove(["a", "b", "", ""], [])).toEqual(["a", "b"]);
});

const ID = "1fe182a2-9371-4584-88a8-90a3a71be174";
const term = (over: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address: "t7", argv: ["claude"], cols: 80, rows: 24, created_ms: 1, cwd: "/srv/project",
  labels: { [REVIVE_SESSION]: ID }, screen: "exact", state: "live",
  status: { state: "idle", app: "claude-code" }, ...over,
});

test("a Claude Code terminal labelled with its session reads that session's journal", () => {
  expect(coreJournalSession("t7", { [REVIVE_SESSION]: ID }, "claude")).toEqual({ agent: "claude", kind: "id", source: "revive", value: ID });
  expect(toCoreAgent(term(), "dev-box")?.hasJournal).toBe(true);
});

test("no journal without the label, for another harness, on another machine, or for a value that is not an id", () => {
  expect(toCoreAgent(term({ labels: {} }), "dev-box")?.hasJournal).toBe(false);
  expect(coreJournalSession("t7", { [REVIVE_SESSION]: ID }, "codex")).toBeNull();
  expect(coreJournalSession("build-box/t7", { [REVIVE_SESSION]: ID }, "claude")).toBeNull();
  expect(coreJournalSession("t7", { [REVIVE_SESSION]: "../../etc/passwd" }, "claude")).toBeNull();
});

test("plain stitched history meets a coloured screen: matched without colour", () => {
  // The core stitches a full-screen app's history as plain text; the screen
  // comes from the coloured mirror.
  const all = ["earlier one", "earlier two", "● reply", "❯ Try"];
  const screen = ["\x1b[1m● reply\x1b[0m", "❯ \x1b[2mTry\x1b[0m"];
  expect(scrollbackAbove(all, screen)).toEqual(["earlier one", "earlier two"]);
});

test("a screen of blank lines is not matched anywhere", () => {
  expect(scrollbackAbove(["a", "", "", "b"], ["", "", "x"])).toBeNull();
});
