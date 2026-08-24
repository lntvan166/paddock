// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { StatusDot } from "@web/components/ui/StatusDot";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a resting agent is a hollow ring, not a disc", async () => {
  // The palette is tuned for TEXT contrast, so as solid discs the resting
  // states carry as much weight as the one thing that needs a person —
  // eighteen idle dots out-shout one blocked agent.
  const host = await render(<StatusDot state="idle" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.dataset.fill).toBe("ring");
});

test("the ring's interior is painted, never transparent", async () => {
  // Over a tile corner a transparent interior reads as a notch cut out of the
  // icon rather than as a dot sitting on it.
  const host = await render(<StatusDot state="idle" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.style.background).toBe("var(--bg)");
});

test("a card-hosted ring can be told which surface it sits on", async () => {
  const host = await render(<StatusDot state="idle" surfaceVar="--surface" />);
  const dot = host.querySelector("span") as HTMLElement;
  expect(dot.style.background).toBe("var(--surface)");
});

test("every active state is a solid disc", async () => {
  for (const state of ["blocked", "working", "done"] as const) {
    const host = await render(<StatusDot state={state} />);
    const dot = host.querySelector("span") as HTMLElement;
    expect(dot.dataset.fill).toBe("solid");
    await unmount();
  }
});

test("the dot is hidden from assistive tech, because the state is text beside it", async () => {
  const host = await render(<StatusDot state="blocked" />);
  expect(host.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
});
