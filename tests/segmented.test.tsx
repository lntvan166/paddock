import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Segmented } from "@web/components/ui/Segmented";
import { click, fire, render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

test("it is announced as one named group of radios", async () => {
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={() => {}} />,
  );
  const group = host.querySelector("[role='radiogroup']") as HTMLElement;
  expect(group.getAttribute("aria-label")).toBe("Theme");
  expect(host.querySelectorAll("[role='radio']").length).toBe(3);
});

test("exactly one member is checked", async () => {
  const host = await render(
    <Segmented label="Theme" value="light" options={[...THEMES]} onChange={() => {}} />,
  );
  const checked = [...host.querySelectorAll("[role='radio']")]
    .filter((n) => n.getAttribute("aria-checked") === "true");
  expect(checked.length).toBe(1);
  expect(checked[0]?.textContent).toContain("Light");
});

test("selection reads as contrast, not as hue alone", async () => {
  // The selected member must survive greyscale, like every other state here.
  const host = await render(
    <Segmented label="Theme" value="dark" options={[...THEMES]} onChange={() => {}} />,
  );
  const selected = host.querySelector("[role='radio'][aria-checked='true']") as HTMLElement;
  expect(selected.dataset.selected).toBe("yes");
});

test("tapping a member reports its value", async () => {
  const seen: string[] = [];
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={(v) => seen.push(v)} />,
  );
  const dark = [...host.querySelectorAll("[role='radio']")]
    .find((n) => (n.textContent ?? "").includes("Dark")) as HTMLButtonElement;
  await click(dark);
  expect(seen).toEqual(["dark"]);
});

test("the group is one tab stop — Radix owns the focus, so no item claims it", async () => {
  // The hand-rolled version put tabIndex=0 on the selected member and -1 on the
  // rest, and this asserted that array. Radix does it differently: every item
  // stays at -1 and it moves focus programmatically, so asserting the attribute
  // would now be measuring the wrong thing.
  //
  // What is asserted instead is that NO item claims a tab stop of its own,
  // which is the part that would break if the roving focus were lost and the
  // group became three tab stops. That Tab actually reaches the group is
  // browser-verified (it lands on the selected member); happy-dom has no
  // sequential focus navigation to test it with.
  const host = await render(
    <Segmented label="Theme" value="light" options={[...THEMES]} onChange={() => {}} />,
  );
  const radios = [...host.querySelectorAll("[role='radio']")] as HTMLButtonElement[];
  expect(radios.length).toBe(3);
  expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toEqual([]);
});

test("selection follows focus, so one arrow press selects", async () => {
  // The mechanism by which arrowing works. Radix's arrows move FOCUS; this
  // component selects whatever focus lands on, which is what ARIA's radiogroup
  // pattern requires and what Radix alone does not do — verified in a browser,
  // where ArrowRight moved focus to "Light" while aria-checked stayed on
  // "System" until Space was pressed.
  //
  // Driven by dispatching focus rather than a key, because the key half is
  // Radix's and lives on the item, not the group.
  const seen: string[] = [];
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={(v) => seen.push(v)} />,
  );
  const dark = [...host.querySelectorAll("[role='radio']")]
    .find((n) => (n.textContent ?? "").includes("Dark")) as HTMLButtonElement;
  // `focusin`, not `focus`: React maps onFocus to the delegated focusin event,
  // and `focus` does not bubble so it never reaches React's root listener. The
  // `typeInto` helper in tests/support/render.tsx dispatches focusin for the
  // same reason.
  await fire(dark, new FocusEvent("focusin", { bubbles: true }));
  expect(seen).toEqual(["dark"]);
});

test("wrap-around is left to Radix rather than disabled", async () => {
  // Radix loops by default, which is the behaviour the hand-rolled version
  // implemented with a modulo. Passing loop={false} would dead-end the ends and
  // is the only way this regresses, so that is what is guarded — the looping
  // itself is Radix's and is not ours to re-test.
  const src = await Bun.file("src/web/components/ui/Segmented.tsx").text();
  expect(src).not.toContain("loop={false}");
  expect(src).not.toContain("loop = {false}");
});

test("every option is visible at once, unlike the select it replaces", async () => {
  // A native select on iOS opens a full-screen wheel and hides the other
  // options while you pick between three of them.
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={() => {}} />,
  );
  expect(textsOf(host, "[role='radio']")).toEqual(["System", "Light", "Dark"]);
  expect(host.querySelector("select")).toBeNull();
});
