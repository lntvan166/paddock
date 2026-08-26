import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { useKeyboardInset } from "@web/keyboard-inset";
import { render, settle, unmount } from "./support/render";

/**
 * The maths behind holding a bottom sheet above the on-screen keyboard.
 *
 * A real keyboard cannot be raised in a test — happy-dom has no
 * `visualViewport` and no layout — so what is asserted here is the arithmetic
 * and the lifecycle, which is where this can actually go wrong: an inset that
 * double-counts iOS's own scroll, a negative value mid-rotation, or a stale
 * property left behind that holds the NEXT sheet up off the bottom.
 */

type FakeVV = {
  height: number; offsetTop: number;
  listeners: Record<string, (() => void)[]>;
  addEventListener: (t: string, f: () => void) => void;
  removeEventListener: (t: string, f: () => void) => void;
  fire: (t: string) => void;
};

function fakeViewport(height: number, offsetTop = 0): FakeVV {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    height, offsetTop, listeners,
    addEventListener(t, f) { (listeners[t] ??= []).push(f); },
    removeEventListener(t, f) {
      listeners[t] = (listeners[t] ?? []).filter((x) => x !== f);
    },
    fire(t) { for (const f of listeners[t] ?? []) f(); },
  };
}

function install(vv: FakeVV | undefined, innerHeight = 844): void {
  (globalThis as unknown as { visualViewport?: unknown }).visualViewport = vv;
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
}

function Probe({ active }: { active: boolean }) {
  useKeyboardInset(active);
  return <div />;
}

const inset = () => document.documentElement.style.getPropertyValue("--kb-inset");

afterEach(async () => {
  await unmount();
  install(undefined);
  document.documentElement.style.removeProperty("--kb-inset");
});

test("the inset is what the keyboard covers", async () => {
  // 844 tall, 508 of it still visible: the keyboard has 336.
  install(fakeViewport(508));
  await render(<Probe active />);
  await settle();
  expect(inset()).toBe("336px");
});

test("iOS scrolling the visual viewport is not counted as more keyboard", async () => {
  // When iOS shifts the visual viewport up to reveal a focused field it fires
  // `scroll` and moves `offsetTop`. Ignoring that term reports a keyboard
  // larger than the real one and lifts the sheet clean off the screen.
  install(fakeViewport(508, 60));
  await render(<Probe active />);
  await settle();
  expect(inset()).toBe("276px");
});

test("a viewport briefly taller than the window does not push the sheet away", async () => {
  // Measured mid-rotation on iOS: `visualViewport.height` can exceed
  // `innerHeight` for a frame. Unclamped that is a negative inset, and
  // `bottom: -20px` puts the sheet off the bottom of the screen.
  install(fakeViewport(900));
  await render(<Probe active />);
  await settle();
  expect(inset()).toBe("0px");
});

test("the property is REMOVED when the sheet closes, not zeroed", async () => {
  // The rules read `var(--kb-inset, 0px)`, so absence and "0px" look the same
  // to them — but a stale value left behind after the keyboard is gone would
  // hold the next sheet up off the bottom of the screen.
  install(fakeViewport(508));
  const host = await render(<Probe active />);
  await settle();
  expect(inset()).toBe("336px");
  void host;
  await unmount();
  expect(inset()).toBe("");
});

test("nothing is published while no sheet is open", async () => {
  install(fakeViewport(508));
  await render(<Probe active={false} />);
  await settle();
  expect(inset()).toBe("");
});

test("a browser without visualViewport is left alone", async () => {
  // No fallback is attempted on purpose: guessing a keyboard height per device
  // is the device detection this project bans. The sheet behaves as it did.
  install(undefined);
  await render(<Probe active />);
  await settle();
  expect(inset()).toBe("");
});

test("a later resize republishes the inset", async () => {
  const vv = fakeViewport(508);
  install(vv);
  await render(<Probe active />);
  await settle();
  expect(inset()).toBe("336px");

  // The keyboard grows — a suggestion bar appears, or an emoji panel opens.
  vv.height = 420;
  vv.fire("resize");
  expect(inset()).toBe("424px");

  // And retracts.
  vv.height = 844;
  vv.fire("resize");
  expect(inset()).toBe("0px");
});
