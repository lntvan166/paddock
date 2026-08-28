import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createActions } from "@server/herdr/actions";
import { request } from "@server/herdr/socket";
import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { AskDialog } from "@shared/types";

/**
 * The facts about Claude Code's question dialog that paddock's code DEPENDS ON,
 * asserted against a real one.
 *
 * WHY THIS FILE EXISTS. `docs/design/2026-08-28-question-dialog-design.md`
 * carries a table of what each key does to that dialog. Every entry was measured
 * on a live agent — and two of them were WRONG, because the probe sent several
 * keys in one `send-keys` call and a TUI repaints asynchronously, so the later
 * keys were measured against the frame before the earlier ones landed. Both
 * wrong entries reached shipped code: one withheld a text field that works, and
 * shipped a note telling the operator to answer a way that cannot work.
 *
 * A remembered measurement decays silently. An executed one does not. So each
 * assertion below sends ONE key, settles, reads, and checks — the way the code
 * does — and the file is the early warning for the day Claude Code changes its
 * TUI: it names which fact broke, instead of a phone finding out.
 *
 * SAFETY. These tests SEND KEYS, so they must never touch an agent doing real
 * work: answering someone's actual question is not a test failure you can undo.
 * They therefore run only against an agent named explicitly by
 * `PADDOCK_DIALOG_PROBE`, and skip loudly otherwise. To set one up:
 *
 *     herdr tab create --workspace <ws> --cwd /tmp/probe --label "dialog probe"
 *     herdr agent start probe-dialog --kind claude --pane <pane-id>
 *     herdr agent prompt probe-dialog "Call AskUserQuestion once with exactly two \
 *       questions. First: multiSelect true, three options, each with a one-line \
 *       description. Second: multiSelect false, three options, each with a \
 *       one-line description. No preamble, no file reads."
 *     PADDOCK_DIALOG_PROBE=<pane-id> bun test tests/dialog-live.test.ts
 *
 * and `herdr tab close <tab-id>` when done. The probe is a real Claude Code
 * session and costs real usage, which is why this is a deliberate act rather
 * than part of `make test`.
 */

const SOCKET =
  process.env.PADDOCK_HERDR_SOCKET ?? join(homedir(), ".config", "herdr", "herdr.sock");
const PROBE = process.env.PADDOCK_DIALOG_PROBE ?? "";

/** The repaint pause the routes use. Same value, same reason. */
const SETTLE_MS = 120;

/** The escape byte, named so this file has no control characters in it. */
const ESC = String.fromCharCode(27) + "[";

function socketPresent(): boolean {
  // statSync, not Bun.file().exists(): a unix socket is not a regular file.
  try {
    return statSync(SOCKET).isSocket();
  } catch {
    return false;
  }
}

const actions = createActions(SOCKET);
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

async function screen(): Promise<AskDialog | null> {
  return parseAskDialog(await actions.readPromptScreen(PROBE));
}

/** One key, then a settle, then the parsed screen. Never a batch — see above. */
async function press(key: string): Promise<AskDialog | null> {
  await actions.sendChars(PROBE, [key]);
  await settle();
  return screen();
}

async function cursorTo(dialog: AskDialog, key: string): Promise<AskDialog | null> {
  const rows = [...dialog.options.map((o) => o.key), ...(dialog.advance ? ["advance"] : [])];
  const from = dialog.cursor?.kind === "advance" ? "advance" : dialog.cursor?.key ?? rows[0]!;
  const steps = rows.indexOf(key) - rows.indexOf(from);
  let latest: AskDialog | null = dialog;
  for (let i = 0; i < Math.abs(steps); i++) latest = await press(steps > 0 ? "down" : "up");
  return latest;
}

const ready = PROBE !== "" && socketPresent() && (await screen()) !== null;
if (!ready) {
  console.warn(
    PROBE === ""
      ? "SKIPPED tests/dialog-live.test.ts: set PADDOCK_DIALOG_PROBE to a probe agent's pane id (see the file header)"
      : !socketPresent()
        ? `SKIPPED tests/dialog-live.test.ts: no herdr socket at ${SOCKET.replace(homedir(), "~")}`
        : `SKIPPED tests/dialog-live.test.ts: ${PROBE} is not showing a question dialog`,
  );
}

test.skipIf(!ready)("a key is ONE character, and non-ASCII is one of them", async () => {
  // `sendChars` splits by code point and maps the space to its name because of
  // this. A word is refused outright, and an ASCII-only route would have
  // silently dropped half of what the operator types.
  await expect(actions.sendChars(PROBE, ["chào"])).rejects.toThrow(/invalid_key/i);
  await expect(actions.sendChars(PROBE, [" "])).rejects.toThrow(/invalid_key/i);

  // These land, so they must not throw.
  await actions.sendChars(PROBE, ["space"]);
  await actions.sendChars(PROBE, ["backspace"]);
  for (const ch of ["à", "ế", "日", "?"]) await actions.sendChars(PROBE, [ch]);
  await settle();
  for (let i = 0; i < 4; i++) await actions.sendChars(PROBE, ["backspace"]);
}, 60_000);

test.skipIf(!ready)("only the `visible` source carries the escapes", async () => {
  // The current tab is marked ONLY by an ANSI background, and `detection`
  // strips every escape whatever `strip_ansi` says — so the source, not the
  // flag, is what the prompt read had to change.
  const withColour = await actions.readPromptScreen(PROBE);
  expect(withColour, "the prompt read keeps colour").toContain(ESC);

  // Straight down the socket, because no action reads `detection` any more —
  // that is the point of the assertion.
  const res = await request<{ read: { text: string } }>(SOCKET, "agent.read", {
    target: PROBE, source: "detection", lines: 60, format: "ansi", strip_ansi: false,
  });
  expect(res.read.text, "detection strips them however it is asked").not.toContain(ESC);
}, 30_000);

test.skipIf(!ready)("on the FREE-TEXT row, keys mean something else entirely", async () => {
  // The rule `leaveTextRow` exists for, and the source of five separate bugs.
  // If any of this stops being true, that helper becomes unnecessary work — and
  // if it changes shape, it becomes wrong.
  const start = await screen();
  const text = start!.options.find((o) => o.freeText);
  expect(text, "the probe's question needs a text row").toBeDefined();

  const onText = await cursorTo(start!, text!.key);
  expect(onText?.cursor).toEqual({ kind: "option", key: text!.key });

  // 1. A DIGIT is typed as text, not a toggle.
  const before = onText!.options.find((o) => o.freeText)?.typed ?? "";
  const afterDigit = await press("7");
  expect(
    afterDigit!.options.find((o) => o.freeText)?.typed,
    "a digit on this row is text",
  ).toBe(`${before}7`);
  await press("backspace");

  // 2. LEFT/RIGHT do not reach the tab bar from here.
  const tabBefore = (await screen())!.question;
  await press("right");
  expect((await screen())!.question, "the arrow moved the caret, not the tab").toBe(tabBefore);
}, 90_000);

test.skipIf(!ready)("the caret is not where you would assume, and `right` past the end is inert", async () => {
  // Both facts are load-bearing for replacing a typed answer: backspace deletes
  // BEHIND the caret, so the caret is driven to the end first.
  const start = await screen();
  const text = start!.options.find((o) => o.freeText)!;
  await cursorTo(start!, text.key);

  await actions.sendChars(PROBE, ["a", "b", "c"]);
  await settle();
  expect((await screen())!.options.find((o) => o.freeText)?.typed).toMatch(/abc$/);

  // Twenty rights past a three-character tail change neither the text nor the
  // question — which is what makes "drive the caret to the end" safe.
  const textBefore = (await screen())!.options.find((o) => o.freeText)?.typed;
  const questionBefore = (await screen())!.question;
  for (let i = 0; i < 20; i++) await actions.sendChars(PROBE, ["right"]);
  await settle();
  expect((await screen())!.options.find((o) => o.freeText)?.typed).toBe(textBefore);
  expect((await screen())!.question).toBe(questionBefore);

  // And now backspace has something behind it.
  for (let i = 0; i < 3; i++) await actions.sendChars(PROBE, ["backspace"]);
  await settle();
  expect((await screen())!.options.find((o) => o.freeText)?.typed ?? "").not.toMatch(/abc$/);
}, 90_000);

test.skipIf(!ready)("from an OPTION row, a digit toggles and an arrow changes question", async () => {
  // The complement of the free-text row's behaviour, and the fast path the
  // routes take when the cursor is already somewhere safe.
  const start = await screen();
  const option = start!.options.find((o) => !o.freeText)!;
  const onOption = await cursorTo(start!, option.key);
  expect(onOption?.cursor).toEqual({ kind: "option", key: option.key });

  if (onOption!.mode === "multi") {
    const was = onOption!.options.find((o) => o.key === option.key)?.checked;
    const after = await press(option.key);
    expect(after!.options.find((o) => o.key === option.key)?.checked, "the digit toggled it")
      .toBe(!was);
    await press(option.key);
  }

  const questionBefore = (await screen())!.question;
  await press("right");
  const questionAfter = (await screen())!.question;
  expect(questionAfter, "the arrow reached the tab bar from an option row")
    .not.toBe(questionBefore);
  await press("left");
}, 90_000);
