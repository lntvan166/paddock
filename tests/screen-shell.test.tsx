// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { Settings } from "@web/components/Settings";
import { Spaces } from "@web/components/Spaces";
import { render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
});

/**
 * The chrome of a screen must not scroll away with its content.
 *
 * Reported from use: to leave Settings you had to scroll back to the top to
 * reach Back. That was true of every screen except the terminal, which has
 * always been `position: fixed` with `flex: none` chrome and one scrolling
 * region — so the fix is that shell, applied everywhere, rather than a new
 * mechanism.
 *
 * These tests assert the STRUCTURE that makes it work, which is the part a
 * future edit can silently undo: the header is a sibling of the scrolling
 * region, not a child of it. A CSS-only assertion would not catch a refactor
 * that moved the header inside `.screen-body`, and that is exactly the shape
 * of the regression — it still looks right until you scroll.
 */

/** A complete `SettingsView`. Complete deliberately: `<Settings>` reads
 *  `baseline.telegram.chatId` on mount, so a partial fixture fails to render
 *  for a reason that has nothing to do with what these tests assert. */
const VIEW = {
  telegram: { configured: false, hint: null, chatId: null },
  notify: {
    telegram: false,
    triggers: [],
    settleMs: {},
    mutedUntil: null,
    cooldownMs: 0,
    skipWhileViewing: false,
  },
  push: { enabled: false, devices: 0, vapidPublicKey: null, error: null },
  publicUrl: null,
  tunnel: null,
  serverNow: 0,
  error: null,
};

test("Settings pins its header outside the scrolling region", async () => {
  stubFetch({ "/api/settings": () => VIEW, "/api/health": () => ({}) });
  const host = await render(<Settings onBack={() => {}} />);
  await settle();

  const screen = host.querySelector(".screen");
  expect(screen, "Settings renders the shared fixed shell").not.toBeNull();

  const header = screen!.querySelector(".settings-header");
  const body = screen!.querySelector(".screen-body");
  expect(header, "the header is inside the shell").not.toBeNull();
  expect(body, "the shell has one scrolling region").not.toBeNull();

  // The whole point: the header is a SIBLING of the scroller, never inside it.
  expect(
    body!.contains(header!),
    "the header must not live inside the scrolling region, or it scrolls away",
  ).toBe(false);
});

test("Spaces pins its header outside the scrolling region", async () => {
  const host = await render(
    <Spaces onBack={() => {}} load={async () => ({ spaces: [], readAt: 0 })} />,
  );
  await settle();

  const screen = host.querySelector(".screen");
  expect(screen).not.toBeNull();

  const header = screen!.querySelector(".spaces-head");
  const body = screen!.querySelector(".screen-body");
  expect(header).not.toBeNull();
  expect(body).not.toBeNull();
  expect(
    body!.contains(header!),
    "Back must stay reachable at any scroll position",
  ).toBe(false);
});
