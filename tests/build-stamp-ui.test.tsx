import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { BuildStamp } from "@web/components/BuildStamp";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("the stamp names the version, and only the version", async () => {
  // It carried `version · commit · time` until an operator asked for the
  // version alone. The commit was what distinguished two builds of the SAME
  // version — but noticing a stale tab is already `UpdateBar`'s job, which
  // compares the server's build id rather than reading this footer. So the
  // stamp answers one question now: what version is this.
  const host = await render(<BuildStamp />);
  const text = (host.textContent ?? "").trim();
  expect(text).toBe("v0.0.0-dev");
  // The separator went with the other two fields. A stamp still carrying one
  // would mean a field was dropped from the render but not from the string.
  expect(text).not.toContain("·");
});

test("an unstamped build says so, rather than inventing a version", async () => {
  // `src/server/version.ts` establishes the contract: a build with no tag
  // reports 0.0.0-dev, so a bug filed against a self-compiled binary says as
  // much. `bun test` applies no vite define, so this is the path under test.
  const { BUILD } = await import("@web/build");
  expect(BUILD.version).toBe("0.0.0-dev");
  const host = await render(<BuildStamp />);
  expect(host.textContent).toContain("0.0.0-dev");
});

test("the stamp is monospace, because a version is a value to compare", async () => {
  const host = await render(<BuildStamp />);
  expect((host.firstElementChild as HTMLElement).className).toContain("build-stamp");
});
