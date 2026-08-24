import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Card } from "@web/components/ui/Card";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a control sits inside the header row, beside the title", async () => {
  // The inline-control layout: a toggle centred against a two-line
  // title+subtitle, not pushed below a divider.
  const host = await render(
    <Card title="Haptics" subtitle="A short buzz." control={<button data-test="t" />} />,
  );
  const head = host.querySelector(".card-head") as HTMLElement;
  expect(head.querySelector("[data-test='t']")).not.toBeNull();
});

test("children sit below a divider, in the body", async () => {
  const host = await render(<Card title="Appearance"><span data-test="body" /></Card>);
  const body = host.querySelector(".card-body") as HTMLElement;
  expect(body.querySelector("[data-test='body']")).not.toBeNull();
  expect((host.querySelector(".card-head") as HTMLElement).querySelector("[data-test='body']")).toBeNull();
});

test("a footer states why a control is inert", async () => {
  // A disabled control that says nothing is the failure mode this slot exists
  // to prevent.
  const host = await render(
    <Card title="Push notifications" footer="Blocked for this site in your browser settings." />,
  );
  const footer = host.querySelector(".card-foot") as HTMLElement;
  expect(footer.textContent).toContain("Blocked for this site");
});

test("an absent slot renders no empty box", async () => {
  // An empty divided region reads as a rendering bug.
  const host = await render(<Card title="Bare" />);
  expect(host.querySelector(".card-body")).toBeNull();
  expect(host.querySelector(".card-foot")).toBeNull();
});

test("the title is a heading one level below its settings band, so the page outline distinguishes bands from cards", async () => {
  // `h3`, not `h2`: `Settings.tsx`'s band label ("This device" / "All
  // devices" / "Info") is the `h2` a card nests under. Two bands carry two
  // different commit models — one band writes to localStorage immediately,
  // the other is a form that does nothing until Save succeeds — and a card
  // title competing at the same heading level as its band would erase that
  // distinction for anyone navigating by heading.
  const host = await render(<Card title="Connection" subtitle="Diagnostics." />);
  const h = host.querySelector("h3");
  expect(h?.textContent).toBe("Connection");
});

test("a card with no title renders no empty heading", async () => {
  const host = await render(<Card><span /></Card>);
  expect(host.querySelector("h3")).toBeNull();
});
