import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, isNewer, runUpdate } from "@server/update";

test("the asset table matches install.sh exactly, so the two cannot disagree", () => {
  expect(assetName("linux", "x64")).toBe("paddock-linux-x86_64");
  expect(assetName("linux", "arm64")).toBe("paddock-linux-aarch64");
  expect(assetName("darwin", "arm64")).toBe("paddock-macos-aarch64");
  expect(assetName("darwin", "x64")).toBe("paddock-macos-x86_64");
  expect(assetName("win32", "x64")).toBeNull();
});

test("version comparison is numeric, not lexicographic", () => {
  expect(isNewer("0.10.0", "0.9.0")).toBe(true); // string compare says false
  expect(isNewer("0.3.0", "0.3.0")).toBe(false);
  expect(isNewer("0.2.0", "0.3.0")).toBe(false);
  expect(isNewer("1.0.0", "0.0.0-dev")).toBe(true);
});

test("a prerelease ranks below the release with the same core version", () => {
  // If an RC is ever tagged ahead of its final release, this must not offer
  // a downgrade to the RC once the release itself is out.
  expect(isNewer("1.1.0-rc.1", "1.1.0")).toBe(false);
  expect(isNewer("1.1.0", "1.1.0-rc.1")).toBe(true);
});

test("build metadata does not affect ordering, and does not eat the patch digit", () => {
  // The old numeric split treated "3+build" as one token and coerced it with
  // Number(), which is NaN -> 0 -- silently downgrading 1.2.3+build to 1.2.0.
  expect(isNewer("1.2.3+build", "1.2.0")).toBe(true);
  expect(isNewer("1.2.3+build", "1.2.3")).toBe(false);
});

async function harness(body: string, sum: string) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  await chmod(self, 0o755);
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${sum}  paddock-linux-x86_64\n`);
    }
    return new Response(body);
  }) as unknown as typeof fetch;
  return { dir, self, fetchImpl };
}

const sha = async (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("a good update replaces the binary", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("NEW BINARY");
});

test("a good update leaves the replaced binary executable", async () => {
  // writeFile() creates the temp file at the umask's default (typically
  // 0644). The chmod(tmp, 0o755) step is the only thing that makes the
  // replacement executable -- delete it and every operator's `paddock`
  // silently stops running after an update.
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).toBe(0);
  const mode = (await stat(h.self)).mode;
  expect(mode & 0o111).toBeTruthy();
});

test("a CHECKSUM MISMATCH leaves the working binary untouched", async () => {
  // The failure this prevents is replacing a working install with a broken one.
  const h = await harness("TAMPERED", await sha("SOMETHING ELSE"));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("--check reports without changing anything", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {}, checkOnly: true,
  });
  expect(code).toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("an unwritable binary refuses rather than half-updating", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  // A mode-bit test would pass vacuously under root, where mode bits do not
  // prevent writes -- CI containers frequently run as root. Instead, point
  // selfPath's PARENT at h.self itself, an existing regular file: writeFile
  // of the temp file into that "directory" fails ENOTDIR for every user,
  // root included, and (unlike targeting an unrelated missing directory)
  // h.self is the actual dirname the code touches, so asserting it survives
  // unchanged is a real assertion, not a vacuous one.
  const code = await runUpdate({
    selfPath: join(h.self, "paddock"),
    platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("a rename failure does not leave a temp file behind", async () => {
  // Replace selfPath with an existing directory: writeFile of the temp file
  // beside it succeeds, chmod succeeds, but rename(tmp, selfPath) fails
  // because a file cannot be renamed onto an existing directory. That is
  // exactly the "writeFile succeeded, then a later step failed" case the
  // P4-style tests above don't reach (they fail at writeFile itself) -- and
  // it's the case where a full-size .paddock.new would otherwise be left
  // next to the binary with no mention of it in the error.
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  await rm(h.self);
  await mkdir(h.self);
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  const remaining = await readdir(h.dir);
  expect(remaining).not.toContain(".paddock.new");
});

test("refuses to update a dev build, before resolving or writing any path", async () => {
  // process.execPath (and Bun.argv[0] in an interpreted run) point at the
  // operator's bun installation in a source checkout. A 0.0.0-dev build has
  // no business overwriting anything with that path -- if this check ran
  // after resolving the release, a dev checkout running `paddock update`
  // would download a release and clobber bun itself.
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return new Response("unused");
  }) as unknown as typeof fetch;
  const code = await runUpdate({
    selfPath: "/nonexistent/bun",
    platform: "linux", arch: "x64",
    current: "0.0.0-dev", fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(fetched).toBe(false);
});

test("a release-API network failure is reported, not thrown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as unknown as typeof fetch;
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(self, "utf8")).toBe("OLD BINARY");
});

test("a malformed release-API response is reported, not thrown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async () => new Response("not json")) as unknown as typeof fetch;
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(self, "utf8")).toBe("OLD BINARY");
});

test("a truncated download is reported, not thrown", async () => {
  const h = await harness("unused", "unused");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response("deadbeef  paddock-linux-x86_64\n");
    }
    // A body that ends mid-stream (a declared content-length the connection
    // never delivers) throws out of arrayBuffer() rather than resolving
    // with a short buffer.
    const badStream = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream ended early"));
      },
    });
    return new Response(badStream);
  }) as unknown as typeof fetch;
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});
