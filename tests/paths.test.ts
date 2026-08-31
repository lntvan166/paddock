import { expect, test } from "bun:test";
import { splitPaths } from "@web/paths";

const span = (text: string) => ({ text });
const pathsIn = (text: string) =>
  splitPaths([span(text)]).filter((s) => s.path !== undefined).map((s) => s.path);

test("an absolute path becomes its own span", () => {
  const out = splitPaths([span("wrote /srv/project/a.html ok")]);
  expect(out.map((s) => s.text)).toEqual(["wrote ", "/srv/project/a.html", " ok"]);
  expect(out[1]!.path).toBe("/srv/project/a.html");
});

test("a tilde path and a file URL both count", () => {
  expect(pathsIn("see ~/notes/a.md")).toEqual(["~/notes/a.md"]);
  expect(pathsIn("see file:///srv/a.pdf")).toEqual(["file:///srv/a.pdf"]);
});

test("a path at the very start of a line is found", () => {
  // The common shape: a tool prints the file it wrote and nothing else.
  expect(pathsIn("/srv/project/a.html")).toEqual(["/srv/project/a.html"]);
});

test("trailing punctuation belongs to the sentence, not the filename", () => {
  expect(pathsIn("wrote /srv/a.html.")).toEqual(["/srv/a.html"]);
  expect(pathsIn("(see /srv/a.html)")).toEqual(["/srv/a.html"]);
  expect(pathsIn("/srv/a.html, then")).toEqual(["/srv/a.html"]);
});

test("prose containing a slash is not a path", () => {
  // The same rule the slash-command trigger uses, and the same regression it
  // guards: a slash inside a word is not an address.
  expect(pathsIn("read src/web/api.ts")).toEqual([]);
  expect(pathsIn("and/or")).toEqual([]);
  expect(pathsIn("http://example.com/x")).toEqual([]);
});

test("two paths on one line are both found", () => {
  expect(pathsIn("moved /srv/a.md to /srv/b.md")).toEqual(["/srv/a.md", "/srv/b.md"]);
});

test("a bare slash is punctuation, not an address", () => {
  expect(pathsIn("either / or")).toEqual([]);
  expect(pathsIn("~ is home")).toEqual([]);
});

test("styling survives the split", () => {
  const out = splitPaths([{ text: "at /srv/a.html", bold: true, fg: "#fff" }]);
  expect(out.every((s) => s.bold === true && s.fg === "#fff")).toBe(true);
});

test("a span with no path is returned untouched", () => {
  const input = [{ text: "nothing here", dim: true }];
  expect(splitPaths(input)).toEqual(input);
});

/**
 * The boundary used to be a zero-width lookbehind and is a consumed capture
 * group now, because Safari had no lookbehind before 16.4 and the shipped
 * bundle threw on load in it. These are the cases that distinguish the two.
 */
test("paths separated by a single space are both found", () => {
  // The old zero-width boundary left the space for the next match to look
  // behind at. Consuming it must not eat the second path's own boundary.
  expect(pathsIn("/srv/a.md /srv/b.md")).toEqual(["/srv/a.md", "/srv/b.md"]);
});

test("the text between two adjacent paths survives intact", () => {
  // The offset the split uses moved from `m.index` to `m.index + m[1].length`.
  // Get that wrong and the separating space is swallowed into the prose span
  // before it, or duplicated into the one after.
  const out = splitPaths([span("/srv/a.md /srv/b.md")]);
  expect(out.map((s) => s.text).join("")).toBe("/srv/a.md /srv/b.md");
});

test("a path after a tab or newline still counts", () => {
  expect(pathsIn("see\t/srv/a.md")).toEqual(["/srv/a.md"]);
  expect(pathsIn("see\n/srv/a.md")).toEqual(["/srv/a.md"]);
});

test("no span is dropped or duplicated when a path leads the line", () => {
  const out = splitPaths([span("/srv/a.md was written")]);
  expect(out.map((s) => s.text).join("")).toBe("/srv/a.md was written");
});
