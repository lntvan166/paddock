import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { createFileStore } from "@server/files/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

/**
 * Real files in a temp directory rather than an injected reader.
 *
 * The behaviour under test IS the filesystem's — whether a directory reads as
 * missing, what a stat says about a size — and a fake would encode this file's
 * beliefs about Bun rather than Bun. One of those beliefs was already wrong:
 * `Bun.file(dir).exists()` returns FALSE for a directory, so an `exists()`-first
 * route reported a directory as "no file at …".
 */
const DIR = mkdtempSync(join(tmpdir(), "paddock-files-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const page = join(DIR, "design.html");
writeFileSync(page, "<h1>hello</h1>");
mkdirSync(join(DIR, "adir"), { recursive: true });

function harness(over: { files?: boolean; maxFileBytes?: number } = {}) {
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub(),
    health: () => ({}) as never,
    files: over.files === false ? undefined : createFileStore(),
    maxFileBytes: over.maxFileBytes,
  });
}

const open = (app: ReturnType<typeof harness>, path: string) =>
  app.request("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });

test("a path is exchanged for an id and the file's kind", async () => {
  const res = await open(harness(), page);
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.name, "the basename, so the viewer has a title").toBe("design.html");
  expect(body.render).toBe("iframe");
  expect(body.id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.stringify(body), "the path itself never comes back").not.toContain(DIR);
});

test("the bytes come back under that id, sandboxed", async () => {
  const app = harness();
  const { id } = await (await open(app, page)).json();

  const res = await app.request(`/api/files/${id}`);

  expect(await res.text()).toBe("<h1>hello</h1>");
  expect(res.headers.get("content-type")).toContain("text/html");
  // THE assertion in this file. Without this header an HTML file served from
  // paddock's own origin is same-origin with paddock: it can read localStorage
  // and call paddock's API with the browser's credentials, driving the
  // operator's agents from a page an agent generated. `<iframe sandbox>` does
  // not cover direct navigation to this URL; the header does.
  expect(res.headers.get("content-security-policy")).toBe("sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the download route says attachment, and stays sandboxed", async () => {
  const app = harness();
  const { id } = await (await open(app, page)).json();

  const plain = await app.request(`/api/files/${id}`);
  const dl = await app.request(`/api/files/${id}/download`);

  expect(plain.headers.get("content-disposition")).toBeNull();
  expect(dl.headers.get("content-disposition")).toContain("attachment");
  expect(dl.headers.get("content-disposition")).toContain("design.html");
  // The route a reader would assume is exempt. It is not.
  expect(dl.headers.get("content-security-policy")).toBe("sandbox");
});

test("the viewer can recover a file's name and kind after a reload", async () => {
  // `#/file/:id` survives a reload; the name and render mode were only ever in
  // memory from the moment the file was opened. Without this the viewer comes
  // back with an id and nothing to render it as.
  const app = harness();
  const { id } = await (await open(app, page)).json();

  const res = await app.request(`/api/files/${id}/meta`);

  expect(await res.json()).toEqual({ ok: true, name: "design.html", render: "iframe" });
});

test("each failure gets its own sentence", async () => {
  const app = harness();

  const missing = await open(app, join(DIR, "nope.html"));
  expect(missing.status).toBe(404);
  expect((await missing.json()).detail).toContain("no file");

  // Measured: `Bun.file(dir).exists()` is FALSE, so a directory would otherwise
  // be reported as missing and send the operator looking for a file that is
  // right there.
  const dir = await open(app, join(DIR, "adir"));
  expect(dir.status).toBe(400);
  expect((await dir.json()).detail).toContain("directory");

  const empty = await open(app, "   ");
  expect(empty.status).toBe(400);
  expect((await empty.json()).detail).toContain("path is required");
});

test("a file past the ceiling is refused, with its size named", async () => {
  const big = join(DIR, "big.bin");
  writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));

  const res = await open(harness({ maxFileBytes: 1024 * 1024 }), big);

  expect(res.status).toBe(413);
  expect((await res.json()).detail).toMatch(/MB/);
});

test("an unknown id is a 404 on every one of the three", async () => {
  const app = harness();
  const bogus = "0".repeat(32);
  for (const path of [`/api/files/${bogus}`, `/api/files/${bogus}/download`, `/api/files/${bogus}/meta`]) {
    expect((await app.request(path)).status, path).toBe(404);
  }
});

test("with no store configured there is no route at all", async () => {
  // `--demo` omits it: a demo must never serve a real file off the operator's
  // disk, and README screenshots are taken in that mode.
  const app = harness({ files: false });

  const res = await open(app, page);

  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("not configured");
  expect((await app.request(`/api/files/${"0".repeat(32)}`)).status).toBe(404);
});

test("the forms the transcript linkifies are the forms this opens", async () => {
  // Found by using the feature: a `~/…` path answered "no file at ~/…", because
  // expanding a tilde is a shell's job. `web/paths.ts` linkifies all three of
  // these, so all three have to open.
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    files: createFileStore(), homeDir: DIR,
  });

  const tilde = await (await open(app, "~/design.html")).json();
  expect(tilde.name).toBe("design.html");

  const url = await (await open(app, `file://${page}`)).json();
  expect(url.name).toBe("design.html");

  // And the one that cannot work says why, rather than reporting it missing.
  const relative = await open(app, "design.html");
  expect(relative.status).toBe(400);
  expect((await relative.json()).detail).toContain("not an absolute path");
});
