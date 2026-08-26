import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { render, stubFetch, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

test("a settings load that fails shows the error, not a blank screen", async () => {
  // The pre-existing bug: the initial GET cast its body to SettingsView with no
  // res.ok check, so a 404 or 500 left `telegram` undefined and the render read
  // `baseline.telegram.chatId` — throwing, and taking the whole screen with it.
  // An operator then sees white. The component already HAS a loadError banner;
  // it was simply never reached.
  const { fn } = stubFetch({});               // every route 500s with no stub
  const original = globalThis.fetch;
  globalThis.fetch = fn as typeof fetch;
  try {
    const host = await render(<Settings />);
    expect(host.textContent ?? "").not.toBe("");
    expect((host.textContent ?? "").toLowerCase()).toContain("settings");
  } finally {
    globalThis.fetch = original;
  }
});
