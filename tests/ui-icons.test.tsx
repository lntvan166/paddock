import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import * as icons from "@web/components/ui/icons";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const NAMES = [
  "MonitorIcon", "ActivityIcon", "TerminalIcon", "BellIcon",
  "SendIcon", "LinkIcon", "RefreshIcon", "PlugIcon",
] as const;

test("there is one glyph per settings card", () => {
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
