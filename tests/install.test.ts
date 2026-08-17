import { expect, test } from "bun:test";
import { shouldOfferInstall, type InstallEnv } from "@web/install";

const base: InstallEnv = {
  standalone: false, installEventSeen: false, iosSafari: false, dismissed: false,
};

test("offers when the browser fired the install event", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true })).toBe(true);
});

test("offers on iOS Safari, which has no install event", () => {
  expect(shouldOfferInstall({ ...base, iosSafari: true })).toBe(true);
});

test("does NOT offer when already installed", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true, standalone: true })).toBe(false);
});

test("does NOT offer once dismissed", () => {
  expect(shouldOfferInstall({ ...base, installEventSeen: true, dismissed: true })).toBe(false);
});

test("does NOT offer to a browser that cannot install", () => {
  // A desktop browser without install support must see nothing — the old bug was
  // showing a mobile-only button purely because of a device guess.
  expect(shouldOfferInstall(base)).toBe(false);
});
