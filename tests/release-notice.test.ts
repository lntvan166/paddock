import { expect, test } from "bun:test";
import { shouldShowRelease } from "@web/release-notice";

test("nothing to say when no release is known", () => {
  expect(shouldShowRelease(null, null)).toBe(false);
  expect(shouldShowRelease(null, "0.8.0")).toBe(false);
});

test("a known release shows until it is dismissed", () => {
  expect(shouldShowRelease("0.8.0", null)).toBe(true);
  expect(shouldShowRelease("0.8.0", "0.8.0")).toBe(false);
});

// The whole reason dismissal is keyed by version. A boolean would make the
// first dismissal permanent and the feature would quietly stop existing.
test("REGRESSION: a NEWER release re-shows after an older one was dismissed", () => {
  expect(shouldShowRelease("0.9.0", "0.8.0")).toBe(true);
});

// Downgrades are not a case worth modelling — the server only reports a version
// it has already judged newer than the running one (see update-check.ts). What
// matters is that an unfamiliar value is SHOWN rather than swallowed.
test("any version other than the dismissed one is shown", () => {
  expect(shouldShowRelease("0.7.0", "0.8.0")).toBe(true);
});
