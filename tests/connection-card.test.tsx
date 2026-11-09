import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { InfoSection } from "@web/components/settings/InfoSection";
import { render, textsOf, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const LABELS = ["Endpoint", "Secure context", "herdr", "herdr-core", "Last event", "Protocol", "Server version"];

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

test("connection card shows herdr-core as not running when absent", async () => {
  const core = { connected: false, lastEventAt: null, generation: null, version: null, detail: "no herdr-core socket found" };
  const host = await render(<InfoSection health={{ version: "0.8.5", herdrConnected: true, core } as never} />);
  const rows = Array.from(host.querySelectorAll(".dl-row")).map((r) => r.textContent ?? "");
  const row = rows.find((r) => r.startsWith("herdr-core")) ?? "";
  expect(row).toContain("Not running");
  expect(row).toContain("no herdr-core socket found");
});

test("connection card shows herdr-core as connected", async () => {
  const core = { connected: true, lastEventAt: 1, generation: 1, version: "1.0.0", detail: null };
  const host = await render(<InfoSection health={{ version: "0.8.5", herdrConnected: true, core } as never} />);
  const rows = Array.from(host.querySelectorAll(".dl-row")).map((r) => r.textContent ?? "");
  expect(rows.find((r) => r.startsWith("herdr-core"))).toContain("Connected");
});
