import { chmod, rename, writeFile } from "node:fs/promises";
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

/** Numeric compare. `0.10.0` is newer than `0.9.0`, which a string compare gets wrong. */
export function isNewer(latest: string, current: string): boolean {
  const nums = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((p) => Number(p) || 0);
  const [a, b] = [nums(latest), nums(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
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
  // In a source checkout, `Bun.argv[0]` and `process.execPath` both point at
  // the operator's own `bun` installation (measured: both are
  // `~/.bun/bin/bun`), not at a paddock binary. A 0.0.0-dev build — one that
  // did not come from a release — has no business overwriting anything, and
  // that is exactly the case where `selfPath` points at bun rather than
  // paddock. Checking this FIRST, before any fetch or path resolution, is
  // what stops `paddock update` run from a source checkout from downloading
  // a release and clobbering the operator's bun binary.
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

  const rel = await f(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!rel.ok) { log(`paddock: could not reach the release API (HTTP ${rel.status})`); return 1; }
  const latest = String(((await rel.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  if (!latest) { log("paddock: the release API returned no tag"); return 1; }

  if (!isNewer(latest, o.current)) {
    log(`paddock: ${o.current} is current (latest is ${latest})`);
    return 0;
  }
  log(`paddock: ${o.current} -> ${latest}`);
  if (o.checkOnly) { log("paddock: run 'paddock update' to install it"); return 0; }

  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  const [binRes, sumRes] = await Promise.all([f(`${base}/${asset}`), f(`${base}/SHA256SUMS`)]);
  if (!binRes.ok || !sumRes.ok) { log("paddock: download failed"); return 1; }

  const bytes = new Uint8Array(await binRes.arrayBuffer());
  const expected = (await sumRes.text())
    .split("\n").find((l) => l.trim().endsWith(asset))?.trim().split(/\s+/)[0];
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
    await chmod(tmp, 0o755);
    // rename(2) over a running executable is safe on Linux and macOS: the
    // running process keeps its inode and the next invocation gets the new
    // file. This is why dropping Windows simplified the design.
    await rename(tmp, o.selfPath);
  } catch (e) {
    log(`paddock: could not replace ${o.selfPath}: ${(e as Error).message}`);
    log("paddock: if it was installed by a package manager, update it there instead");
    return 1;
  }
  log(`paddock: updated to ${latest}`);
  return 0;
}
