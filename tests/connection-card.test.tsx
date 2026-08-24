import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { InfoSection } from "@web/components/settings/InfoSection";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const LABELS = ["Endpoint", "Secure context", "herdr", "Last event", "Protocol", "Server build"];

test("every diagnostics row is rendered before the data arrives", async () => {
  // A row that appears when its data lands GROWS the card and shoves
  // everything below it down the page — under a thumb already reaching for
  // something.
  const host = await render(<InfoSection health={null} />);
  expect(textsOf(host, ".dl-label")).toEqual(LABELS);
});

test("a pending value is an em dash, not an empty cell", async () => {
  const host = await render(<InfoSection health={null} />);
  const values = textsOf(host, ".dl-value");
  expect(values.length).toBe(LABELS.length);
  expect(values.some((v) => v.includes("—"))).toBe(true);
});

test("the running version is in the Updates subtitle", async () => {
  // Where collie puts it, and it keeps the card body free for the action.
  const host = await render(
    <InfoSection health={{ version: "0.8.5", herdrConnected: true } as never} />,
  );
  const subs = textsOf(host, ".card-sub");
  expect(subs.some((s) => s.includes("0.8.5"))).toBe(true);
});

test("values are monospace, because a build id is not prose", async () => {
  const host = await render(<InfoSection health={null} />);
  expect((host.querySelector(".dl-value") as HTMLElement).className).toContain("dl-value");
});
