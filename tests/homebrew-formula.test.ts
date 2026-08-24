import { expect, test } from "bun:test";
import { renderFormula } from "../scripts/render-formula";

const TMPL = await Bun.file("packaging/homebrew/paddock.rb.tmpl").text();

/**
 * The four assets release.yml publishes. Deliberately repeated here rather
 * than imported from update.ts: this is the list a MAC user's `brew install`
 * depends on, and a test that derived it from the same source as the code
 * would agree with a mistake in that source.
 */
const ASSETS = [
  "paddock-linux-x86_64",
  "paddock-linux-aarch64",
  "paddock-macos-x86_64",
  "paddock-macos-aarch64",
];

/** A stand-in SHA256SUMS, in the format `sha256sum` actually writes. */
const SUMS = ASSETS.map((a, i) => `${String(i + 1).repeat(64)}  ${a}`).join("\n") + "\n";

test("no placeholder survives into the rendered formula", () => {
  // An unsubstituted {{...}} is not a cosmetic bug: `sha256 "{{sha256:...}}"`
  // is valid Ruby, so brew would accept the formula and fail every install
  // with a checksum mismatch instead of a syntax error.
  const out = renderFormula(TMPL, "1.2.3", SUMS);
  expect(out).not.toContain("{{");
  expect(out).not.toContain("}}");
});

test("each platform gets its own checksum, not another platform's", () => {
  const out = renderFormula(TMPL, "1.2.3", SUMS);
  for (const [i, asset] of ASSETS.entries()) {
    const digest = String(i + 1).repeat(64);
    expect(out).toContain(digest);
    // The digest must sit in the same block as the asset it belongs to: a
    // renderer that substituted all four correctly but in the wrong order
    // would still satisfy a bare `toContain` on each.
    const at = out.indexOf(asset);
    expect(at).toBeGreaterThan(-1);
    const nearby = out.slice(Math.max(0, at - 200), at + 200);
    expect(nearby).toContain(digest);
  }
});

test("the version reaches both the url and the version field", () => {
  const out = renderFormula(TMPL, "1.2.3", SUMS);
  expect(out).toContain('version "1.2.3"');
  expect(out).toContain("download/v1.2.3/");
});

test("a checksum missing from SHA256SUMS is refused, not left blank", () => {
  // A release published without one of its assets must fail the render, not
  // ship a formula whose sha256 is the empty string.
  const partial = `${"1".repeat(64)}  paddock-linux-x86_64\n`;
  expect(() => renderFormula(TMPL, "1.2.3", partial)).toThrow(/paddock-linux-aarch64/);
});

test("the template covers exactly the four platforms herdr supports", () => {
  for (const a of ASSETS) expect(TMPL).toContain(a);
  expect(TMPL).not.toContain("windows");
  expect(TMPL).not.toContain("Windows");
});

test("the formula depends on herdr, which is in homebrew-core", () => {
  // paddock reads herdr's unix socket and does nothing without it. herdr is
  // a core formula, and a tap formula may depend on core, so brew can
  // guarantee it is present instead of `paddock doctor` reporting its
  // absence after the fact.
  expect(TMPL).toContain('depends_on "herdr"');
});

test("the formula smoke-tests the binary it installed", () => {
  // Homebrew runs `brew test` in CI and on request. Asserting the version
  // catches the failure mode this project has already hit once: a binary
  // that reports 0.0.0-dev because a build-time define did not reach it.
  expect(TMPL).toContain("test do");
  expect(TMPL).toContain("--version");
});
