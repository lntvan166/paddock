import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { createCoreActions } from "@server/herdr-core/actions";
import { CoreClient, locateCoreSocket } from "@server/herdr-core/socket";
import { LiveScreens } from "@server/herdr-core/live-screen";
import { moveDialogTab, toggleDialogOption, typeIntoFreeText, type DialogIo } from "@server/herdr/dialog-type";
import { parseAskDialog } from "@server/herdr/ask-dialog";
import type { AppSocket } from "@server/herdr-core/app-socket";
import type { AskDialog } from "@shared/types";

/**
 * An app agent's QUESTION dialog, answered through paddock's own dialog code
 * and the herdr-core actions, against a real one.
 *
 * WHY THIS FILE EXISTS. Step 7 of docs/probes/2026-11-09-herdr-core.md
 * measured what each key does to Claude Code's question dialog when it comes
 * through the core, and found that the plain `terminal.read` cannot tell
 * which question tab is current. This file is that measurement executed, and
 * on a USED screen: text already typed, the cursor parked on the text row,
 * the second question rather than the first (CLAUDE.md: "verify a control
 * from a used screen"). It goes through the same helpers the routes call.
 *
 * SAFETY. These tests TYPE INTO A DIALOG, so they run only against a
 * terminal named by `PADDOCK_CORE_DIALOG_PROBE`, and skip loudly otherwise.
 * They never submit. Set one up, unlabelled so the app never shows it:
 *
 *     cd "$(mktemp -d)"
 *     hc run --bg --no-parent --no-notify --name probe-question -- claude
 *     hc send probe-question "Call AskUserQuestion once with exactly two \
 *       questions. First: multiSelect true, three options, each with a \
 *       one-line description. Second: multiSelect false, three options, each \
 *       with a one-line description. No preamble, no file reads."
 *     PADDOCK_CORE_DIALOG_PROBE=probe-question bun test tests/core-dialog-live.test.ts
 *
 * and `hc kill probe-question && hc rm probe-question` when done. The probe
 * is a real Claude Code session and costs real usage, which is why this is a
 * deliberate act rather than part of `make test`.
 */

const PROBE = process.env.PADDOCK_CORE_DIALOG_PROBE ?? "";
const SOCKET = locateCoreSocket(process.env, process.getuid?.() ?? 0, (p) => {
  try { return statSync(p).isSocket(); } catch { return false; }
});

/** The repaint pause the routes use. */
const SETTLE_MS = 150;

function socketPresent(): boolean {
  try {
    return SOCKET !== null && statSync(SOCKET).isSocket();
  } catch {
    return false;
  }
}

const noApp: AppSocket = {
  async available() { return false; },
  async renameSpace() { throw new Error("not in this test"); },
  async renameTab() { throw new Error("not in this test"); },
};

const client = SOCKET ? new CoreClient(SOCKET) : null;
const screens = new LiveScreens({ history: 0 });
afterAll(() => screens.closeAll());
const actions = client ? createCoreActions(() => client, noApp, { screens }) : null;
const settle = () => new Promise<void>((r) => setTimeout(r, SETTLE_MS));
// The core id paddock uses, for whatever the probe's address is.
let ID = "";

const io: DialogIo = {
  readPromptScreen: (t) => actions!.readPromptScreen(t),
  sendNavKey: (t, k) => actions!.sendNavKey(t, k),
  sendChars: (t, c) => actions!.sendChars(t, c),
  sendOptionKey: (t, k) => actions!.sendOptionKey(t, k),
  settle,
};

async function screen(): Promise<AskDialog | null> {
  await settle();
  return parseAskDialog(await actions!.readPromptScreen(ID));
}

let ready = false;
if (PROBE !== "" && socketPresent() && client) {
  const t = await client.request<{ address: string; status?: { kind?: string } | null }>("terminal.get", { terminal: PROBE });
  ID = `hc.${t.address}`;
  ready = t.status?.kind === "question" && (await screen()) !== null;
}
if (!ready) {
  console.warn(
    PROBE === ""
      ? "SKIPPED tests/core-dialog-live.test.ts: set PADDOCK_CORE_DIALOG_PROBE to a probe terminal (see the file header)"
      : !socketPresent()
        ? "SKIPPED tests/core-dialog-live.test.ts: no herdr-core socket"
        : `SKIPPED tests/core-dialog-live.test.ts: ${PROBE} is not showing a question dialog`,
  );
}

test.skipIf(!ready)("the live gate opens on a question, and the prompt read marks the current tab", async () => {
  expect(await actions!.promptAllowed(ID)).toBe(true);
  const d = await screen();
  expect(d!.questions.filter((q) => q.current)).toHaveLength(1);
}, 30_000);

test.skipIf(!ready)("free text takes letters with marks and symbols, and a second answer REPLACES the first", async () => {
  const typed = () => screen().then((d) => d!.options.find((o) => o.freeText)?.typed ?? "");
  expect((await typeIntoFreeText(ID, [..."chào bạn?"], io)).ok).toBe(true);
  expect(await typed()).toBe("chào bạn?");
  // Used screen: the cursor is on the text row, the caret at the end, text there.
  expect((await typeIntoFreeText(ID, [..."xin lỗi"], io)).ok).toBe(true);
  expect(await typed()).toBe("xin lỗi");
}, 90_000);

test.skipIf(!ready)("from the text row, a tap on an option steps off it and toggles that option", async () => {
  const before = await screen();
  const cursor = before!.cursor;
  expect(cursor?.kind === "option" && before!.options.find((o) => o.key === cursor.key)?.freeText,
    "the previous test left the cursor on the text row").toBe(true);
  const option = before!.options.find((o) => !o.freeText)!;
  const out = await toggleDialogOption(ID, option.key, io);
  expect(out.ok).toBe(true);
  const after = await screen();
  if (after!.mode === "multi") {
    expect(after!.options.find((o) => o.key === option.key)?.checked).toBe(!option.checked);
  }
  // The typed answer is still there: the tap did not land in the text.
  expect(after!.options.find((o) => o.freeText)?.typed).toBe("xin lỗi");
}, 90_000);

test.skipIf(!ready)("the tab moves to the next question and back", async () => {
  const start = (await screen())!.questions.find((q) => q.current)!.label;
  const right = await moveDialogTab(ID, "right", io);
  expect(right.ok).toBe(true);
  expect((await screen())!.questions.find((q) => q.current)!.label).not.toBe(start);
  const left = await moveDialogTab(ID, "left", io);
  expect(left.ok).toBe(true);
  expect((await screen())!.questions.find((q) => q.current)!.label).toBe(start);
}, 90_000);
