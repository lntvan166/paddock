import { expect, test } from "bun:test";
import { kindFor, MAX_FILE_BYTES } from "@server/files/kinds";

/**
 * What a file is, for the purpose of showing it on a phone.
 *
 * Derived from the EXTENSION, deliberately unlike `uploads/store.ts`, which
 * sniffs the bytes: that route accepts what a phone sends and hands it to an
 * agent, this one reads a file the operator already has and hands it to their
 * own browser. Being wrong here costs a bad render, not a bad file on disk.
 */

test("a page and a PDF both render in the sandboxed frame", () => {
  expect(kindFor("/srv/project/design.html")).toEqual({ contentType: "text/html", render: "iframe" });
  expect(kindFor("/srv/project/report.pdf")).toEqual({ contentType: "application/pdf", render: "iframe" });
});

test("images render inline", () => {
  expect(kindFor("/srv/project/shot.PNG").render).toBe("image");
  expect(kindFor("/srv/project/a.svg")).toEqual({ contentType: "image/svg+xml", render: "image" });
});

test("text renders as text", () => {
  for (const p of ["a.md", "a.txt", "a.json", "a.csv", "a.log"]) {
    expect(kindFor(`/srv/project/${p}`).render, p).toBe("text");
  }
});

test("anything unknown is offered as a download, not guessed at", () => {
  // Guessing a type for an unknown extension is how a binary renders as
  // mojibake and the operator concludes the file is corrupt.
  expect(kindFor("/srv/project/archive.tar.gz"))
    .toEqual({ contentType: "application/octet-stream", render: "download" });
  expect(kindFor("/srv/project/noextension").render).toBe("download");
});

test("the extension is matched case-insensitively, and only at the end", () => {
  expect(kindFor("/srv/project/A.HTML").render).toBe("iframe");
  // `.html` in a DIRECTORY name must not decide the file's type.
  expect(kindFor("/srv/.html/data").render).toBe("download");
});

test("a dotfile has no extension", () => {
  // `.env` is a name, not an `env` extension — and reading it as text would be
  // the one case where guessing wrong puts credentials on a screen.
  expect(kindFor("/srv/project/.env").render).toBe("download");
});

test("the ceiling is a real limit, not a placeholder", () => {
  expect(MAX_FILE_BYTES).toBeGreaterThan(1_000_000);
  expect(MAX_FILE_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
});
