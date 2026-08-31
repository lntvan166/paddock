import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { TOUR_URL } from "@shared/links";
import { HelpSection } from "@web/components/settings/HelpSection";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the card links to the tour, opened outside the app", async () => {
  const host = await render(<HelpSection />);
  const a = host.querySelector("a") as HTMLAnchorElement;
  expect(a.getAttribute("href")).toBe(TOUR_URL);
  expect(a.getAttribute("target")).toBe("_blank");
  expect(a.getAttribute("rel")).toContain("noopener");
});

test("the link says where it goes, since it leaves the app", async () => {
  const host = await render(<HelpSection />);
  expect((host.textContent ?? "").toLowerCase()).toContain("how to use");
});
