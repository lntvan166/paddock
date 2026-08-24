import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { BuildStamp } from "@web/components/BuildStamp";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the stamp names the bundle's own version, commit and time", async () => {
  // The whole point of showing it: it must report the JavaScript actually
  // running, which is what `buildIdFrom` compares but cannot display.
  const host = await render(<BuildStamp />);
  const text = host.textContent ?? "";
  expect(text).toContain("·");
  expect(text.split("·").length).toBe(3);
});

test("an unstamped build says dev rather than inventing a hash", async () => {
  // build-id.ts's own rule: "Null rather than a placeholder … inventing an id
  // there would make every client believe a new build had just landed". A
  // fabricated commit is the same trap.
  //
  // `bun test` applies no vite define, so this asserts the fallback path
  // unconditionally — there is no branch and nothing to guard.
  const { BUILD } = await import("@web/build");
  expect(BUILD.commit).toBe("dev");
  expect(BUILD.version).toBe("0.0.0-dev");
  const host = await render(<BuildStamp />);
  expect(host.textContent).toContain("dev");
});

test("the stamp is monospace, so a hash is readable", async () => {
  const host = await render(<BuildStamp />);
  expect((host.firstElementChild as HTMLElement).className).toContain("build-stamp");
});
