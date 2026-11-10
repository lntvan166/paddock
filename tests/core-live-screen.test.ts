import { expect, test } from "bun:test";
import { LiveScreens, type Observer } from "@server/herdr-core/live-screen";
import { parseAnsiLine } from "@web/ansi";

/**
 * One live mirror per app terminal someone is looking at. The first read
 * attaches (as an observer) and waits for the first paint; every read after
 * that is answered from the mirror, which the stream keeps current. A mirror
 * nobody has read for `idleMs` is closed.
 *
 * This is the answer to "the dashboard polls /output every second": a poll of
 * an app agent no longer costs a new connection and a repaint on the core.
 */

const text = (l: string) => parseAnsiLine(l).map((s) => s.text).join("");

function fakeCore(cols = 40, rows = 5) {
  const views: { terminal: string; history: number; push: (s: string) => void; resize: (c: number, r: number) => void; lose: (why: string) => void; closed: boolean }[] = [];
  let gets = 0;
  const client: Observer = {
    async request<T>(method: string, params: any): Promise<T> {
      if (method !== "terminal.get") throw new Error(`unexpected ${method}`);
      gets++;
      return { address: params.terminal, cols, rows } as T;
    },
    async observe(terminal, size, h) {
      const view = {
        terminal, history: size.history, closed: false,
        push: (s: string) => h.onData(new TextEncoder().encode(s)),
        resize: (c: number, r: number) => h.onResize(c, r),
        lose: (why: string) => h.onClose(new Error(why)),
      };
      views.push(view);
      // As the core does: RESIZE, then the first paint, asynchronously.
      queueMicrotask(() => { h.onResize(cols, rows); h.onData(new TextEncoder().encode(`paint of ${terminal}`)); });
      return () => { view.closed = true; };
    },
  };
  return { client, views, gets: () => gets };
}

const quick = { idleMs: 200, quietMs: 10, maxPaintMs: 50, timeoutMs: 500, history: 100 };

test("the first read attaches and returns the first paint, with colour", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  const lines = await screens.read(core.client, "t7", false);
  expect(text(lines[0]!)).toBe("paint of t7");
  expect(core.views).toHaveLength(1);
  expect(core.views[0]!.history).toBe(100);
  screens.closeAll();
});

test("later reads come from the mirror, kept current by the stream: one attach, not one per poll", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  await screens.read(core.client, "t7", false);
  core.views[0]!.push("\r\n\x1b[32mnext line\x1b[0m");
  const lines = await screens.read(core.client, "t7", false);
  expect(lines.map(text)).toEqual(["paint of t7", "next line"]);
  expect(lines[1]).toContain("\x1b[");
  await screens.read(core.client, "t7", true);
  expect(core.views).toHaveLength(1);
  expect(core.gets()).toBe(1);
  screens.closeAll();
});

test("two reads racing the first attach share it", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  await Promise.all([screens.read(core.client, "t7", false), screens.read(core.client, "t7", false)]);
  expect(core.views).toHaveLength(1);
  screens.closeAll();
});

test("a mirror nobody reads is closed after idleMs, and the next read attaches again", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  await screens.read(core.client, "t7", false);
  await Bun.sleep(300);
  expect(core.views[0]!.closed).toBe(true);
  await screens.read(core.client, "t7", false);
  expect(core.views).toHaveLength(2);
  screens.closeAll();
});

test("a lost stream drops the mirror; the next read attaches again", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  await screens.read(core.client, "t7", false);
  core.views[0]!.lose("herdr-core ended the view of t7: restarted");
  await screens.read(core.client, "t7", false);
  expect(core.views).toHaveLength(2);
  screens.closeAll();
});

test("a size change after the first paint retires the mirror, so scrollback is never painted twice", async () => {
  const core = fakeCore();
  const screens = new LiveScreens(quick);
  await screens.read(core.client, "t7", false);
  core.views[0]!.resize(100, 30);
  expect(core.views[0]!.closed).toBe(true);
  await screens.read(core.client, "t7", false);
  expect(core.views).toHaveLength(2);
  screens.closeAll();
});

test("the screen read is the screen; the scrollback read is everything", async () => {
  const core = fakeCore(40, 3);
  const screens = new LiveScreens(quick);
  await screens.read(core.client, "t7", false);
  core.views[0]!.push("\r\n1\r\n2\r\n3\r\n4");
  expect((await screens.read(core.client, "t7", false)).map(text)).toEqual(["2", "3", "4"]);
  expect((await screens.read(core.client, "t7", true)).map(text)).toEqual(["paint of t7", "1", "2", "3", "4"]);
  screens.closeAll();
});

test("at most maxViews mirrors are kept; the least recently read one goes first", async () => {
  const core = fakeCore();
  const screens = new LiveScreens({ ...quick, maxViews: 2 });
  await screens.read(core.client, "t1", false);
  await screens.read(core.client, "t2", false);
  await screens.read(core.client, "t1", false);
  await screens.read(core.client, "t3", false);
  const closed = core.views.filter((v) => v.closed).map((v) => v.terminal);
  expect(closed).toEqual(["t2"]);
  screens.closeAll();
});

test("a terminal that never paints rejects within the timeout, and leaves no mirror behind", async () => {
  const core = fakeCore();
  core.client.observe = async () => () => {};
  const screens = new LiveScreens({ ...quick, timeoutMs: 100 });
  const e = await screens.read(core.client, "t7", false).catch((x) => x);
  expect(e.message).toMatch(/no paint/);
  core.client.observe = fakeCore().client.observe;
  const lines = await screens.read(core.client, "t7", false);
  expect(text(lines[0]!)).toBe("paint of t7");
  screens.closeAll();
});
