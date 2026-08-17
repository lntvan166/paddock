import { expect, test } from "bun:test";
import {
  dismissInstall,
  installNow,
  readInstallEnv,
  shouldOfferInstall,
  type InstallEnv,
  type InstallPromptEvent,
} from "@web/install";

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

test("readInstallEnv survives a storage accessor that throws", () => {
  // Simulate a throwing storage (Safari private mode on write, an enterprise
  // policy or blocked-storage setting on mere access) rather than trying to
  // reproduce a real private-browsing mode. readInstallEnv is called
  // synchronously in render, so a thrown SecurityError here must not
  // propagate and take the whole dashboard down.
  const g = globalThis as Record<string, unknown>;
  const had = {
    window: "window" in g, navigator: "navigator" in g,
    document: "document" in g, localStorage: "localStorage" in g,
  };
  const prev = { window: g.window, navigator: g.navigator, document: g.document, localStorage: g.localStorage };

  g.window = { matchMedia: () => ({ matches: false }) };
  g.navigator = {};
  g.document = {};
  g.localStorage = {
    getItem: () => {
      throw new Error("SecurityError: storage disabled");
    },
    setItem: () => {
      throw new Error("SecurityError: storage disabled");
    },
  };

  try {
    expect(() => readInstallEnv(false)).not.toThrow();
    expect(readInstallEnv(false).dismissed).toBe(false);
    expect(() => dismissInstall()).not.toThrow();
  } finally {
    for (const key of ["window", "navigator", "document", "localStorage"] as const) {
      if (had[key]) g[key] = prev[key];
      else delete g[key];
    }
  }
});

test("the install control triggers the browser's native prompt via the captured event", () => {
  let called = false;
  const fakeEvent: InstallPromptEvent = {
    prompt: () => {
      called = true;
    },
  };
  installNow(fakeEvent);
  expect(called).toBe(true);
});

test("triggering install is a no-op when no event was captured (e.g. iOS Safari)", () => {
  expect(() => installNow(null)).not.toThrow();
});
