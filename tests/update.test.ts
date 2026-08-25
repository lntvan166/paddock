import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, detectManagedBy, isBrewManaged, isNewer, runUpdate } from "@server/update";
import type { Progress } from "@server/progress";

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

/** A Progress that records nothing — the default for tests that assert text. */
const silent = (): Progress => ({ start() {}, advance() {}, done() {} });

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

// SHA256SUMS is fetched FIRST and is a few hundred bytes: a release published
// without a listed checksum must fail before an 83 MB download, not after it.
test("a missing SHA256SUMS fails before the asset is ever requested", async () => {
  const asked: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) return new Response("nope", { status: 403 });
    return new Response("BODY");
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("403");
  expect(said.join("\n")).toContain("SHA256SUMS");
  expect(asked.some((u) => u.endsWith("paddock-linux-x86_64"))).toBe(false);
  expect(await readFile(self, "utf8")).toBe("OLD BINARY");
});

test("a failed asset download names its own HTTP status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response("abc  paddock-linux-x86_64\n");
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("404");
  expect(said.join("\n")).toContain("paddock-linux-x86_64");
});

test("a chunked body hashes to the same digest as one buffered read", async () => {
  // The whole risk of streaming: if the hasher were fed anything other than
  // the exact bytes, in order, the checksum gate would start rejecting good
  // releases — or worse, accepting bad ones.
  const body = "PADDOCK".repeat(5000);
  const sum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
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
    // A body delivered in many small chunks, as a real download is.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 997) {
          controller.enqueue(bytes.slice(i, i + 997));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-length": String(body.length) } });
  }) as unknown as typeof fetch;

  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: () => {}, progress: silent(),
  });
  expect(code).toBe(0);
  expect(await readFile(self, "utf8")).toBe(body);
  expect((await stat(self)).mode & 0o111).toBeGreaterThan(0);
});

test("progress is told the size, advanced, and finished exactly once", async () => {
  const body = "x".repeat(4096);
  const sum = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const dir = await mkdtemp(join(tmpdir(), "paddock-up-"));
  const self = join(dir, "paddock");
  await writeFile(self, "OLD BINARY");
  await chmod(self, 0o755);
  // content-length is set EXPLICITLY rather than left to `new Response(string)`.
  // This test asserts what the updater does with the header; relying on the
  // Response constructor to supply one would make it a test of Bun instead.
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${sum}  paddock-linux-x86_64\n`);
    }
    return new Response(body, { headers: { "content-length": String(body.length) } });
  }) as unknown as typeof fetch;
  const events: string[] = [];
  let advanced = 0;
  const code = await runUpdate({
    selfPath: self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: () => {},
    progress: {
      start: (label, total) => events.push(`start:${label}:${total}`),
      advance: (n) => { advanced += n; },
      done: () => events.push("done"),
    },
  });
  expect(code).toBe(0);
  expect(events[0]).toBe(`start:paddock-linux-x86_64:${body.length}`);
  expect(events.filter((e) => e === "done")).toHaveLength(1);
  expect(advanced).toBe(body.length);
});

test("a passing checksum is not announced, but a failing one still is", async () => {
  const good = await harness("NEW BINARY", new Bun.CryptoHasher("sha256").update("NEW BINARY").digest("hex"));
  const quiet: string[] = [];
  await runUpdate({
    selfPath: good.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: good.fetchImpl, log: (s) => quiet.push(s), progress: silent(),
  });
  // Presentation: a passing integrity check is not news.
  expect(quiet.join("\n")).not.toContain("sha256");
  expect(quiet.join("\n")).toContain("updated to 9.9.9");

  // Never swallowed: a FAILING one is the whole point of the check.
  const bad = await harness("NEW BINARY", "0".repeat(64));
  const loud: string[] = [];
  const code = await runUpdate({
    selfPath: bad.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: bad.fetchImpl, log: (s) => loud.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(loud.join("\n")).toContain("CHECKSUM MISMATCH");
  expect(await readFile(bad.self, "utf8")).toBe("OLD BINARY");
});

test("a checksum mismatch leaves no temp file behind", async () => {
  // The half-finished write this command must never leave: a full-size
  // .paddock.new sitting next to the binary with nothing mentioning it.
  const h = await harness("NEW BINARY", "0".repeat(64));
  await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: h.fetchImpl, log: () => {}, progress: silent(),
  });
  expect(await readdir(h.dir)).not.toContain(".paddock.new");
});

test("--check downloads nothing and never touches the sink", async () => {
  const h = await harness("NEW BINARY", "unused");
  const events: string[] = [];
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl: h.fetchImpl, log: () => {}, checkOnly: true,
    progress: { start: () => events.push("start"), advance: () => {}, done: () => events.push("done") },
  });
  expect(code).toBe(0);
  expect(events).toEqual([]);
});

test("a body that ends mid-stream is reported, and the binary survives", async () => {
  const h = await harness("unused", "unused");
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v9.9.9" }));
    }
    if (String(url).endsWith("SHA256SUMS")) {
      return new Response(`${"a".repeat(64)}  paddock-linux-x86_64\n`);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("half"));
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(stream);
  }) as unknown as typeof fetch;

  const said: string[] = [];
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64", current: "0.1.0",
    fetchImpl, log: (s) => said.push(s), progress: silent(),
  });
  expect(code).toBe(1);
  expect(said.join("\n")).toContain("download failed");
  expect(await readFile(h.self, "utf8")).toBe("OLD BINARY");
  expect(await readdir(h.dir)).not.toContain(".paddock.new");
});

// --- the instance still running the binary that was just replaced ----------
//
// `update` swaps the file on disk; a paddock already running keeps serving
// from the REPLACED inode (`/proc/<pid>/exe` reads "… (deleted)") until it is
// restarted. Nothing said so, so `paddock update` looked complete while the
// dashboard went on serving the old version indefinitely. Observed: an
// instance still answering 0.8.1 long after `paddock: updated to 0.8.2`.

test("update tells the operator to restart an instance still on the old version", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const said: string[] = [];
  const code = await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: (l) => said.push(l),
    running: async () => ({ pid: 3558072, port: 8787, version: "0.1.0" }),
  });

  expect(code).toBe(0);
  const text = said.join("\n");
  expect(text).toContain("3558072");
  expect(text).toContain("8787");
  expect(text).toContain("0.1.0");
  // The exact command, because "restart it" leaves the operator guessing which
  // of stop/start/kill is meant.
  expect(text).toContain("paddock stop && paddock start");
});

test("update says nothing about restarting when the running instance is already new", async () => {
  // The ordinary second run. A hint here would send the operator to bounce a
  // dashboard that is already serving the new binary.
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const said: string[] = [];
  await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: (l) => said.push(l),
    running: async () => ({ pid: 111, port: 8787, version: "9.9.9" }),
  });
  expect(said.join("\n")).not.toContain("paddock stop && paddock start");
});

test("update says nothing about restarting when nothing is running", async () => {
  const body = "NEW BINARY";
  const h = await harness(body, await sha(body));
  const said: string[] = [];
  await runUpdate({
    selfPath: h.self, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: (l) => said.push(l),
    running: async () => null,
  });
  expect(said.join("\n")).not.toContain("restart");
});

// --- Homebrew-managed installs ------------------------------------------
//
// A tap installs the SAME released binary this updater downloads, so there is
// no build-time flag to distinguish the two — the artifact is byte-identical.
// The install PATH is the only signal, and `/Cellar/` is the one invariant:
// every Homebrew prefix (/opt/homebrew, /usr/local, Linuxbrew's default under
// a home directory, or a custom one) puts kegs under
// <prefix>/Cellar/<name>/<version>/. Home paths are written as /path/to/ here
// because this repository is public and CLAUDE.md forbids absolute home paths;
// what the check actually reads is the segment, not the prefix.

test("a Cellar path is recognised under every Homebrew prefix", () => {
  expect(isBrewManaged("/opt/homebrew/Cellar/paddock/0.8.4/bin/paddock")).toBe(true);
  expect(isBrewManaged("/usr/local/Cellar/paddock/0.8.4/bin/paddock")).toBe(true);
  expect(isBrewManaged("/path/to/linuxbrew/.linuxbrew/Cellar/paddock/0.8.4/bin/paddock")).toBe(true);
  expect(isBrewManaged("/opt/custom-brew/Cellar/paddock/0.8.4/bin/paddock")).toBe(true);
});

test("an ordinary install path is not mistaken for a Homebrew keg", () => {
  // The installer's default, and the two paths most likely to be a false
  // positive: a directory merely NAMED Cellar-something, and a project that
  // happens to have the word in it.
  expect(isBrewManaged("/path/to/.local/bin/paddock")).toBe(false);
  expect(isBrewManaged("/usr/local/bin/paddock")).toBe(false);
  expect(isBrewManaged("/path/to/Cellars/paddock")).toBe(false);
  expect(isBrewManaged("/path/to/wine-cellar/bin/paddock")).toBe(false);
});

/** The real brew layout: a keg under Cellar, symlinked into <prefix>/bin. */
async function brewHarness(body: string, sum: string) {
  const dir = await mkdtemp(join(tmpdir(), "paddock-brew-"));
  const keg = join(dir, "opt", "homebrew", "Cellar", "paddock", "0.8.4", "bin");
  await mkdir(keg, { recursive: true });
  const kegBin = join(keg, "paddock");
  await writeFile(kegBin, "BREW BINARY");
  await chmod(kegBin, 0o755);
  const linkDir = join(dir, "opt", "homebrew", "bin");
  await mkdir(linkDir, { recursive: true });
  const link = join(linkDir, "paddock");
  await symlink(kegBin, link);
  const h = await harness(body, sum);
  return { dir, kegBin, link, fetchImpl: h.fetchImpl };
}

test("update refuses to overwrite a Homebrew keg and points at brew", async () => {
  // The Homebrew prefix is user-owned, so rename(2) here would SUCCEED --
  // leaving `brew info paddock` reporting a version that is no longer the
  // bytes on disk. The existing "installed by a package manager" message
  // only fires when rename FAILS, which under brew it does not.
  const body = "NEW BINARY";
  const h = await brewHarness(body, await sha(body));
  const said: string[] = [];
  const code = await runUpdate({
    selfPath: h.kegBin, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: (l) => said.push(l),
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.kegBin, "utf8")).toBe("BREW BINARY");
  expect(said.join("\n")).toContain("brew upgrade paddock");
});

test("update follows the brew symlink before deciding, so <prefix>/bin is caught too", async () => {
  // process.execPath may hand back either the symlink in <prefix>/bin or the
  // resolved keg path. A guard that only inspects the literal string misses
  // the former and overwrites the keg through the link.
  const body = "NEW BINARY";
  const h = await brewHarness(body, await sha(body));
  const code = await runUpdate({
    selfPath: h.link, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: h.fetchImpl, log: () => {},
  });
  expect(code).not.toBe(0);
  expect(await readFile(h.kegBin, "utf8")).toBe("BREW BINARY");
});

test("--check still reports a new version under brew, and names brew upgrade", async () => {
  // The check writes nothing, so there is no reason to refuse it -- and the
  // in-app update banner depends on this signal. It must name the command
  // that actually works here, not `paddock update`.
  const body = "NEW BINARY";
  const h = await brewHarness(body, await sha(body));
  const said: string[] = [];
  const code = await runUpdate({
    selfPath: h.kegBin, platform: "linux", arch: "x64",
    current: "0.1.0", checkOnly: true, fetchImpl: h.fetchImpl,
    log: (l) => said.push(l),
  });
  expect(code).toBe(0);
  const text = said.join("\n");
  expect(text).toContain("0.1.0 -> 9.9.9");
  expect(text).toContain("brew upgrade paddock");
  expect(text).not.toContain("run `paddock update`");
});

test("the brew guard does not download the binary before refusing", async () => {
  // Refusing after pulling 83MB would be a silly way to say no. The release
  // API call is fine -- it is how the version is known -- but the asset must
  // never be fetched.
  const body = "NEW BINARY";
  const h = await brewHarness(body, await sha(body));
  const asked: string[] = [];
  const spy = (async (url: string) => {
    asked.push(String(url));
    return h.fetchImpl(url as unknown as Request);
  }) as unknown as typeof fetch;
  await runUpdate({
    selfPath: h.kegBin, platform: "linux", arch: "x64",
    current: "0.1.0", fetchImpl: spy, log: () => {},
  });
  expect(asked.some((u) => u.includes("releases/latest"))).toBe(true);
  expect(asked.some((u) => u.endsWith("paddock-linux-x86_64"))).toBe(false);
});

test("detectManagedBy reports homebrew for a keg reached through its symlink", async () => {
  // What index.ts calls at boot with process.execPath. The realpath hop is the
  // part worth testing: brew leaves a symlink in <prefix>/bin, and execPath may
  // hand back either that or the keg.
  const h = await brewHarness("unused", "unused");
  expect(await detectManagedBy(h.link)).toBe("homebrew");
  expect(await detectManagedBy(h.kegBin)).toBe("homebrew");
});

test("detectManagedBy reports null for an ordinary install", async () => {
  const h = await harness("unused", "unused");
  expect(await detectManagedBy(h.self)).toBeNull();
});

test("detectManagedBy does not throw on a path that cannot be resolved", async () => {
  // A dev checkout's execPath points at bun, and an operator can always delete
  // things underneath a running process. Boot must not die for this.
  expect(await detectManagedBy("/nonexistent/paddock")).toBeNull();
});
