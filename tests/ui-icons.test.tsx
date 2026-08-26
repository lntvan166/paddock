import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import * as icons from "@web/components/ui/icons";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

// EVERY glyph in the module, not just the settings cards'. This list was a
// closed eight while `icons.tsx` had nine — the ninth being `SpacesIcon`, on
// the only route into the new screen, with none of the invariants below guarded.
// A list that has to be extended by hand is extended by hand: add the name here
// in the same change that adds the glyph.
const NAMES = [
  "MonitorIcon", "ActivityIcon", "TerminalIcon", "BellIcon",
  "SendIcon", "LinkIcon", "RefreshIcon", "PlugIcon",
  "SpacesIcon", "SettingsIcon", "KeyboardIcon", "BackspaceIcon",
] as const;

test("every icon the module exports is in the list the tests below walk", async () => {
  // What actually stops the list going stale: a glyph added to `icons.tsx` and
  // not added above fails HERE rather than silently going unguarded.
  const exported = Object.keys(icons).filter((k) => k.endsWith("Icon")).sort();
  expect(exported).toEqual([...NAMES].sort());
});

test("there is one glyph per settings card, plus the two header controls", () => {
  for (const n of NAMES) expect(typeof (icons as Record<string, unknown>)[n]).toBe("function");
});

test("every glyph is decorative, so a card's title is not read twice", async () => {
  for (const n of NAMES) {
    const Icon = (icons as Record<string, React.FC>)[n]!;
    const host = await render(<Icon />);
    const svg = host.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    await unmount();
  }
});

test("every glyph inherits its colour, so one definition serves both themes", async () => {
  for (const n of NAMES) {
    const Icon = (icons as Record<string, React.FC>)[n]!;
    const host = await render(<Icon />);
    const svg = host.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    // A hardcoded hex would be invisible in one of the two themes.
    expect(host.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    await unmount();
  }
});

test("no icon library is imported", async () => {
  const src = await Bun.file("src/web/components/ui/icons.tsx").text();
  expect(src).not.toContain("lucide");
  expect(src).not.toContain("react-icons");
});

test("the settings glyph is a gear or a slider, never a sun", async () => {
  // It drew a circle at the centre with six DETACHED ticks around it and no
  // outer rim, which is the standard brightness glyph — a gear's teeth are
  // teeth OF a rim, and without one they are ticks. A circle centred at 12,12
  // is what both the sun and the abandoned gear have in common, so its absence
  // is the discriminator.
  const host = await render(<icons.SettingsIcon />);
  const svg = host.querySelector("svg")!;
  expect(svg.querySelectorAll('circle[cx="12"][cy="12"]').length).toBe(0);
  await unmount();
});
