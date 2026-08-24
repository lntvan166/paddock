import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { DeviceSection } from "@web/components/settings/DeviceSection";
import { readPrefs } from "@web/prefs";
import { click, render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

function harness() {
  const written: [string, unknown][] = [];
  const prefs = { ...readPrefs(), theme: "system" as const };
  return { written, prefs, setPref: (k: string, v: unknown) => { written.push([k, v]); } };
}

test("each group is its own card", async () => {
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  expect(textsOf(host, ".card-title")).toEqual(["Appearance", "Live updates", "Terminal"]);
});

test("theme is a segmented control, not a select", async () => {
  // A native select on iOS opens a full-screen wheel for three values.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const group = host.querySelector("[role='radiogroup'][aria-label='Theme']");
  expect(group).not.toBeNull();
  expect(host.querySelector("select[name='theme']")).toBeNull();
});

test("choosing a theme writes the preference immediately", async () => {
  // "This device" is localStorage-immediate: there is no Save to press.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const dark = [...host.querySelectorAll("[aria-label='Theme'] [role='radio']")]
    .find((n) => (n.textContent ?? "").includes("Dark")) as HTMLButtonElement;
  await click(dark);
  expect(h.written).toEqual([["theme", "dark"]]);
});

test("wrap is a switch, and reports the next value", async () => {
  const h = harness();
  const host = await render(
    <DeviceSection prefs={{ ...h.prefs, wrap: false }} setPref={h.setPref as never} />,
  );
  const sw = host.querySelector("[role='switch'][aria-label='Wrap long lines']") as HTMLButtonElement;
  expect(sw).not.toBeNull();
  await click(sw);
  expect(h.written).toEqual([["wrap", true]]);
});

test("blank font size still means automatic, not zero", async () => {
  // styles.css sizes the pane with var(--term-font-px, clamp(...)), so blank is
  // the DEFAULT rather than a reset — an empty string must write null, never
  // Number("") === 0.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const input = host.querySelector("input[name='fontPx']") as HTMLInputElement;
  expect(input.placeholder).toBe("Automatic");
});
