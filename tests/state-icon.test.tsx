import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { StateIcon } from "@web/components/ui/StateIcon";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("blocked and done each get their own shape", async () => {
  // A third channel, after colour and text. Red-and-green is the classic
  // indistinguishable pair and this palette uses both for the two states an
  // operator most needs to tell apart — so the states that are STATED get a
  // shape too, not just a hue and a word.
  const blocked = await render(<StateIcon state="blocked" />);
  const blockedShape = blocked.querySelector("svg")?.innerHTML ?? "";
  await unmount();

  const done = await render(<StateIcon state="done" />);
  const doneShape = done.querySelector("svg")?.innerHTML ?? "";

  expect(blockedShape).not.toBe("");
  expect(doneShape).not.toBe("");
  expect(blockedShape).not.toBe(doneShape);
});

test("each carries its state's colour as well as its shape", async () => {
  // Asserted on `stroke`, not `color`: lucide takes a `color` prop and renders
  // it as the SVG's stroke, since its glyphs are outlines rather than fills.
  // Both values are paddock tokens, so these follow the theme.
  const blocked = await render(<StateIcon state="blocked" />);
  expect(blocked.querySelector("svg")?.getAttribute("stroke")).toBe("var(--danger)");
  await unmount();

  const done = await render(<StateIcon state="done" />);
  expect(done.querySelector("svg")?.getAttribute("stroke")).toBe("var(--ok)");
});

test("working and idle render nothing", async () => {
  // Deliberately not every state. `working` already has a pulsing dot and
  // `idle` has nothing to say — giving all four an icon would spend the
  // distinction that makes these two carry weight.
  for (const state of ["working", "idle"] as const) {
    const host = await render(<StateIcon state={state} />);
    expect(host.querySelector("svg")).toBeNull();
    await unmount();
  }
});

test("the icon is decorative, because the word is right beside it", async () => {
  // Every place this renders, the state is already written out — "Waiting for
  // input", "Finished", "blocked". Announcing the shape too would just repeat
  // it.
  const host = await render(<StateIcon state="blocked" />);
  expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});
