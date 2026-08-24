import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { IconTile, hueFor, initialsFor } from "@web/components/ui/IconTile";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a one-word harness gives its first two letters", () => {
  expect(initialsFor("claude")).toBe("CL");
  expect(initialsFor("codex")).toBe("CO");
});

test("a compound harness gives one letter per segment", () => {
  // herdr reports variants, and "CC" is more use than "CL" repeated for every
  // claude-shaped harness.
  expect(initialsFor("claude-code")).toBe("CC");
  expect(initialsFor("open_code")).toBe("OC");
});

test("a single-letter harness still produces something renderable", () => {
  // Never an empty tile: an unknown or degenerate harness must stay legible
  // rather than rendering a blank circle nobody can identify.
  expect(initialsFor("x")).toBe("X");
});

test("an unknown harness is a tile, not a blank", () => {
  expect(initialsFor("some-future-harness")).toBe("SF");
});

test("hue is stable for the same harness across calls", () => {
  // A tile that changed colour between renders would read as a different
  // agent.
  expect(hueFor("claude")).toBe(hueFor("claude"));
  expect(hueFor("codex")).toBe(hueFor("codex"));
});

test("hue is always a valid palette index", () => {
  for (const h of ["claude", "codex", "pi", "opencode", "", "zzzzzzzz"]) {
    const i = hueFor(h);
    expect(Number.isInteger(i)).toBe(true);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(6);
  }
});

test("the tile carries its own background, so one definition reads on both themes", async () => {
  const host = await render(<IconTile harness="claude" />);
  const tile = host.querySelector(".tile") as HTMLElement;
  expect(tile.style.background).toContain("var(--tile-");
});

test("the tile is round", async () => {
  const host = await render(<IconTile harness="claude" />);
  expect((host.querySelector(".tile") as HTMLElement).dataset.shape).toBe("round");
});

test("the initials are hidden from assistive tech and the harness is named instead", async () => {
  // "CL" read aloud is noise; the harness name is the information.
  const host = await render(<IconTile harness="claude" />);
  const tile = host.querySelector(".tile") as HTMLElement;
  expect(tile.getAttribute("aria-label")).toBe("claude");
  expect(tile.querySelector("[aria-hidden='true']")?.textContent).toBe("CL");
});

test("a badge is overlaid rather than placed beside the tile", async () => {
  // At 390px the horizontal budget is the scarce one: an overlaid dot costs
  // nothing where a sibling dot costs a column.
  const host = await render(<IconTile harness="claude" badge={<i data-test="b" />} />);
  const badge = host.querySelector(".tile-badge") as HTMLElement;
  expect(badge).not.toBeNull();
  expect(badge.querySelector("[data-test='b']")).not.toBeNull();
});
