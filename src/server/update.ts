import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO = "lntvan166/paddock";

/**
 * The same mapping `install.sh` uses, so the installer and the updater cannot
 * disagree about which asset to fetch. Windows returns null deliberately:
 * herdr publishes no Windows build, so there is nothing to connect to.
 */
export function assetName(platform: string, arch: string): string | null {
  const os = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  return os && cpu ? `paddock-${os}-${cpu}` : null;
}

/**
 * Parses `major.minor.patch[-prerelease][+build]`. Build metadata is dropped
 * before parsing — per semver it carries no ordering information, and NOT
 * dropping it used to be a bug here: `"3+build".split(".")` stays one token,
 * and `Number("3+build")` is `NaN`, which the old numeric coercion silently
 * turned into `0` — so `1.2.3+build` was compared as `1.2.0`, losing the
 * patch digit entirely.
 */
function parseVersion(v: string): { core: [number, number, number]; prerelease: string | null } {
  const noBuild = v.replace(/^v/, "").split("+")[0] ?? "";
  const [corePart, prerelease] = noBuild.split(/-(.+)/);
  const nums = (corePart ?? "").split(".").map((p) => Number(p) || 0);
  return {
    core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
    prerelease: prerelease ?? null,
  };
}

/**
 * Numeric compare. `0.10.0` is newer than `0.9.0`, which a string compare
 * gets wrong.
 *
 * A prerelease ranks BELOW the plain release with the same core version:
 * `isNewer("1.1.0-rc.1", "1.1.0")` is `false`. Without this, if a project
 * ever tags a release candidate ahead of its final release (a normal
 * sequence — `v1.1.0-rc.1` then later `v1.1.0`), `paddock update` would
 * offer — and install — a downgrade to the RC the moment the RC's tag
 * outranked the final release numerically but the prerelease ordering was
 * ignored.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  // Unrolled rather than looped: `core` is a fixed 3-tuple, and indexing a
  // tuple with a loop variable degrades to `number | undefined` under
  // noUncheckedIndexedAccess even though every index is in bounds.
  for (const i of [0, 1, 2] as const) {
    const d = a.core[i] - b.core[i];
    if (d !== 0) return d > 0;
  }
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === null) return true; // release beats its own prerelease
  if (b.prerelease === null) return false; // never "upgrade" a release to a prerelease
  return a.prerelease > b.prerelease;
}

export interface UpdateOpts {
  selfPath: string;
  platform: string;
  arch: string;
  current: string;
  checkOnly?: boolean;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}

/** Returns a process exit code. Never throws for an expected failure. */
export async function runUpdate(o: UpdateOpts): Promise<number> {
  const log = o.log ?? console.log;

  // Ruling: refuse a dev build before resolving or writing any path.
  //
  // In a source checkout, `process.execPath` (and, in an interpreted `bun
  // run`, `Bun.argv[0]` too) point at the operator's own `bun` installation,
  // not at a paddock binary. A 0.0.0-dev build — one that did not come from
  // a release — has no business overwriting anything, and that is exactly
  // the case where the resolved path points at bun rather than paddock.
  // Checking this FIRST, before any fetch or path resolution, is what stops
  // `paddock update` run from a source checkout from downloading a release
  // and clobbering the operator's bun binary.
  if (o.current === "0.0.0-dev") {
    log("paddock: this is a dev build (0.0.0-dev), not a release — nothing to update");
    log("paddock: run 'git pull' instead");
    return 1;
  }

  const f = o.fetchImpl ?? fetch;

  const asset = assetName(o.platform, o.arch);
  if (!asset) {
    log(`paddock: no release build for ${o.platform}/${o.arch}`);
    return 1;
  }

  let latest: string;
  try {
    const rel = await f(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!rel.ok) { log(`paddock: could not reach the release API (HTTP ${rel.status})`); return 1; }
    latest = String(((await rel.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  } catch (e) {
    // Offline, DNS failure, TLS error, a malformed JSON body — none of these
    // are exotic for an operator running this from a laptop. This function
    // returns an exit code; it does not get to throw a stack trace at
    // whoever called it just because the likeliest failure is a network one.
    log(`paddock: could not reach the release API: ${(e as Error).message}`);
    return 1;
  }
  if (!latest) { log("paddock: the release API returned no tag"); return 1; }

  if (!isNewer(latest, o.current)) {
    log(`paddock: ${o.current} is current (latest is ${latest})`);
    return 0;
  }
  log(`paddock: ${o.current} -> ${latest}`);
  if (o.checkOnly) { log("paddock: run 'paddock update' to install it"); return 0; }

  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  let bytes: Uint8Array;
  let expected: string | undefined;
  try {
    const [binRes, sumRes] = await Promise.all([f(`${base}/${asset}`), f(`${base}/SHA256SUMS`)]);
    if (!binRes.ok || !sumRes.ok) { log("paddock: download failed"); return 1; }
    bytes = new Uint8Array(await binRes.arrayBuffer());
    expected = (await sumRes.text())
      .split("\n").find((l) => l.trim().endsWith(asset))?.trim().split(/\s+/)[0];
  } catch (e) {
    // A body that ends mid-stream (a declared content-length the connection
    // never delivers) throws out of arrayBuffer()/text() rather than
    // resolving with a short buffer, so this needs the same treatment as the
    // release-API fetch above.
    log(`paddock: download failed: ${(e as Error).message}`);
    return 1;
  }
  if (!expected) { log(`paddock: ${asset} is not listed in SHA256SUMS`); return 1; }

  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // Nothing is written. Replacing a working install with a broken one is a
    // worse outcome than not updating.
    log("paddock: CHECKSUM MISMATCH — keeping the current binary");
    log(`  expected ${expected}`);
    log(`  actual   ${actual}`);
    return 1;
  }

  const tmp = join(dirname(o.selfPath), ".paddock.new");
  try {
    await writeFile(tmp, bytes);
    // writeFile creates the file at the umask's default (typically 0644).
    // This chmod is the ONLY thing that makes the replacement executable —
    // dropping it would ship a `paddock` that no longer runs, silently,
    // by way of the update path meant to keep it running.
    await chmod(tmp, 0o755);
    // rename(2) over a running executable is safe on Linux and macOS: the
    // running process keeps its inode and the next invocation gets the new
    // file. This is why dropping Windows simplified the design.
    await rename(tmp, o.selfPath);
  } catch (e) {
    log(`paddock: could not replace ${o.selfPath}: ${(e as Error).message}`);
    log("paddock: if it was installed by a package manager, update it there instead");
    // A half-finished write here is exactly the half-update this command
    // must refuse to leave behind: if writeFile succeeded but chmod or
    // rename then failed, a full-size temp file would otherwise sit next to
    // the binary forever with no mention of it in the error above.
    try {
      await rm(tmp, { force: true });
    } catch (cleanupErr) {
      log(`paddock: also failed to remove the leftover temp file ${tmp}: ${(cleanupErr as Error).message}`);
    }
    return 1;
  }
  log(`paddock: updated to ${latest}`);
  return 0;
}
