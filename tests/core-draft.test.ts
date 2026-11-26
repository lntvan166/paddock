import { expect, test } from "bun:test";
import { Unsupported } from "@server/action-errors";
import {
  createCoreActions, DRAFT_BUSY, DRAFT_CHANGED, DRAFT_NOT_CLAUDE, DRAFT_NOT_CLEARED, IMAGE_NOT_ATTACHED, INPUT_COVERED, SEND_TIMEOUT_MS,
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

// Sending a reply. Captured: a `/btw` answer replaces the box and takes
// letters as its own keys, so a send into it vanished while reporting success.
const BTW = ["● transcript", "▔".repeat(40), "  /btw anything", "    ok", "  c to copy · f to fork · x to clear history · Esc to close"];

function sender(o: { app?: string; screen: string[] }) {
  const sent: string[] = [];
  const client = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      if (method === "terminal.get") return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: "idle", app: o.app ?? "claude-code" } } as T;
      if (method === "terminal.send") { sent.push(params.text); return {} as T; }
      throw new Error(`unexpected ${method}`);
    },
    async observe() { return () => {}; },
  };
  const fake = { read: async () => o.screen, closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  return { a: createCoreActions(() => client as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens }), sent };
}

test("a reply is refused while something covers Claude Code's input, and sent when the box is there", async () => {
  const covered = sender({ screen: BTW });
  await expect(covered.a.sendReply("hc.t7", "xin chào")).rejects.toThrow(new Unsupported(INPUT_COVERED));
  expect(covered.sent).toEqual([]);

  const open = sender({ screen: EMPTY });
  await open.a.sendReply("hc.t7", "xin chào");
  expect(open.sent).toEqual(["xin chào"]);

  // Another harness's screen was never measured: it is sent as before.
  const codex = sender({ app: "codex", screen: BTW });
  await codex.a.sendReply("hc.t7", "xin chào");
  expect(codex.sent).toEqual(["xin chào"]);
});

test("a reply goes out on a connection of its own, with the long send timeout", async () => {
  const alone: { method: string; params: any; timeoutMs: number }[] = [];
  const client = {
    async request<T>(method: string): Promise<T> {
      if (method === "terminal.get") return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: "idle", app: "claude-code" } } as T;
      throw new Error(`unexpected shared-connection ${method}`);
    },
    async requestAlone<T>(method: string, params: any, timeoutMs: number): Promise<T> {
      alone.push({ method, params, timeoutMs });
      return {} as T;
    },
    async observe() { return () => {}; },
  };
  const fake = { read: async () => EMPTY, closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const a = createCoreActions(() => client as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });
  await a.sendReply("hc.t7", "xin chào");
  expect(alone).toEqual([{ method: "terminal.send", params: { terminal: "t7", text: "xin chào" }, timeoutMs: SEND_TIMEOUT_MS }]);
});

/** A box holding one chip per image path among the pastes so far. */
const chipsFor = (typed: string[]) => {
  const n = typed.filter((p) => p.includes("/there/")).length;
  return boxed("❯\u00a0" + (n === 0 ? "" : Array.from({ length: n }, (_, i) => `[Image #${i + 1}]`).join(" ")));
};

test("a reply with images goes in as parts: each path pasted alone where its token was, then Enter", async () => {
  const typed: string[] = [];
  const sent: string[] = [];
  const client = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      if (method === "terminal.get") return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: "idle", app: "claude-code" } } as T;
      if (method === "terminal.send") { sent.push(params.text); return {} as T; }
      throw new Error(`unexpected ${method}`);
    },
    async typeText(_t: string, text: string) { typed.push(text); },
    async observe() { return () => {}; },
  };
  // The box shows a chip for each image path pasted, as Claude Code does.
  const fake = { read: async () => chipsFor(typed), closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const a = createCoreActions(() => client as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });

  await a.sendReply("hc.t7", "so sánh [Image #1] với ảnh cũ", ["/there/a.png"]);
  const P = (s: string) => `\x1b[200~${s}\x1b[201~`;
  expect(typed).toEqual([P("so sánh "), P("/there/a.png")]);
  // The last words go through `send`, which presses Enter behind the gates.
  expect(sent).toEqual([" với ảnh cũ"]);
});

test("a reply ending on an image still submits; another harness gets the paths inline", async () => {
  const typed: string[] = [];
  const sent: string[] = [];
  const mk = (app: string) => ({
    async request<T>(method: string, params: any = {}): Promise<T> {
      if (method === "terminal.get") return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: "idle", app } } as T;
      if (method === "terminal.send") { sent.push(params.text); return {} as T; }
      throw new Error(`unexpected ${method}`);
    },
    async typeText(_t: string, text: string) { typed.push(text); },
    async observe() { return () => {}; },
  });
  const fake = { read: async () => chipsFor(typed), closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const claude = createCoreActions(() => mk("claude-code") as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });
  await claude.sendReply("hc.t7", "xem [Image #1]", ["/there/a.png"]);
  expect(sent).toEqual([" "]);

  typed.length = 0; sent.length = 0;
  const codex = createCoreActions(() => mk("codex") as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });
  await codex.sendReply("hc.t7", "xem [Image #1] nhé", ["/there/a.png"]);
  expect(typed).toEqual([]);
  expect(sent).toEqual(["xem /there/a.png nhé"]);
});

test("an image that never becomes a chip stops the reply short of Enter, and says so", async () => {
  // Measured: a fixed pause let Enter overtake a new image, and the prompt
  // went without it while the chip landed in the box afterwards.
  const sent: string[] = [];
  const client = {
    async request<T>(method: string, params: any = {}): Promise<T> {
      if (method === "terminal.get") return { address: "t7", cols: 80, rows: 24, labels: {}, status: { state: "idle", app: "claude-code" } } as T;
      if (method === "terminal.send") { sent.push(params.text); return {} as T; }
      throw new Error(`unexpected ${method}`);
    },
    async typeText() {},
    async observe() { return () => {}; },
  };
  const fake = { read: async () => EMPTY, closeAll() {} };
  const app: AppSocket = { async available() { return false; }, async renameSpace() {}, async renameTab() {} };
  const a = createCoreActions(() => client as never, app, { sleep: async () => {}, screens: fake as unknown as LiveScreens });
  await expect(a.sendReply("hc.t7", "xem [Image #1] nhé", ["/there/a.png"])).rejects.toThrow(IMAGE_NOT_ATTACHED);
  expect(sent).toEqual([]);
});
