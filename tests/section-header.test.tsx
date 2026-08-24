import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { SectionHeader } from "@web/components/Section";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a section can carry the dot of the state it collects", async () => {
  const host = await render(<SectionHeader title="Needs you" count={1} dotState="blocked" />);
  expect(host.querySelector(".dot")).not.toBeNull();
});

test("a section with no dot state renders no dot", async () => {
  const host = await render(<SectionHeader title="Idle" count={0} />);
  expect(host.querySelector(".dot")).toBeNull();
});

test("an unexpandable header exposes no fold control", async () => {
  // Collapsing an alert defeats the alert, so those sections pass no toggle at
  // all rather than a disabled one.
  const host = await render(<SectionHeader title="Needs you" count={1} dotState="blocked" />);
  expect(host.querySelector("button[aria-expanded]")).toBeNull();
});
