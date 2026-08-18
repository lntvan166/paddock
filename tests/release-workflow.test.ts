import { expect, test } from "bun:test";

const wf = await Bun.file(".github/workflows/release.yml").text();

test("releases build exactly the four platforms herdr supports", () => {
  // herdr publishes linux-{aarch64,x86_64} and macos-{aarch64,x86_64} and no
  // Windows build. paddock reaches herdr over a unix socket, so a Windows
  // binary would start and find nothing to connect to.
  for (const t of ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"]) {
    expect(wf).toContain(t);
  }
  expect(wf).not.toContain("bun-windows-");
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

test("release is created if it does not exist, or uploads into it if it does", () => {
  // Pushing a tag does not automatically create a release. The workflow must
  // handle both cases: bare tag push (create) and hand-written release (upload).
  expect(wf).toContain("gh release view");
  expect(wf).toContain("gh release create");
  expect(wf).toContain("gh release upload");
});

test("the compiled artifact's version stamp is smoke-tested before it is published", () => {
  // Nothing else in this pipeline runs a binary. If the `--define` quoting on
  // the Compile step ever breaks, every released binary reports 0.0.0-dev —
  // and update.ts refuses to update a 0.0.0-dev build by design, so `paddock
  // update` would decline on every release with the suite still green.
  //
  // The step must run AFTER Compile (there is no binary before it) and BEFORE
  // the release is created, so a bad stamp fails the job instead of shipping.
  const compileAt = wf.indexOf("- name: Compile");
  const smokeAt = wf.indexOf("--version");
  const publishAt = wf.indexOf("- name: Attach to the release");
  expect(smokeAt, "no step ever runs the binary and reads its version").toBeGreaterThan(-1);
  expect(smokeAt).toBeGreaterThan(compileAt);
  expect(smokeAt).toBeLessThan(publishAt);
  // Compared against the tag, not merely printed. A step that echoes the
  // version and always exits 0 would satisfy an "is it mentioned" check.
  expect(wf).toContain("out/paddock-linux-x86_64 --version");
  expect(wf).toMatch(/if \[ "\$GOT" != "\$VERSION" \]; then/);
});
