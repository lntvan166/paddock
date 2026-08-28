import { expect, test } from "bun:test";
import { resolveOpenable } from "@server/files/path";

// Not `/srv/home/…`: that contains `/home/`, which the public-repo scanner
// matches — correctly, since it cannot tell a fixture from a real path.
const HOME = "/srv/operator";

/**
 * The forms `web/paths.ts` LINKIFIES have to be the forms this accepts, or the
 * feature offers a tap that always fails. Found by using it: writing out a
 * `~/…` path and opening it answered "no file at ~/…", because `statSync` does
 * not expand a tilde — that is a shell's job.
 */

test("an absolute path passes through", () => {
  expect(resolveOpenable("/srv/project/a.html", HOME)).toBe("/srv/project/a.html");
});

test("a tilde is expanded, the way the tree's own paths are", () => {
  expect(resolveOpenable("~/notes/a.md", HOME)).toBe(`${HOME}/notes/a.md`);
  expect(resolveOpenable("~", HOME)).toBe(HOME);
});

test("a file URL is a path with a prefix on it", () => {
  expect(resolveOpenable("file:///srv/project/a.pdf", HOME)).toBe("/srv/project/a.pdf");
  // Percent-encoding is part of a URL, not of the name on disk.
  expect(resolveOpenable("file:///srv/my%20notes/a.md", HOME)).toBe("/srv/my notes/a.md");
});

test("surrounding whitespace is not part of the path", () => {
  expect(resolveOpenable("  /srv/a.html\n", HOME)).toBe("/srv/a.html");
});

test("anything whose meaning needs a working directory is refused", () => {
  // paddock cannot see the caller's cwd, so a relative path has no single
  // answer — the same gate `expandHome` applies for the create routes.
  expect(resolveOpenable("relative/a.html", HOME)).toBeNull();
  expect(resolveOpenable("./a.html", HOME)).toBeNull();
  expect(resolveOpenable("", HOME)).toBeNull();
  expect(resolveOpenable("   ", HOME)).toBeNull();
});

test("a tilde with no home to expand to is refused, not half-expanded", () => {
  expect(resolveOpenable("~/notes/a.md", undefined)).toBeNull();
});

test("a malformed escape does not throw", () => {
  // `decodeURIComponent("%")` throws. A bad URL is a refusal, not a 500.
  expect(resolveOpenable("file:///srv/%zz/a.md", HOME)).toBe("/srv/%zz/a.md");
});
