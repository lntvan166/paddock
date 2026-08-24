import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Segmented } from "@web/components/ui/Segmented";
import { render, textsOf, unmount } from "./support/render";

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
  dark.click();
  expect(seen).toEqual(["dark"]);
});

test("the group is one tab stop, not one per option", async () => {
  // A radiogroup promises one tab stop with arrow keys between members. Three
  // tab stops for a three-option control is the "role added, behaviour not"
  // anti-pattern, and the settings screen has two of these controls.
  const host = await render(
    <Segmented label="Theme" value="light" options={[...THEMES]} onChange={() => {}} />,
  );
  const radios = [...host.querySelectorAll("[role='radio']")] as HTMLButtonElement[];
  expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
});

test("an arrow key moves the selection", async () => {
  const seen: string[] = [];
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={(v) => seen.push(v)} />,
  );
  const group = host.querySelector("[role='radiogroup']") as HTMLElement;
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(seen).toEqual(["light"]);
});

test("arrow keys wrap rather than dead-ending", async () => {
  const seen: string[] = [];
  const host = await render(
    <Segmented label="Theme" value="system" options={[...THEMES]} onChange={(v) => seen.push(v)} />,
  );
  const group = host.querySelector("[role='radiogroup']") as HTMLElement;
  group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(seen).toEqual(["dark"]);
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
