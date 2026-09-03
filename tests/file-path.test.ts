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

/**
 * Relative paths, resolved against the agent that printed them.
 *
 * This module's own comment said a relative path "has no single answer,
 * because paddock cannot see the caller's working directory" — and that
 * stopped being true once `cwd` landed on the Agent payload. A transcript
 * belongs to a pane, a pane names an agent, and that agent has a directory it
 * is running in. The route looks it up server-side rather than taking it from
 * the client, so the base stays authoritative.
 *
 * With NO base the old refusal stands, unchanged: an absolute path or nothing.
 */
test("a relative path resolves against the base it is given", () => {
  expect(resolveOpenable("docs/report.md", HOME, "/srv/project")).toBe(
    "/srv/project/docs/report.md",
  );
});

test("./ and ../ mean what a shell would mean by them", () => {
  expect(resolveOpenable("./notes.md", undefined, "/srv/project")).toBe("/srv/project/notes.md");
  expect(resolveOpenable("../sibling/a.html", undefined, "/srv/project/sub")).toBe(
    "/srv/project/sibling/a.html",
  );
});

test("a trailing slash on the base does not double up", () => {
  expect(resolveOpenable("a.md", undefined, "/srv/project/")).toBe("/srv/project/a.md");
});

test("an absolute path ignores the base entirely", () => {
  // It already means one thing. A base that could override it would make the
  // same link open different files in different panes.
  expect(resolveOpenable("/srv/a.md", undefined, "/elsewhere")).toBe("/srv/a.md");
});

test("a tilde path ignores the base too, and still expands", () => {
  expect(resolveOpenable("~/notes/a.md", HOME, "/srv/project")).toBe(
    `${HOME}/notes/a.md`,
  );
});

test("with no base, a relative path is still refused", () => {
  // The pane may have no agent, and an agent may report no cwd. Guessing a base
  // would open a file the operator did not name.
  expect(resolveOpenable("docs/a.md", HOME, undefined)).toBeNull();
  expect(resolveOpenable("docs/a.md", HOME, "")).toBeNull();
});

test("a relative base is not a base", () => {
  // It resolves against nothing in particular, which is the same failure this
  // whole module exists to refuse.
  expect(resolveOpenable("a.md", undefined, "relative/dir")).toBeNull();
});
