import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  // prevent writes — CI containers frequently run as root. Pointing selfPath
  // at a directory that does not exist fails for every user, root included,
  // and exercises the same "could not replace the binary" branch.
  const code = await runUpdate({
    selfPath: join(h.dir, "does-not-exist", "paddock"),
    platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
});

test("refuses to update a dev build, before resolving or writing any path", async () => {
  // Bun.argv[0] and process.execPath both point at the operator's bun
  // installation in a source checkout (measured: both are ~/.bun/bin/bun).
  // A 0.0.0-dev build has no business overwriting anything with that path —
  // if this check ran after resolving the release, a dev checkout running
  // `paddock update` would download a release and clobber bun itself.
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
