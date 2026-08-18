import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const sh = await Bun.file("install.sh").text();

/**
 * install.sh with its comment lines removed. Several checks below are ordering
 * or absence checks over the SCRIPT's behaviour, and the script explains its
 * own reasoning in prose that quotes the very constructs being checked for —
 * so matching against the raw text finds the comment instead of the code.
 */
const code = sh.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["sh", "install.sh", ...args], { env: { ...process.env, ...env } });

test("every supported platform maps to a real asset name", () => {
  for (const [os, arch, asset] of [
    ["Linux", "x86_64", "paddock-linux-x86_64"],
    ["Linux", "aarch64", "paddock-linux-aarch64"],
    ["Darwin", "arm64", "paddock-macos-aarch64"],
    ["Darwin", "x86_64", "paddock-macos-x86_64"],
  ] as const) {
    const r = run(["--print-asset"], { PADDOCK_UNAME_S: os, PADDOCK_UNAME_M: arch });
    expect(r.exitCode, `${os}/${arch} should resolve`).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe(asset);
  }
});

test("an unsupported platform exits non-zero rather than downloading something useless", () => {
  const r = run(["--print-asset"], { PADDOCK_UNAME_S: "Windows_NT", PADDOCK_UNAME_M: "x86_64" });
  expect(r.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(r.stderr)).toContain("unsupported");
});

test("the script never pipes a download into a shell", () => {
  expect(sh).not.toMatch(/curl[^\n|]*\|\s*sh/);
});

// Asserts the absence of the BEHAVIOUR (a privilege-escalation invocation),
// not the absence of the WORD — a bare string check would also forbid the
// script from naming its own design decision in a comment ("No sudo."), while
// failing to catch doas, pkexec, or `su -c`. Comments are stripped first so
// that plain-English wording stays legal.
test("the script contains no privilege-escalation invocation", () => {
  expect(code).not.toMatch(/\b(sudo|doas|pkexec)\b/);
  expect(code).not.toMatch(/\bsu\s+-c\b/);
});

test("the checksum is verified before the binary is installed", () => {
  const verifyAt = code.search(/sha256sum|shasum/);
  const installAt = code.search(/mv .*\$BIN|install -m/);
  expect(verifyAt).toBeGreaterThan(-1);
  expect(installAt).toBeGreaterThan(-1);
  expect(verifyAt).toBeLessThan(installAt);
});

test("errors are not swallowed", () => {
  expect(sh).toContain("set -eu");
  expect(sh).not.toContain("2>/dev/null");
});

// --- Offline exercise of the real download -> verify -> install pipeline ---
//
// These drive install.sh end to end (not --print-asset) with no network
// access at all: PADDOCK_CURL points at a stub `curl` that copies fixture
// bytes named after the requested URL's last path segment. PADDOCK_BIN_DIR
// keeps every install inside a throwaway temp dir, TMPDIR is set so we can
// also inspect what the script's own `mktemp -d` scratch dir left behind, and
// STUB_LOG records every `-o` target so a test can see WHERE a download
// landed.

const ASSET = "paddock-linux-x86_64";

const STUB_CURL = `#!/bin/sh
# Test-only stub for curl. Touches no network at all: it copies the fixture
# named after the URL's LAST PATH SEGMENT out of $STUB_ASSETS_DIR into the -o
# target. Keyed on the URL rather than on the -o basename because install.sh
# now downloads into a dot-prefixed temp name in the destination directory,
# which is exactly the property the atomicity test below asserts.
#
# It emulates the two pieces of real curl behaviour install.sh depends on:
#   -w '%{http_code}'  writes the HTTP status to stdout, on success AND failure
#   -f                 exits non-zero (22) on an HTTP error, printing nothing
#                      of its own — which is why install.sh has to report it
#
# Every -o target it is asked to write is appended to $STUB_LOG, so a test can
# see WHERE the download landed.
set -eu
out=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
if [ -n "\${STUB_LOG:-}" ]; then echo "$out" >> "$STUB_LOG"; fi
src="$STUB_ASSETS_DIR/\${url##*/}"
if [ ! -f "$src" ]; then
  echo "404"
  exit 22
fi
cp "$src" "$out"
echo "200"
`;

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setupFixtures(
  binaryContent: string | null,
  sumsContent: string | null,
) {
  const work = mkdtempSync(join(tmpdir(), "paddock-install-test-"));
  const assets = join(work, "assets");
  const binDir = join(work, "bin");
  const tmpBase = join(work, "tmp-base");
  const log = join(work, "curl.log");
  mkdirSync(assets);
  mkdirSync(tmpBase);
  // `null` means "this asset does not exist" — the stub then answers 404 the
  // way curl -f does, which is the first-run case: installing before a
  // release with assets has been published.
  if (binaryContent !== null) writeFileSync(join(assets, ASSET), binaryContent);
  if (sumsContent !== null) writeFileSync(join(assets, "SHA256SUMS"), sumsContent);

  const curl = join(work, "stub-curl.sh");
  writeFileSync(curl, STUB_CURL);
  chmodSync(curl, 0o755);

  return { work, assets, binDir, tmpBase, curl, log };
}

function runInstall(fx: ReturnType<typeof setupFixtures>) {
  return run([], {
    PADDOCK_UNAME_S: "Linux",
    PADDOCK_UNAME_M: "x86_64",
    PADDOCK_CURL: fx.curl,
    PADDOCK_BIN_DIR: fx.binDir,
    STUB_ASSETS_DIR: fx.assets,
    STUB_LOG: fx.log,
    TMPDIR: fx.tmpBase,
  });
}

test("a matching checksum installs the binary with the downloaded bytes", () => {
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  const fx = setupFixtures(content, `${sha256(content)}  ${ASSET}\n`);
  try {
    const r = runInstall(fx);
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);
    const installed = join(fx.binDir, "paddock");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(content);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("a mismatched checksum refuses, exits non-zero, and leaves no binary at the install path", () => {
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  const wrongSum = sha256("this is not the binary that was downloaded\n");
  const fx = setupFixtures(content, `${wrongSum}  ${ASSET}\n`);
  try {
    const r = runInstall(fx);
    expect(r.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toContain("CHECKSUM MISMATCH");
    expect(existsSync(join(fx.binDir, "paddock"))).toBe(false);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("an asset missing from SHA256SUMS refuses rather than comparing against an empty string", () => {
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  // SHA256SUMS exists and is well-formed, but lists a different asset only.
  const fx = setupFixtures(content, `${sha256("unrelated")}  paddock-macos-aarch64\n`);
  try {
    const r = runInstall(fx);
    expect(r.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toContain("not listed in SHA256SUMS");
    expect(existsSync(join(fx.binDir, "paddock"))).toBe(false);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("the temp directory is cleaned up after a failure, not only after success", () => {
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  const wrongSum = sha256("this is not the binary that was downloaded\n");
  const fx = setupFixtures(content, `${wrongSum}  ${ASSET}\n`);
  try {
    const r = runInstall(fx);
    expect(r.exitCode).not.toBe(0);
    // mktemp -d honours TMPDIR; the script's own EXIT trap must remove
    // whatever it created there even on the failure path.
    expect(readdirSync(fx.tmpBase)).toEqual([]);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

// --- Diagnostics and atomicity -------------------------------------------

test("a failed download names the URL and the HTTP status", () => {
  // Measured before this fix, with a stub that behaves like `curl -fsSL`
  // against a 404 (silent, exit 22), the entire output was:
  //
  //   paddock: downloading paddock-linux-x86_64
  //
  // and then a bare non-zero exit — because -f suppresses the error body, -s
  // suppresses curl's own message, and `set -e` ends the script before
  // anything can be said. The likeliest first run is exactly this case:
  // installing before a release with assets exists.
  const fx = setupFixtures(null, null);
  try {
    const r = runInstall(fx);
    expect(r.exitCode).not.toBe(0);
    const err = new TextDecoder().decode(r.stderr);
    expect(err).toContain("download failed");
    // The URL, so the operator can paste it into a browser and see for
    // themselves whether the asset exists.
    expect(err).toContain(`/releases/latest/download/${ASSET}`);
    // And the status, so "no release yet" is distinguishable from "offline".
    expect(err).toMatch(/http status\s+404/);
    expect(err).toContain("/releases");
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("a download that fails partway leaves nothing at the install path", () => {
  // The binary is fetched first, so this is the SHA256SUMS half failing after
  // bytes have already been written into the destination directory.
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  const fx = setupFixtures(content, null);
  try {
    const r = runInstall(fx);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(fx.binDir, "paddock"))).toBe(false);
    // And no half-downloaded temp file either: the EXIT trap covers the
    // destination directory now, not only $TMP.
    expect(readdirSync(fx.binDir)).toEqual([]);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});

test("the binary is downloaded into the destination directory, so the final move is a rename", () => {
  // This is the testable form of "the install is atomic".
  //
  // `mv` is only atomic when source and destination share a filesystem. The
  // previous version downloaded into `mktemp -d` — $TMPDIR, usually a
  // different filesystem from $HOME — so rename(2) failed EXDEV and mv
  // degraded to a byte-by-byte copy made DIRECTLY at the install path.
  // Traced on this branch before the fix:
  //
  //   renameat2(".../tmp.XXXX/paddock", ".../bin/paddock", RENAME_NOREPLACE)
  //     = -1 EXDEV (Invalid cross-device link)
  //   openat(".../bin/paddock", O_WRONLY|O_CREAT|O_EXCL, 0700) = 4
  //
  // Interrupted, or out of disk, that leaves a truncated executable at
  // ~/.local/bin/paddock. src/server/update.ts already gets this right
  // (temp file beside the binary, then rename); asserting the download's
  // destination directory is how that property is checked without depending
  // on the test machine having two filesystems.
  const content = "FAKE-PADDOCK-BINARY-CONTENTS\n";
  const fx = setupFixtures(content, `${sha256(content)}  ${ASSET}\n`);
  try {
    const r = runInstall(fx);
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);

    const targets = readFileSync(fx.log, "utf8").trim().split("\n");
    const binaryTarget = targets.find((t) => !t.endsWith("SHA256SUMS"));
    expect(binaryTarget, "the stub was never asked to write the binary").toBeDefined();
    expect(dirname(binaryTarget!)).toBe(fx.binDir);
    // Under a dot name, so an interrupted run does not leave something that
    // looks like an installed `paddock` sitting on PATH.
    expect(basename(binaryTarget!).startsWith(".")).toBe(true);

    // Nothing but the installed binary is left behind.
    expect(readdirSync(fx.binDir)).toEqual(["paddock"]);
  } finally {
    rmSync(fx.work, { recursive: true, force: true });
  }
});
