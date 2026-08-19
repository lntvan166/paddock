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
  const KEYS = ["window", "navigator", "document", "localStorage"] as const;
  /**
   * The real descriptors, so the restore puts back what was there — not a
   * writable copy of its value.
   *
   * Restoring with `{writable: true, configurable: true}` would leave these
   * globals writable for every file that runs after this one, so whether a
   * later `globalThis.window = …` succeeds would depend on whether this test
   * ran first. That is the same file-order dependency this test was fixed to
   * remove, pointing the other way. One structure rather than parallel
   * `had`/`prev` literals, which could disagree the day a fifth global is
   * added.
   */
  const before = new Map(KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));

  /**
   * `defineProperty`, never plain assignment.
   *
   * `tests/support/dom.ts` registers happy-dom for the component tests, and Bun
   * runs every test file in ONE process — so whether these globals are writable
   * here depends on which file ran first, which is file-order and not something
   * this test can choose. Under happy-dom they are readonly, and `g.navigator =
   * {}` throws `TypeError: Attempted to assign to readonly property`. It failed
   * in CI and not locally for exactly that reason, after four new test files
   * shifted the order.
   *
   * Defining the property works either way, and `configurable: true` is what
   * lets the restore below put the original back.
   */
  const put = (k: string, v: unknown) =>
    Object.defineProperty(g, k, { value: v, writable: true, configurable: true });

  try {
    // INSIDE the try, because a throw while faking is exactly the case that
    // must still restore. Setting up first left `window` faked and `navigator`
    // not, for every DOM test that ran afterwards — one failure here produced a
    // second, unrelated one in another file.
    put("window", { matchMedia: () => ({ matches: false }) });
    put("navigator", {});
    put("document", {});
    put("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: storage disabled");
      },
      setItem: () => {
        throw new Error("SecurityError: storage disabled");
      },
    });

    expect(() => readInstallEnv(false)).not.toThrow();
    expect(readInstallEnv(false).dismissed).toBe(false);
    expect(() => dismissInstall()).not.toThrow();
  } finally {
    // Restored by DESCRIPTOR, not by value: assignment would hit the same
    // readonly wall, and a writable copy would hand every later file a
    // different environment than it would have had.
    for (const key of KEYS) {
      const desc = before.get(key);
      if (desc) Object.defineProperty(g, key, desc);
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
