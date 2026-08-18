import { expect, test } from "bun:test";

const wf = await Bun.file(".github/workflows/release.yml").text();

test("releases build exactly the four platforms herdr supports", () => {
  // herdr publishes linux-{aarch64,x86_64} and macos-{aarch64,x86_64} and no
  // Windows build. paddock reaches herdr over a unix socket, so a Windows
  // binary would start and find nothing to connect to.
  for (const t of ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"]) {
    expect(wf).toContain(t);
  }
  expect(wf).not.toContain("windows");
});

test("assets are named with herdr's vocabulary, so the two read as siblings", () => {
  for (const n of ["paddock-linux-x86_64", "paddock-linux-aarch64",
                   "paddock-macos-x86_64", "paddock-macos-aarch64"]) {
    expect(wf).toContain(n);
  }
});

test("checksums are published, and the version is stamped from the tag", () => {
  expect(wf).toContain("SHA256SUMS");
  expect(wf).toContain("PADDOCK_VERSION");
});
