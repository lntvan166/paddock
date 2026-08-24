import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { IconTile, brandKey, markFor } from "@web/components/ui/IconTile";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a known harness renders its mark instead of initials", async () => {
  // Initials were the original choice. An operator running only claude asked
  // for the real mark, which is quicker to recognise than "CL" at 28px.
  const host = await render(<IconTile harness="claude" />);
  expect(host.querySelector(".tile svg")).not.toBeNull();
  expect(host.querySelector(".tile-initials")).toBeNull();
});

test("an unknown harness still falls back to initials", async () => {
  // The fallback is the whole reason the initials path survives: herdr grows
  // harnesses paddock has not heard of, and those must stay identifiable
  // rather than rendering a blank circle.
  const host = await render(<IconTile harness="some-future-harness" />);
  expect(host.querySelector(".tile svg")).toBeNull();
  expect(host.querySelector(".tile-initials")?.textContent).toBe("SF");
});

test("harness variants resolve to the same mark", async () => {
  // herdr reports the harness as its own name, and "claude-code" is the same
  // product as "claude". A table keyed on the exact string would miss it.
  expect(brandKey("claude")).toBe("claude");
  expect(brandKey("claude-code")).toBe("claude");
  expect(brandKey("Claude")).toBe("claude");
  expect(brandKey("codex")).toBeNull();
});

test("markFor answers null for anything it has no mark for", () => {
  // Null rather than a placeholder glyph: a wrong mark is worse than initials,
  // because it claims an identity the agent does not have.
  expect(markFor("claude")).not.toBeNull();
  expect(markFor("some-future-harness")).toBeNull();
});

test("the tile is still named for assistive tech, mark or not", async () => {
  // The mark is decorative; the harness name is the information. Losing the
  // label when the mark replaced the initials would have made every row
  // announce nothing about which agent it runs.
  const host = await render(<IconTile harness="claude" />);
  expect(host.querySelector(".tile")?.getAttribute("aria-label")).toBe("claude");
  expect(host.querySelector(".tile svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("a marked tile keeps its own background, so it reads on both themes", async () => {
  const host = await render(<IconTile harness="claude" />);
  const tile = host.querySelector(".tile") as HTMLElement;
  expect(tile.style.background).not.toBe("");
});
