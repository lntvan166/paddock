import { expect, test } from "bun:test";
import { Unsupported } from "@server/action-errors";
import {
  createCoreActions, DRAFT_BUSY, DRAFT_CHANGED, DRAFT_NOT_CLAUDE, DRAFT_NOT_CLEARED,
} from "@server/herdr-core/actions";
import type { AppSocket } from "@server/herdr-core/app-socket";
import type { LiveScreens } from "@server/herdr-core/live-screen";

/*
 * Clearing Claude Code's input box so a reply replaces a desk draft. Fake
 * core: `terminal.get` answers the live status, and the coloured screen comes
 * from a scripted list, the next screen being read after each key. Never a
 * real terminal.
 */

const RULE = "─".repeat(40);
const boxed = (line: string) => ["● transcript", RULE, line, RULE, "  Opus 5.5"];
const DRAFT = boxed("❯\u00a0sửa lỗi auth giúp mình");
const EMPTY = boxed('❯\u00a0\u001b[0m\u001b[2mTry "write a test for <filepath>"\u001b[0m');
const REWIND = ["", "  Rewind", "  Nothing to rewind to yet.", "  Esc to cancel"];

function rig(o: { app?: string; state?: string; screens: string[][] }) {
  const keys: string[][] = [];
  const screens = [...o.screens];
  const client = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      if (method === "terminal.get") {
        return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: o.state ?? "idle", app: o.app ?? "claude-code" } } as T;
      }
      if (method === "terminal.keys") { keys.push(params.keys); return {} as T; }
      throw new Error(`unexpected ${method}`);
    },
    async observe() { return () => {}; },
  };
  // After the keys are sent, the next screen in the list is the one shown.
  const fake = { read: async () => (screens.length > 1 && keys.length > 0 ? screens.splice(0, 1)[0]! : screens[0]!), closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const a = createCoreActions(() => client as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });
  return { a, keys };
}

test("a draft that still matches is cleared with ONE call carrying two Escs, then checked empty", async () => {
  const r = rig({ screens: [DRAFT, EMPTY] });
  await r.a.clearDraft("hc.t7", "sửa lỗi auth giúp mình");
  expect(r.keys).toEqual([["esc", "esc"]]);
});

test("a draft that changed since it was pulled is left alone", async () => {
  const r = rig({ screens: [boxed("❯\u00a0sửa lỗi auth giúp mình rồi chạy test")] });
  await expect(r.a.clearDraft("hc.t7", "sửa lỗi auth giúp mình")).rejects.toThrow(new Unsupported(DRAFT_CHANGED));
  expect(r.keys).toEqual([]);
});

test("an empty box is never sent the pair: on an empty box it opens Rewind", async () => {
  const r = rig({ screens: [EMPTY] });
  await expect(r.a.clearDraft("hc.t7", "anything")).rejects.toThrow(new Unsupported(DRAFT_CHANGED));
  expect(r.keys).toEqual([]);
});

test("a working or blocked agent is not sent Esc, and neither is another harness", async () => {
  for (const state of ["working", "blocked"]) {
    const r = rig({ state, screens: [DRAFT] });
    await expect(r.a.clearDraft("hc.t7", "sửa lỗi auth giúp mình")).rejects.toThrow(new Unsupported(DRAFT_BUSY));
    expect(r.keys).toEqual([]);
  }
  const codex = rig({ app: "codex", screens: [DRAFT] });
  await expect(codex.a.clearDraft("hc.t7", "sửa lỗi auth giúp mình")).rejects.toThrow(new Unsupported(DRAFT_NOT_CLAUDE));
  expect(codex.keys).toEqual([]);
});

test("a box that is not empty afterwards is an error, and one Esc closes whatever opened", async () => {
  const r = rig({ screens: [DRAFT, REWIND] });
  await expect(r.a.clearDraft("hc.t7", "sửa lỗi auth giúp mình")).rejects.toThrow(DRAFT_NOT_CLEARED);
  expect(r.keys).toEqual([["esc", "esc"], ["esc"]]);
});
