import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { fileIdFromHash } from "@shared/route";

/**
 * The second instance of one bug. `backend.ts` already records the first:
 * `/api/spaces` had no route, fell through to the agent regex, and answered
 * 404 — so the Spaces screen rendered an error on the hosted demo. `/api/files`
 * had no route either, and the file viewer renders an error there right now.
 *
 * Source-read rather than executed, for the reason demo-backend-spaces.test.ts
 * gives: importing backend.ts installs itself over the global `fetch` and takes
 * the process's networking with it.
 */
const src = readFileSync("src/web/demo/backend.ts", "utf8");

const DEMO_FILE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("the demo file id is one the router will actually accept", () => {
  // FILE_HASH_RE is /^#\/file\/([0-9a-f]{32})$/. An id that misses that shape
  // routes nowhere, and the screen never mounts to show the error.
  expect(fileIdFromHash(`#/file/${DEMO_FILE_ID}`)).toBe(DEMO_FILE_ID);
});

test("the demo answers /api/files/:id/meta", () => {
  expect(src, "the file viewer has no metadata and will error").toContain("/meta");
  expect(src).toContain("/api/files/");
});

test("the metadata names the file and its render mode", () => {
  const at = src.indexOf("/api/files/");
  const branch = src.slice(at, at + 900);
  expect(branch).toContain("render");
  expect(branch).toContain("name");
  // "iframe" is what makes FileViewer mount an <iframe src>, which is the whole
  // point of the step this serves.
  expect(branch).toContain('"iframe"');
});

test("the bytes exist as a real static file, because an iframe src is not a fetch", () => {
  // The demo backend replaces `fetch`. `<iframe src={fileUrl(id)}>` is a
  // browser navigation and never passes through it, so mocking the route would
  // leave a blank frame with a correct-looking header above it.
  //
  // A DIRECTORY with an index.html, not a bare file: fileUrl(id) is
  // `/api/files/<id>` and fileDownloadUrl(id) is `/api/files/<id>/download`, so
  // <id> has to be both a document and a folder. A directory index is the one
  // shape that serves both, on Vercel and on any local static server, with no
  // rewrite rules to keep in sync.
  expect(existsSync(`site/public/api/files/${DEMO_FILE_ID}/index.html`),
    "the file viewer would show an empty frame").toBe(true);
  expect(existsSync(`site/public/api/files/${DEMO_FILE_ID}/download`),
    "the viewer's Download link is a dead control").toBe(true);
});

test("the served page contains nothing from a real session", () => {
  // CLAUDE.md calls fixture content the rule most likely to be broken by
  // accident. This file is HTML and reads like a report, which is exactly the
  // sort of thing someone pastes a real one into.
  const html = readFileSync(`site/public/api/files/${DEMO_FILE_ID}/index.html`, "utf8");
  expect(html).toContain("api-refactor");
  expect(html).not.toMatch(/\/home\/|\/Users\/|@[\w.-]+\.\w+/);
});

test("a write to a file route is refused, not quietly resolved", () => {
  expect(src).toContain("const refuse = ()");
});
