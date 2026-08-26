import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { click, render, textsOf, unmount } from "./support/render";
import { SpacePicker } from "@web/components/SpacePicker";
import type { Space } from "@shared/types";

afterEach(async () => { await unmount(); });

const space = (spaceId: string, label: string | null, state: "blocked" | "idle" | null): Space => ({
  spaceId, label, tabCount: 1, paneCount: 1,
  tabs: [{ tabId: `${spaceId}:t1`, label: null, panes: [{
    paneId: `${spaceId}:p1`, harness: state === null ? null : "claude",
    name: null, title: "t", cwd: "/srv/project", state,
  }] }],
});

const SPACES = [
  space("w1", "docs-cleanup", "idle"),
  space("w2", "schema-migration", "idle"),
  space("w3", "flaky-test-fix", "blocked"),
  space("w4", null, null),
];

test("the trigger is the space's own name, and it is a control", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  const trigger = host.querySelector("[data-space-picker]")!;
  expect(trigger.tagName).toBe("BUTTON");
  expect(trigger.textContent).toContain("schema-migration");
});

test("opening it lists every space, blocked first", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  await click(host.querySelector("[data-space-picker]"));
  const names = textsOf(document.body as HTMLElement, "[data-picker-row] .space-name");
  expect(names.length).toBe(4);
  expect(names[0]).toBe("flaky-test-fix");
  // A space with no agent sorts last, and an unnamed one still says something:
  // its id, because a blank row is not a row.
  expect(names[3]).toBe("w4");

  // The null-state marker `ui/StateMarker.tsx` was hoisted for, on the
  // surface it was hoisted for: `w4` has no agent, so it gets `.dot-none`
  // (never `idle`'s hollow ring) and says "no agent" in words.
  const rows = [...document.querySelectorAll("[data-picker-row]")];
  const noAgentRow = rows.find((r) => r.querySelector(".space-name")?.textContent === "w4")!;
  expect(noAgentRow.querySelector(".dot-none")).not.toBeNull();
  expect(noAgentRow.querySelector(".space-state")?.textContent).toBe("no agent");
});

test("the space you are in is marked, and the others are not", async () => {
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  await click(host.querySelector("[data-space-picker]"));
  const here = [...document.querySelectorAll("[data-picker-row]")]
    .filter((r) => r.getAttribute("aria-current") === "true");
  expect(here.length).toBe(1);
  expect(here[0]!.textContent).toContain("schema-migration");
});

test("the mark is VISIBLE, not aria-current alone", async () => {
  // §5.2 asks for the current space "marked" — `aria-current` reaches a
  // screen reader, but a sighted operator gets nothing from an ARIA
  // attribute. Combined with the no-self-navigate guard (tapping the current
  // row just closes the sheet), an unmarked row is a control that appears to
  // do nothing.
  const host = await render(<SpacePicker spaces={SPACES} currentId="w2" />);
  await click(host.querySelector("[data-space-picker]"));
  const rows = [...document.querySelectorAll("[data-picker-row]")];
  const here = rows.find((r) => r.getAttribute("aria-current") === "true")!;
  const elsewhere = rows.filter((r) => r !== here);
  expect(here.querySelector(".picker-current")).not.toBeNull();
  for (const row of elsewhere) {
    expect(row.querySelector(".picker-current")).toBeNull();
  }
});

test("choosing a space navigates to it", async () => {
  const seen: string[] = [];
  const host = await render(
    <SpacePicker spaces={SPACES} currentId="w2" navigate={(h) => seen.push(h)} />,
  );
  await click(host.querySelector("[data-space-picker]"));
  const row = [...document.querySelectorAll("[data-picker-row]")]
    .find((r) => r.textContent?.includes("flaky-test-fix"))!;
  await click(row);
  expect(seen).toEqual(["#/space/w3"]);
});

test("choosing the space you are already in still closes, and does not re-navigate", async () => {
  const seen: string[] = [];
  const host = await render(
    <SpacePicker spaces={SPACES} currentId="w2" navigate={(h) => seen.push(h)} />,
  );
  await click(host.querySelector("[data-space-picker]"));
  const row = [...document.querySelectorAll("[data-picker-row]")]
    .find((r) => r.getAttribute("aria-current") === "true")!;
  await click(row);
  expect(seen).toEqual([]);
  expect(document.querySelector("[data-picker-row]")).toBeNull();
});
