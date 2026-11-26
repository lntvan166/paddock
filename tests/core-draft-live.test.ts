import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { createCoreActions } from "@server/herdr-core/actions";
import { CoreClient, locateCoreSocket } from "@server/herdr-core/socket";
import { LiveScreens } from "@server/herdr-core/live-screen";
import type { AppSocket } from "@server/herdr-core/app-socket";
import { readClaudeDraft } from "@shared/draft";

/**
 * The facts about Claude Code's INPUT BOX that replacing a desk draft depends
 * on, asserted against a real one through herdr-core.
 *
 * WHY THIS FILE EXISTS. `@shared/draft` and `clearDraft` rest on measurements
 * (docs/gotchas.md, "A draft in Claude Code's input"): the empty box's
 * suggestion is dim, a draft has no SGR, a paste collapses to a plain-text
 * label, and only TWO Escs in one call clear the whole box — while the same
 * pair on an EMPTY box opens Rewind. A remembered measurement decays silently
 * when Claude Code changes its TUI; this one fails and names which fact broke.
 * Each step sends what the code sends, then settles and reads.
 *
 * SAFETY. These tests TYPE INTO an input box and press Esc, so they run only
 * against a terminal named by `PADDOCK_CORE_DRAFT_PROBE`, and skip loudly
 * otherwise. They never submit. Set one up, unlabelled so the app never shows
 * it, idle and never prompted:
 *
 *     cd "$(mktemp -d)"
 *     hc run --bg --no-parent --no-notify --name probe-draft -- claude
 *     PADDOCK_CORE_DRAFT_PROBE=probe-draft bun test tests/core-draft-live.test.ts
 *
 * and `hc kill probe-draft && hc rm probe-draft` when done.
 */

const PROBE = process.env.PADDOCK_CORE_DRAFT_PROBE ?? "";
const SOCKET = locateCoreSocket(process.env, process.getuid?.() ?? 0, (p) => {
  try { return statSync(p).isSocket(); } catch { return false; }
});
const SETTLE_MS = 400;

const noApp: AppSocket = {
  async available() { return false; },
  async renameSpace() { throw new Error("not in this test"); },
  async renameTab() { throw new Error("not in this test"); },
};

const client = SOCKET && PROBE ? new CoreClient(SOCKET) : null;
const screens = new LiveScreens({ history: 0 });
afterAll(() => { screens.closeAll(); client?.close(); });
const actions = client ? createCoreActions(() => client, noApp, { screens }) : null;
const settle = () => new Promise<void>((r) => setTimeout(r, SETTLE_MS));

let ID = "";
let RAW = "";
let SIZE = { cols: 80, rows: 24 };
let ready = false;
if (client) {
  const t = await client.request<{ address: string; cols: number; rows: number; status?: { state?: string; app?: string } | null }>("terminal.get", { terminal: PROBE });
  RAW = t.address;
  ID = `hc.${t.address}`;
  SIZE = { cols: t.cols, rows: t.rows };
  ready = t.status?.app === "claude-code" && (t.status?.state === "idle" || t.status?.state === "done");
}
if (!ready) {
  console.warn(
    PROBE === ""
      ? "SKIPPED tests/core-draft-live.test.ts: set PADDOCK_CORE_DRAFT_PROBE to a probe terminal (see the file header)"
      : `SKIPPED tests/core-draft-live.test.ts: ${PROBE} is not an idle Claude Code`,
  );
}

const box = async () => { await settle(); return readClaudeDraft((await actions!.readPromptScreen(ID)).split("\n")); };
const type = async (text: string) => { await client!.typeText(RAW, text, SIZE); };
const keys = async (...k: string[]) => { await client!.request("terminal.keys", { terminal: RAW, keys: k }); };

test.skipIf(!ready)("an empty box reads as empty: its suggestion is dim", async () => {
  expect(await box()).toEqual({ kind: "empty" });
});

test.skipIf(!ready)("a typed multi-line draft reads back, then the double Esc clears ALL of it, cursor on line one", async () => {
  await type("dòng một\\");
  await settle();
  await keys("enter"); // backslash-Enter: a newline, not a submit
  await settle();
  await type("dòng hai");
  await settle();
  await keys("up");
  expect(await box()).toEqual({ kind: "text", text: "dòng một\ndòng hai" });
  await keys("esc", "esc");
  expect(await box()).toEqual({ kind: "empty" });
});

test.skipIf(!ready)("Ctrl+U alone clears only the line the cursor is on", async () => {
  await type("một\\");
  await settle();
  await keys("enter");
  await settle();
  await type("hai");
  await settle();
  await keys("ctrl+u");
  expect(await box()).toEqual({ kind: "text", text: "một" });
  await keys("esc", "esc");
  expect(await box()).toEqual({ kind: "empty" });
});

test.skipIf(!ready)("a collapsed paste reads as unknown, so it is never pulled", async () => {
  await type("xem cái này ");
  await settle();
  await type("\x1b[200~" + Array.from({ length: 12 }, (_, i) => `dòng ${i + 1}`).join("\r") + "\x1b[201~");
  expect((await box()).kind).toBe("unknown");
  await keys("esc", "esc");
  expect(await box()).toEqual({ kind: "empty" });
});

test.skipIf(!ready)("the double Esc on an EMPTY box opens Rewind: why clearDraft reads first", async () => {
  await keys("esc", "esc");
  await settle();
  expect((await actions!.readPromptScreen(ID))).toContain("Rewind");
  await keys("esc");
  expect(await box()).toEqual({ kind: "empty" });
});

test.skipIf(!ready)("clearDraft clears a matching draft, and refuses one that changed", async () => {
  await type("sửa lỗi auth giúp mình");
  // On screen first, as it is when an operator pulls it.
  expect(await box()).toEqual({ kind: "text", text: "sửa lỗi auth giúp mình" });
  await actions!.clearDraft(ID, "sửa lỗi auth giúp mình");
  expect(await box()).toEqual({ kind: "empty" });

  await type("bản nháp khác");
  expect(await box()).toEqual({ kind: "text", text: "bản nháp khác" });
  await expect(actions!.clearDraft(ID, "sửa lỗi auth giúp mình")).rejects.toThrow(/changed/);
  expect(await box()).toEqual({ kind: "text", text: "bản nháp khác" });
  await keys("esc", "esc");
  expect(await box()).toEqual({ kind: "empty" });
});
