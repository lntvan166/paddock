import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Toggle } from "@web/components/ui/Toggle";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("it is announced as a switch, with its state", async () => {
  const host = await render(<Toggle checked label="Wrap long lines" onChange={() => {}} />);
  const btn = host.querySelector("button") as HTMLButtonElement;
  expect(btn.getAttribute("role")).toBe("switch");
  expect(btn.getAttribute("aria-checked")).toBe("true");
});

test("aria-checked tracks the state, rather than being written once", async () => {
  const host = await render(<Toggle checked={false} label="Wrap" onChange={() => {}} />);
  expect((host.querySelector("button") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
});

test("tapping reports the NEXT value, not the current one", async () => {
  const seen: boolean[] = [];
  const host = await render(<Toggle checked={false} label="Wrap" onChange={(v) => seen.push(v)} />);
  (host.querySelector("button") as HTMLButtonElement).click();
  expect(seen).toEqual([true]);
});

test("a disabled switch cannot be activated", async () => {
  // The push-notification case: disabled server-side, and a tap that silently
  // did nothing would read as a broken control rather than an unavailable one.
  const seen: boolean[] = [];
  const host = await render(
    <Toggle checked={false} disabled label="Push" onChange={(v) => seen.push(v)} />,
  );
  const btn = host.querySelector("button") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  btn.click();
  expect(seen).toEqual([]);
});

test("it carries an accessible name, because the visual label is in the card header", async () => {
  const host = await render(<Toggle checked label="Haptics" onChange={() => {}} />);
  expect((host.querySelector("button") as HTMLButtonElement).getAttribute("aria-label")).toBe("Haptics");
});
