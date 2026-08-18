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
import { join } from "node:path";

const sh = await Bun.file("install.sh").text();

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
  const codeOnly = sh
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  expect(codeOnly).not.toMatch(/\b(sudo|doas|pkexec)\b/);
  expect(codeOnly).not.toMatch(/\bsu\s+-c\b/);
});

test("the checksum is verified before the binary is installed", () => {
  const verifyAt = sh.search(/sha256sum|shasum/);
  const installAt = sh.search(/mv .*\$BIN|install -m/);
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
// bytes for whatever `-o` target it's asked to write, keyed by that target's
// basename ("paddock" or "SHA256SUMS"). PADDOCK_BIN_DIR keeps every install
// inside a throwaway temp dir, and TMPDIR is set so we can also inspect what
// the script's own `mktemp -d` scratch dir left behind.

const ASSET = "paddock-linux-x86_64";

const STUB_CURL = `#!/bin/sh
# Test-only stub for curl. Ignores the URL entirely; copies a fixture file
# matching the -o target's basename from $STUB_ASSETS_DIR. This is what lets
# the real download -> verify -> install pipeline run with no network call.
set -eu
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
base=$(basename "$out")
src="$STUB_ASSETS_DIR/$base"
if [ ! -f "$src" ]; then
  echo "stub-curl: no fixture for $base in $STUB_ASSETS_DIR" >&2
  exit 1
fi
cp "$src" "$out"
`;

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setupFixtures(binaryContent: string, sumsContent: string) {
  const work = mkdtempSync(join(tmpdir(), "paddock-install-test-"));
  const assets = join(work, "assets");
  const binDir = join(work, "bin");
  const tmpBase = join(work, "tmp-base");
  mkdirSync(assets);
  mkdirSync(tmpBase);
  writeFileSync(join(assets, "paddock"), binaryContent);
  writeFileSync(join(assets, "SHA256SUMS"), sumsContent);

  const curl = join(work, "stub-curl.sh");
  writeFileSync(curl, STUB_CURL);
  chmodSync(curl, 0o755);

  return { work, assets, binDir, tmpBase, curl };
}

function runInstall(fx: ReturnType<typeof setupFixtures>) {
  return run([], {
    PADDOCK_UNAME_S: "Linux",
    PADDOCK_UNAME_M: "x86_64",
    PADDOCK_CURL: fx.curl,
    PADDOCK_BIN_DIR: fx.binDir,
    STUB_ASSETS_DIR: fx.assets,
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
