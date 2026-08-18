import { expect, test } from "bun:test";

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

test("the script never uses sudo and never pipes a download into a shell", () => {
  expect(sh).not.toContain("sudo");
  expect(sh).not.toMatch(/curl[^\n|]*\|\s*sh/);
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
