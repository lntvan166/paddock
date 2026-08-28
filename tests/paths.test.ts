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
