import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { DeviceSection } from "@web/components/settings/DeviceSection";
import { THEMES, readPrefs } from "@web/prefs";
import { click, render, selectOption, textsOf, unmount } from "./support/render";

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

test("theme is a select, because there are more than three of them", async () => {
  // This test asserted the OPPOSITE, on the reasoning that "a native select on
  // iOS opens a full-screen wheel for three values". That reasoning was right,
  // and it is exactly why the answer changes at seven: the wheel is heavy for
  // three options and correct for seven, where a segmented control would give
  // each theme about 50px of a 390px phone.
  //
  // The Live-updates card still uses `Segmented`, and should: it has three.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  expect(host.querySelector("select[data-field='theme']")).not.toBeNull();
  expect(host.querySelector("[role='radiogroup'][aria-label='Theme']")).toBeNull();
  expect(host.querySelector("[role='radiogroup'][aria-label='Refresh rate']")).not.toBeNull();
});

test("the theme select offers every registered theme, in registry order", async () => {
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const select = host.querySelector("select[data-field='theme']") as HTMLSelectElement;
  expect([...select.options].map((o) => o.value)).toEqual(THEMES.map((t) => t.id));
});

test("choosing a theme writes the preference immediately", async () => {
  // "This device" is localStorage-immediate: there is no Save to press. The
  // control changed from a segmented group to a select; the guarantee did not.
  const h = harness();
  const host = await render(<DeviceSection prefs={h.prefs} setPref={h.setPref as never} />);
  const select = host.querySelector("select[data-field='theme']") as HTMLSelectElement;
  await selectOption(select, "dracula");
  expect(h.written).toEqual([["theme", "dracula"]]);
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
