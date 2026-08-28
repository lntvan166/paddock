# File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator open a file from the host on their phone — an
agent-generated HTML page, a PDF, an image, a text file — by tapping its path in
the terminal.

**Architecture:** `POST /api/files` exchanges a path for an opaque id;
`GET /api/files/:id` serves the bytes with `Content-Security-Policy: sandbox`,
which forces a unique origin even on direct navigation. A viewer screen at
`#/file/:id` renders by type. Path-shaped tokens in the transcript become
tappable.

**Tech Stack:** Bun, Hono, React 19, `bun:test`, happy-dom.

**Spec:** `docs/design/2026-08-28-file-viewer-design.md`

## Global Constraints

- **This repository is public.** No real hostnames, home paths, usernames or
  employer names in code, comments, tests, fixtures or commit messages. Test
  fixtures use `/srv/project`, `dev-box`, invented agent names. Run
  `make check-clean` before EVERY commit; if it fails, fix the content.
- **Never put payloads in a GET query string or path.** They land in edge access
  logs. This is why the path is exchanged for an id.
- **Never swallow errors.** No `2>/dev/null`, no empty catch that hides a cause.
  Every refusal gets its own sentence.
- **`--demo` omits the route entirely** — README screenshots come from that mode.
- **Colour tokens on bare `:root`**, redefined under `prefers-color-scheme` and
  `[data-theme]`. Never define a colour only inside a media query.
- **No device detection**, no `isMobile`, no user-agent parsing.
- **Touch targets ≥ 2.75rem.** Respect `prefers-reduced-motion` and
  `env(safe-area-inset-bottom)`.
- `make check` (tsc), `make check-clean`, `make test` must all pass before a
  commit. `make test` builds the UI first — never bare `bun test` for the gate.
- Radii come from `--r-sm` / `--r-md` / `--r-full`; a literal fails
  `tests/radius.test.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/files/kinds.ts` (new) | Extension → content-type and render mode; the size ceiling. Pure. |
| `src/server/files/store.ts` (new) | The path↔id map: issue, resolve, cap, evict. Pure apart from randomness. |
| `src/server/routes.ts` (modify) | The three routes and their headers. |
| `src/server/index.ts` (modify) | Wire the store, omitted in `--demo`. |
| `src/shared/route.ts` (modify) | `fileHash` / `fileIdFromHash`, beside `paneHash`. |
| `src/web/api.ts` (modify) | `openFile(path)`; the two GET URL builders. |
| `src/web/paths.ts` (new) | Split ANSI spans on path-shaped tokens. Pure. |
| `src/web/components/FileViewer.tsx` (new) | The viewer screen. |
| `src/web/components/PaneTerminal.tsx` (modify) | Render path spans as buttons. |
| `src/web/components/App.tsx` (modify) | Route `#/file/:id`. |
| `src/web/styles.css` (modify) | Viewer and path-link styles. |

---

### Task 1: File kinds and the size ceiling

**Files:**
- Create: `src/server/files/kinds.ts`
- Test: `tests/file-kinds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type RenderMode = "iframe" | "image" | "text" | "download"`;
  `interface FileKind { contentType: string; render: RenderMode }`;
  `function kindFor(path: string): FileKind`; `const MAX_FILE_BYTES: number`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { kindFor, MAX_FILE_BYTES } from "@server/files/kinds";

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
  // Guessing a type for an unknown extension is how a binary renders as mojibake.
  expect(kindFor("/srv/project/archive.tar.gz"))
    .toEqual({ contentType: "application/octet-stream", render: "download" });
  expect(kindFor("/srv/project/noextension").render).toBe("download");
});

test("the extension is matched case-insensitively, and only at the end", () => {
  expect(kindFor("/srv/project/A.HTML").render).toBe("iframe");
  // `.html` in a directory name must not decide the file's type.
  expect(kindFor("/srv/.html/data").render).toBe("download");
});

test("the ceiling is a real limit, not a placeholder", () => {
  expect(MAX_FILE_BYTES).toBeGreaterThan(1_000_000);
  expect(MAX_FILE_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/file-kinds.test.ts`
Expected: FAIL — `Cannot find module '@server/files/kinds'`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * What a file is, for the purpose of showing it on a phone.
 *
 * Derived from the EXTENSION, deliberately unlike `uploads/store.ts`, which
 * sniffs the bytes. That route accepts what a phone sends and hands it to an
 * agent; this one reads a file the operator already has and hands it to their
 * own browser, where being wrong costs a bad render rather than a bad file on
 * disk. `X-Content-Type-Options: nosniff` at the route then stops the browser
 * second-guessing the answer.
 *
 * An unknown extension is a DOWNLOAD, never a guess: rendering an unknown
 * binary as text is how a page fills with mojibake and the operator concludes
 * the file is corrupt.
 */
export type RenderMode = "iframe" | "image" | "text" | "download";

export interface FileKind {
  contentType: string;
  render: RenderMode;
}

/**
 * How much may be sent to a phone over a tunnel. Large files are refused with
 * their size named, rather than streamed to a device on mobile data.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const KINDS: Record<string, FileKind> = {
  html: { contentType: "text/html", render: "iframe" },
  htm: { contentType: "text/html", render: "iframe" },
  pdf: { contentType: "application/pdf", render: "iframe" },
  png: { contentType: "image/png", render: "image" },
  jpg: { contentType: "image/jpeg", render: "image" },
  jpeg: { contentType: "image/jpeg", render: "image" },
  gif: { contentType: "image/gif", render: "image" },
  webp: { contentType: "image/webp", render: "image" },
  svg: { contentType: "image/svg+xml", render: "image" },
  md: { contentType: "text/plain; charset=utf-8", render: "text" },
  txt: { contentType: "text/plain; charset=utf-8", render: "text" },
  json: { contentType: "text/plain; charset=utf-8", render: "text" },
  csv: { contentType: "text/plain; charset=utf-8", render: "text" },
  log: { contentType: "text/plain; charset=utf-8", render: "text" },
};

const UNKNOWN: FileKind = { contentType: "application/octet-stream", render: "download" };

export function kindFor(path: string): FileKind {
  // The last segment only: a directory called `.html` must not decide the type
  // of a file inside it.
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return UNKNOWN;
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? UNKNOWN;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/file-kinds.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/files/kinds.ts tests/file-kinds.test.ts
git commit -m "feat: what a file is, for the purpose of showing it on a phone"
```

---

### Task 2: The path↔id store

**Files:**
- Create: `src/server/files/store.ts`
- Test: `tests/file-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface FileStore { issue(path: string): string; resolve(id: string): string | null }`;
  `function createFileStore(opts?: { cap?: number; random?: () => string }): FileStore`;
  `const FILE_ID_RE: RegExp`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createFileStore, FILE_ID_RE } from "@server/files/store";

test("a path is exchanged for an id, and comes back", () => {
  const store = createFileStore();
  const id = store.issue("/srv/project/design.html");
  expect(store.resolve(id)).toBe("/srv/project/design.html");
});

test("the id reveals nothing about the path", () => {
  // The whole reason this exists: an id is what may appear in an edge access
  // log, where a path may not.
  const store = createFileStore();
  const id = store.issue("/srv/secret/place/design.html");
  expect(id).toMatch(FILE_ID_RE);
  expect(id).not.toContain("secret");
  expect(id).not.toContain("design");
});

test("an unknown id resolves to nothing rather than throwing", () => {
  expect(createFileStore().resolve("nope")).toBeNull();
});

test("the same path issued twice returns the same id", () => {
  // Tapping one path repeatedly must not grow the map without bound.
  const store = createFileStore();
  expect(store.issue("/srv/project/a.html")).toBe(store.issue("/srv/project/a.html"));
});

test("the map is capped, and evicts the oldest", () => {
  const store = createFileStore({ cap: 2 });
  const first = store.issue("/srv/project/1.html");
  const second = store.issue("/srv/project/2.html");
  const third = store.issue("/srv/project/3.html");

  expect(store.resolve(first), "the oldest is gone").toBeNull();
  expect(store.resolve(second)).toBe("/srv/project/2.html");
  expect(store.resolve(third)).toBe("/srv/project/3.html");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/file-store.test.ts`
Expected: FAIL — `Cannot find module '@server/files/store'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { randomBytes } from "node:crypto";

/**
 * The path↔id map behind the file routes.
 *
 * It exists for one reason: `CLAUDE.md` forbids payloads in GET URLs, because
 * they land in edge access logs — and a file path is exactly such a payload. An
 * `<iframe src>` and a download link both need a plain GET, so the path is
 * POSTed once and a meaningless id is what travels in the URL after that.
 *
 * It is NOT a capability or a secret. Anything that can reach paddock can POST
 * a path and get an id for it, which is the design's stated scope — see
 * `docs/design/2026-08-28-file-viewer-design.md`. The id is shorter than the
 * path and says less in a log; that is all it is for.
 *
 * In memory, capped, and dies with the process. Nothing is persisted: a
 * restart invalidating every open tab's ids is correct, because the id means
 * nothing on its own.
 */
export interface FileStore {
  issue(path: string): string;
  resolve(id: string): string | null;
}

/** 32 lowercase hex characters, which is what `issue` emits. */
export const FILE_ID_RE = /^[0-9a-f]{32}$/;

const DEFAULT_CAP = 200;

export function createFileStore(
  opts: { cap?: number; random?: () => string } = {},
): FileStore {
  const cap = opts.cap ?? DEFAULT_CAP;
  const random = opts.random ?? (() => randomBytes(16).toString("hex"));
  // Insertion-ordered, which is what makes eviction "oldest first" free.
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();

  return {
    issue(path) {
      // Same path, same id: tapping one link repeatedly must not grow the map.
      const existing = byPath.get(path);
      if (existing !== undefined) return existing;

      const id = random();
      byId.set(id, path);
      byPath.set(path, id);

      while (byId.size > cap) {
        const oldest = byId.keys().next().value as string;
        const oldestPath = byId.get(oldest);
        byId.delete(oldest);
        if (oldestPath !== undefined) byPath.delete(oldestPath);
      }
      return id;
    },
    resolve(id) {
      return byId.get(id) ?? null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/file-store.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/server/files/store.ts tests/file-store.test.ts
git commit -m "feat: exchange a file path for an id that may appear in a log"
```

---

### Task 3: The three routes, and the header that matters

**Files:**
- Modify: `src/server/routes.ts` — add `files?: FileStore` to `AppDeps`, add three routes after the image route
- Modify: `src/server/index.ts` — wire the store, omitted in `--demo`
- Test: `tests/file-routes.test.ts`

**Interfaces:**
- Consumes: `createFileStore`, `FileStore` (Task 2); `kindFor`, `MAX_FILE_BYTES` (Task 1).
- Produces: `POST /api/files` → `{ ok: true, id, name, render }`;
  `GET /api/files/:id` → bytes; `GET /api/files/:id/download` → bytes as attachment.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@server/routes";
import { createFileStore } from "@server/files/store";
import { AgentStore } from "@server/state/store";
import { Hub } from "@server/ws/hub";

const DIR = mkdtempSync(join(tmpdir(), "paddock-files-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const page = join(DIR, "design.html");
writeFileSync(page, "<h1>hello</h1>");

function harness(withFiles = true) {
  return createApp({
    store: new AgentStore("dev-box"),
    hub: new Hub(),
    health: () => ({}) as never,
    files: withFiles ? createFileStore() : undefined,
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
});

test("the bytes come back under that id, sandboxed", async () => {
  const app = harness();
  const { id } = await (await open(app, page)).json();

  const res = await app.request(`/api/files/${id}`);

  expect(await res.text()).toBe("<h1>hello</h1>");
  expect(res.headers.get("content-type")).toContain("text/html");
  // THE assertion in this file. Without this header an HTML file served from
  // paddock's own origin can read localStorage and call paddock's API with the
  // browser's credentials — driving the operator's agents from a page an agent
  // generated. The iframe attribute does not cover direct navigation; this does.
  expect(res.headers.get("content-security-policy")).toBe("sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("the download route says attachment, and the plain one does not", async () => {
  const app = harness();
  const { id } = await (await open(app, page)).json();

  const plain = await app.request(`/api/files/${id}`);
  const dl = await app.request(`/api/files/${id}/download`);

  expect(plain.headers.get("content-disposition")).toBeNull();
  expect(dl.headers.get("content-disposition")).toContain("attachment");
  expect(dl.headers.get("content-disposition")).toContain("design.html");
  expect(dl.headers.get("content-security-policy"), "still sandboxed").toBe("sandbox");
});

test("each failure gets its own sentence", async () => {
  const app = harness();

  const missing = await open(app, join(DIR, "nope.html"));
  expect(missing.status).toBe(404);
  expect((await missing.json()).detail).toContain("no file");

  mkdirSync(join(DIR, "adir"), { recursive: true });
  const dir = await open(app, join(DIR, "adir"));
  expect(dir.status).toBe(400);
  expect((await dir.json()).detail).toContain("directory");
});

test("a file past the ceiling is refused, with its size named", async () => {
  const big = join(DIR, "big.bin");
  writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
  const app = createApp({
    store: new AgentStore("dev-box"), hub: new Hub(), health: () => ({}) as never,
    files: createFileStore(), maxFileBytes: 1024 * 1024,
  });

  const res = await open(app, big);

  expect(res.status).toBe(413);
  expect((await res.json()).detail).toMatch(/MB/);
});

test("an unknown id is a 404", async () => {
  expect((await harness().request("/api/files/deadbeef")).status).toBe(404);
});

test("with no store configured there is no route at all", async () => {
  // `--demo` omits it: a demo must never serve a real file, and README
  // screenshots are taken in that mode.
  const res = await open(harness(false), page);
  expect(res.status).toBe(404);
  expect((await res.json()).detail).toContain("not configured");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/file-routes.test.ts`
Expected: FAIL — `files` is not a known property of `AppDeps`, and the routes 404.

- [ ] **Step 3: Write minimal implementation**

In `src/server/routes.ts`, add to the imports:

```ts
import { kindFor, MAX_FILE_BYTES } from "@server/files/kinds";
import type { FileStore } from "@server/files/store";
```

Add to `AppDeps`, beside `saveImage`:

```ts
  /**
   * The path↔id map behind the file routes. Omitted in `--demo`, which makes
   * the routes 404: a demo must never serve a real file off the operator's
   * disk, and README screenshots are taken in that mode.
   */
  files?: FileStore;
  /** Overridable so a test need not write 25 MB to disk. */
  maxFileBytes?: number;
```

Add the routes after the image route:

```ts
  /**
   * Exchange a path for an id.
   *
   * A POST because `CLAUDE.md` forbids payloads in GET URLs — they land in edge
   * access logs, and a file path is exactly that. The id that comes back is
   * meaningless in a log, and an `<iframe src>` and a download link both need a
   * plain GET.
   *
   * SCOPE IS UNRESTRICTED, deliberately: any path the process can read. See
   * `docs/design/2026-08-28-file-viewer-design.md` for why a denylist here
   * would be theatre — `POST /api/panes/:id/text` can already `cat` any file
   * into a pane, so this grants convenience rather than capability.
   */
  app.post("/api/files", async (c) => {
    if (!deps.files) return c.json({ ok: false, detail: "file viewing is not configured" }, 404);

    const body = await jsonBody(c);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (path === "") return c.json({ ok: false, detail: "a path is required" }, 400);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return c.json({ ok: false, detail: `no file at ${path}` }, 404);
    }
    // `Bun.file(dir).size` is 0 and `exists()` is true for a directory, so the
    // stat is what tells them apart — and "could not open" for both would send
    // the operator to look for a missing file that is right there.
    const { statSync } = await import("node:fs");
    if (statSync(path).isDirectory()) {
      return c.json({ ok: false, detail: `${path} is a directory, not a file` }, 400);
    }

    const ceiling = deps.maxFileBytes ?? MAX_FILE_BYTES;
    if (file.size > ceiling) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      const capMb = Math.floor(ceiling / (1024 * 1024));
      return c.json({ ok: false, detail: `that file is ${mb} MB — the limit is ${capMb} MB` }, 413);
    }

    const name = path.slice(path.lastIndexOf("/") + 1);
    return c.json({ ok: true, id: deps.files.issue(path), name, render: kindFor(path).render });
  });

  /**
   * Serve the bytes.
   *
   * `Content-Security-Policy: sandbox` is the load-bearing header and is NOT
   * the same as `<iframe sandbox>`: the attribute protects the embedding page,
   * the header protects against this URL being opened directly — which anyone
   * can do, since the id sits in the viewer's address bar. Without it an HTML
   * file served here is same-origin with paddock and can call paddock's own API
   * with the browser's credentials.
   */
  const serveFile = async (c: Context, id: string, asAttachment: boolean) => {
    if (!deps.files) return c.json({ ok: false, detail: "file viewing is not configured" }, 404);
    const path = deps.files.resolve(id);
    if (path === null) return c.json({ ok: false, detail: "unknown file" }, 404);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return c.json({ ok: false, detail: "that file is no longer there" }, 404);
    }

    const name = path.slice(path.lastIndexOf("/") + 1);
    const headers: Record<string, string> = {
      "content-type": kindFor(path).contentType,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    };
    if (asAttachment) {
      // The name is quoted and stripped of quotes rather than escaped: a
      // filename is not a place to be clever with header parsing.
      headers["content-disposition"] = `attachment; filename="${name.replace(/["\\]/g, "")}"`;
    }
    return new Response(file, { headers });
  };

  app.get("/api/files/:id", (c) => serveFile(c, c.req.param("id"), false));
  app.get("/api/files/:id/download", (c) => serveFile(c, c.req.param("id"), true));
```

`Context` is already imported in `routes.ts`; if it is not, add
`import type { Context } from "hono";`.

In `src/server/index.ts`, beside `saveImage` in the `appDeps` object:

```ts
  // Omitted in DEMO for the reason the two above are: a demo must not read the
  // operator's own disk, and README screenshots are taken in that mode.
  files: DEMO ? undefined : createFileStore(),
```

with `import { createFileStore } from "@server/files/store";` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/file-routes.test.ts` — Expected: PASS (7 tests).
Then `make check && make test`.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean && make test
git add src/server/files src/server/routes.ts src/server/index.ts tests/file-routes.test.ts
git commit -m "feat: serve a file to the phone, sandboxed at the response"
```

---

### Task 4: The client API and the `#/file/:id` route helpers

**Files:**
- Modify: `src/shared/route.ts` — `fileHash`, `fileIdFromHash`
- Modify: `src/web/api.ts` — `openFile`, `fileUrl`, `fileDownloadUrl`
- Test: `tests/file-route-hash.test.ts`

**Interfaces:**
- Consumes: the routes from Task 3.
- Produces: `fileHash(id: string): string`; `fileIdFromHash(hash: string): string | null`;
  `openFile(path: string, f?: Fetch): Promise<{ id: string; name: string; render: RenderMode }>`;
  `fileUrl(id: string): string`; `fileDownloadUrl(id: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { fileHash, fileIdFromHash } from "@shared/route";
import { fileUrl, fileDownloadUrl } from "@web/api";

test("a file id round-trips through the hash", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(fileHash(id)).toBe(`#/file/${id}`);
  expect(fileIdFromHash(fileHash(id))).toBe(id);
});

test("another screen's hash is not a file", () => {
  // The pane hash must keep parsing as a pane — both prefixes are permanent.
  expect(fileIdFromHash("#/pane/w1%3Ap1")).toBeNull();
  expect(fileIdFromHash("")).toBeNull();
  expect(fileIdFromHash("#/file/")).toBeNull();
});

test("the URLs are plain GETs with nothing but the id in them", () => {
  const id = "0123456789abcdef0123456789abcdef";
  expect(fileUrl(id)).toBe(`/api/files/${id}`);
  expect(fileDownloadUrl(id)).toBe(`/api/files/${id}/download`);
  // A path in a URL is what the id exists to avoid.
  expect(fileUrl(id)).not.toContain("/");  // placeholder, replaced in Step 3
});
```

> Note for the implementer: the last assertion is intentionally wrong and is
> corrected in Step 3 — a URL obviously contains slashes. It is written this way
> so Step 2 fails for a reason you can see, and so you replace it with the real
> invariant rather than copying a green assertion you never read.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/file-route-hash.test.ts`
Expected: FAIL — `fileHash` is not exported, and the last assertion is false.

- [ ] **Step 3: Write minimal implementation**

Replace the deliberately wrong assertion with the real one:

```ts
  expect(fileUrl(id).split("/").length, "id only — no path segments").toBe(4);
```

In `src/shared/route.ts`, beside `paneHash`:

```ts
/**
 * The file viewer's address.
 *
 * Its own route rather than a sheet over the terminal, for the reason the pane
 * hash gives above: a phone backgrounds tabs, and a reload must not lose what
 * the operator was looking at. The id is already URL-safe hex, so nothing is
 * encoded.
 */
const FILE_HASH_RE = /^#\/file\/([0-9a-f]{32})$/;

export function fileHash(id: string): string {
  return `#/file/${id}`;
}

export function fileIdFromHash(hash: string): string | null {
  return FILE_HASH_RE.exec(hash)?.[1] ?? null;
}
```

In `src/web/api.ts`:

```ts
/**
 * Exchange a path for an id, so the viewer has a plain GET URL to point an
 * iframe and a download link at. The path travels in a POST body because a
 * path in a URL lands in edge access logs.
 */
export async function openFile(
  path: string,
  f: Fetch = fetch,
): Promise<{ id: string; name: string; render: "iframe" | "image" | "text" | "download" }> {
  return readJson("/api/files", { path }, f);
}

/** Where the bytes are. Nothing but the id travels here. */
export const fileUrl = (id: string) => `/api/files/${id}`;
export const fileDownloadUrl = (id: string) => `/api/files/${id}/download`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/file-route-hash.test.ts` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/shared/route.ts src/web/api.ts tests/file-route-hash.test.ts
git commit -m "feat: the file viewer's address, and the client call behind it"
```

---

### Task 5: Split ANSI spans on path-shaped tokens

**Files:**
- Create: `src/web/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Consumes: `AnsiSpan` from `@web/ansi`.
- Produces: `interface PathSpan extends AnsiSpan { path?: string }`;
  `function splitPaths(spans: readonly AnsiSpan[]): PathSpan[]`.

- [ ] **Step 1: Write the failing test**

```ts
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

test("trailing punctuation is not part of the path", () => {
  // "Wrote /srv/a.html." — the full stop is prose, not a filename.
  expect(pathsIn("wrote /srv/a.html.")).toEqual(["/srv/a.html"]);
  expect(pathsIn("(see /srv/a.html)")).toEqual(["/srv/a.html"]);
  expect(pathsIn("/srv/a.html, then")).toEqual(["/srv/a.html"]);
});

test("prose containing a slash is not a path", () => {
  // The same regression the slash-command trigger guards: a slash inside a
  // word is not an address.
  expect(pathsIn("read src/web/api.ts")).toEqual([]);
  expect(pathsIn("and/or")).toEqual([]);
  expect(pathsIn("http://example.com/x")).toEqual([]);
});

test("styling survives the split", () => {
  const out = splitPaths([{ text: "at /srv/a.html", bold: true, fg: "#fff" }]);
  expect(out.every((s) => s.bold === true && s.fg === "#fff")).toBe(true);
});

test("a span with no path is returned untouched", () => {
  const input = [{ text: "nothing here", dim: true }];
  expect(splitPaths(input)).toEqual(input);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/paths.test.ts`
Expected: FAIL — `Cannot find module '@web/paths'`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AnsiSpan } from "@web/ansi";

/**
 * A span the terminal may render as a link.
 *
 * `path` present means the whole span IS the path, so the renderer needs no
 * substring arithmetic — it wraps the span or it does not.
 */
export interface PathSpan extends AnsiSpan {
  path?: string;
}

/**
 * Path-shaped tokens, split out of already-styled spans.
 *
 * ANCHORED like the slash-command trigger, and for the same reason: a slash
 * inside a word is not an address. A path must start at the beginning of the
 * span or after whitespace, so `src/web/api.ts` and `and/or` and
 * `http://example.com/x` all stay prose while `/srv/a.html` and `~/notes/a.md`
 * become links.
 *
 * Trailing punctuation is trimmed because a sentence ends in a full stop and a
 * filename does not — "wrote /srv/a.html." names a file called `a.html`.
 *
 * Whether the file EXISTS is not checked here. Deciding would cost a
 * filesystem round trip per token per poll, and the viewer already says so
 * plainly when a path is not there.
 */
const PATH_RE = /(?<=^|\s)(?:file:\/\/)?(?:~|\/)[^\s]*/g;

/** Punctuation that ends a sentence rather than a filename. */
const TRAILING = /[.,;:!?)\]}>'"]+$/;

export function splitPaths(spans: readonly AnsiSpan[]): PathSpan[] {
  const out: PathSpan[] = [];

  for (const span of spans) {
    let last = 0;
    PATH_RE.lastIndex = 0;
    for (let m = PATH_RE.exec(span.text); m !== null; m = PATH_RE.exec(span.text)) {
      const token = m[0].replace(TRAILING, "");
      // A bare "/" or "~" is punctuation, not an address.
      if (token.length < 3) continue;
      if (m.index > last) out.push({ ...span, text: span.text.slice(last, m.index) });
      out.push({ ...span, text: token, path: token });
      last = m.index + token.length;
    }
    if (last === 0) out.push(span);
    else if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/paths.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
make check && make check-clean
git add src/web/paths.ts tests/paths.test.ts
git commit -m "feat: pick the paths out of a line of terminal output"
```

---

### Task 6: The viewer screen

**Files:**
- Create: `src/web/components/FileViewer.tsx`
- Modify: `src/web/components/App.tsx` — route `#/file/:id`
- Modify: `src/web/styles.css`
- Test: `tests/file-viewer.test.tsx`

**Interfaces:**
- Consumes: `fileUrl`, `fileDownloadUrl` (Task 4); `fileIdFromHash` (Task 4).
- Produces: `<FileViewer id name render onBack />`.

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { FileViewer } from "@web/components/FileViewer";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

const ID = "0123456789abcdef0123456789abcdef";

test("a page renders in a sandboxed frame", async () => {
  const host = await render(<FileViewer id={ID} name="design.html" render="iframe" onBack={() => {}} />);

  const frame = host.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe(`/api/files/${ID}`);
  // Belt to the response header's braces: the attribute protects this page,
  // the header protects direct navigation. `allow-same-origin` is absent on
  // purpose — with it the frame would be same-origin with paddock again.
  expect(frame?.getAttribute("sandbox")).toBe("");
});

test("an image renders inline, named for the file", async () => {
  const host = await render(<FileViewer id={ID} name="shot.png" render="image" onBack={() => {}} />);

  const img = host.querySelector("img.file-image");
  expect(img?.getAttribute("src")).toBe(`/api/files/${ID}`);
  expect(img?.getAttribute("alt")).toBe("shot.png");
});

test("an unrenderable file offers only the download", async () => {
  const host = await render(<FileViewer id={ID} name="a.tar.gz" render="download" onBack={() => {}} />);

  expect(host.querySelector("iframe")).toBeNull();
  expect(host.textContent).toContain("cannot be shown");
  expect(host.querySelector("a.file-download")?.getAttribute("href"))
    .toBe(`/api/files/${ID}/download`);
});

test("download is offered whatever the type", async () => {
  // The operator's own framing: "open or download it if I want."
  for (const mode of ["iframe", "image", "text", "download"] as const) {
    const host = await render(<FileViewer id={ID} name="a" render={mode} onBack={() => {}} />);
    expect(host.querySelector("a.file-download"), mode).not.toBeNull();
    await unmount();
  }
});

test("the file's name is the screen's title", async () => {
  const host = await render(<FileViewer id={ID} name="design.html" render="iframe" onBack={() => {}} />);
  expect(host.querySelector(".file-title")?.textContent).toBe("design.html");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/file-viewer.test.tsx`
Expected: FAIL — `Cannot find module '@web/components/FileViewer'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { fileDownloadUrl, fileUrl } from "@web/api";
import { BackIcon } from "@web/components/ui/icons";

/**
 * One file, shown on a phone.
 *
 * The iframe carries `sandbox` with NO `allow-same-origin`, and the response
 * carries `Content-Security-Policy: sandbox`. Both, deliberately: the attribute
 * protects this page from what it embeds, and the header protects against the
 * URL being opened directly from the address bar. Dropping either leaves an
 * agent-authored page able to call paddock's own API.
 *
 * Download is offered for EVERY type, not only the unrenderable ones — it is
 * the operator's escape hatch when a render is wrong, and it was their own
 * framing of the feature.
 */
export function FileViewer({ id, name, render, onBack }: {
  id: string;
  name: string;
  render: "iframe" | "image" | "text" | "download";
  onBack: () => void;
}) {
  return (
    <section className="screen file-view" aria-label={`${name} viewer`}>
      <header className="term-header">
        <button type="button" className="term-back" onClick={onBack} aria-label="Back">
          <BackIcon className="term-back-glyph" />
        </button>
        <strong className="file-title">{name}</strong>
        <a className="file-download" href={fileDownloadUrl(id)} download={name}>
          Download
        </a>
      </header>

      <div className="file-body">
        {render === "iframe" && (
          <iframe className="file-frame" src={fileUrl(id)} sandbox="" title={name} />
        )}
        {render === "image" && (
          <img className="file-image" src={fileUrl(id)} alt={name} />
        )}
        {render === "text" && (
          <iframe className="file-frame file-text" src={fileUrl(id)} sandbox="" title={name} />
        )}
        {render === "download" && (
          <p className="file-note">
            This kind of file cannot be shown here. Download it to open it in another app.
          </p>
        )}
      </div>
    </section>
  );
}
```

In `App.tsx`, alongside the existing pane routing: read
`fileIdFromHash(hash)`; when it is non-null, render `<FileViewer>` instead of
the dashboard, taking `name` and `render` from the state set when the file was
opened, and `onBack` restoring the previous hash.

In `styles.css`, tokens only — no literal colours or radii:

```css
/* One file, filling the screen below its own header. `.screen` already
   supplies the fixed column and the safe-area inset. */
.file-body { flex: 1; min-height: 0; display: flex; overflow: auto; }
.file-frame { flex: 1; width: 100%; border: 0; background: var(--bg); }
.file-image { max-width: 100%; margin: auto; }
.file-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-download { flex: none; min-height: 2.75rem; display: inline-flex; align-items: center;
                 padding: 0 var(--pad-control); color: var(--accent); }
.file-note { margin: auto; padding: var(--gutter); color: var(--fg-dim); font-size: var(--t-md); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/file-viewer.test.tsx` — Expected: PASS (5 tests).
Then `make check && make test`.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean && make test
git add src/web/components/FileViewer.tsx src/web/components/App.tsx src/web/styles.css tests/file-viewer.test.tsx
git commit -m "feat: a screen that shows one file, and always offers it whole"
```

---

### Task 7: Tapping a path in the transcript

**Files:**
- Modify: `src/web/components/PaneTerminal.tsx` — render `PathSpan`s as buttons
- Modify: `src/web/styles.css`
- Test: `tests/path-links.test.tsx`

**Interfaces:**
- Consumes: `splitPaths` (Task 5); `openFile` (Task 4); `fileHash` (Task 4).
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

```tsx
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => { await unmount(); globalThis.fetch = realFetch; });

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

test("a path in the output is tappable, and opening it asks the server", async () => {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["wrote /srv/project/design.html"]),
    "/commands": () => ({ ok: true, commands: [] }),
    "/api/files": () => ({ ok: true, id: "0".repeat(32), name: "design.html", render: "iframe" }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  const link = host.querySelector(".term-path");
  expect(link?.textContent).toBe("/srv/project/design.html");

  await click(link);
  await settle();

  const asked = calls.find((c) => c.url.includes("/api/files"));
  expect((asked?.body as { path: string }).path).toBe("/srv/project/design.html");
});

test("ordinary output grows no links", async () => {
  const { fn } = stubFetch({
    "/output": () => screenOf(["reading src/web/api.ts now"]),
    "/commands": () => ({ ok: true, commands: [] }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent()} onBack={() => {}} />);
  await settle();

  expect(host.querySelector(".term-path")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/path-links.test.tsx`
Expected: FAIL — no `.term-path` element exists.

- [ ] **Step 3: Write minimal implementation**

In `PaneTerminal.tsx`, where a line's spans are rendered, pass them through
`splitPaths` and render a span carrying `path` as a button:

```tsx
{splitPaths(spans).map((s, i) =>
  s.path === undefined ? (
    <span key={i} style={styleFor(s)}>{s.text}</span>
  ) : (
    <button
      key={i}
      type="button"
      className="term-path"
      style={styleFor(s)}
      // A tap, not a long-press: this project's rules exclude a gesture only
      // someone who already knows would find.
      onClick={() => onOpenPath?.(s.path!)}
    >
      {s.text}
    </button>
  ),
)}
```

`onOpenPath` is a new optional prop threaded from `AgentTerminal`, which calls
`openFile(path)` and then sets `location.hash = fileHash(id)`; a rejection sets
the existing `feedback` state so the server's own sentence is shown.

```css
/* A path in the transcript. Underlined rather than coloured: the pane carries
   the agent's OWN colours, and taking one for links would collide with them. */
.term-path {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 2px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/path-links.test.tsx` — Expected: PASS (2 tests).
Then `make check && make test`.

- [ ] **Step 5: Commit**

```bash
make check && make check-clean && make test
git add src/web/components/PaneTerminal.tsx src/web/components/AgentTerminal.tsx src/web/styles.css tests/path-links.test.tsx
git commit -m "feat: a path in the transcript opens the file it names"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/decisions.md` — decision 28
- Modify: `docs/architecture.md` — two module rows and the routes
- Modify: `README.md` — one line
- Modify: `docs/design/2026-08-28-file-viewer-design.md` — mark built

- [ ] **Step 1: Write decision 28**

Append to `docs/decisions.md`, numbered 28, covering: the scope is
unrestricted; the reason is that `POST /api/panes/:id/text` can already `cat`
any file into a pane, so a denylist would refuse `settings.json` at one route
while the pane beside it printed the same bytes; the one genuine widening is
binary files, which a terminal cannot practically carry; and the axis this does
not settle — a named tunnel puts Access in front of it, a quick tunnel puts a
ten-minute pairing code.

- [ ] **Step 2: Add the module rows**

`server/files/kinds.ts` and `server/files/store.ts` to the table, plus
`web/paths.ts` and `web/components/FileViewer.tsx`, each with the reasoning that
is not obvious from the filename — particularly why the id exists at all.

- [ ] **Step 3: Add the README line**

Under the feature list, one line that says what it does AND what its scope is.
It must not read as "view your project files" when it is "view any file".

- [ ] **Step 4: Verify and commit**

```bash
make check-clean
git add docs README.md
git commit -m "docs: the file viewer, and why its scope is what it is"
```

---

## Self-Review

**Spec coverage.** Two routes and the header → Task 3. Viewer and render matrix
→ Task 6. Download always → Task 6. Distinguishable failures → Task 3 (server
sentences) and Task 6 (the unrenderable note). Size ceiling → Tasks 1 and 3.
Demo omission → Task 3. Linkification → Tasks 5 and 7. `#/file/:id` → Task 4.
Documentation owed → Task 8. **Gap found and closed:** the spec's testing
section asks that every served response carry the sandbox header; Task 3's
second test asserts it on the plain route and its third asserts it on the
download route.

**Placeholders.** None. Task 4 contains one deliberately wrong assertion, which
is labelled as such and corrected in its own Step 3 — it is a teaching device,
not an unfinished thought.

**Type consistency.** `RenderMode` is defined in Task 1 and used verbatim in
Tasks 3, 4 and 6. `FileStore.issue`/`resolve` are defined in Task 2 and used in
Task 3. `fileUrl`/`fileDownloadUrl` are defined in Task 4 and used in Task 6.
`splitPaths` returns `PathSpan[]` in Task 5 and is consumed in Task 7. The POST
response is `{ ok, id, name, render }` in Task 3 and destructured identically in
Tasks 4 and 7.
