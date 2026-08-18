import { expect, test } from "bun:test";

/**
 * The design named this check explicitly:
 *
 *   "demo.yml publishes the directory dist-demo as the Pages artifact, so
 *    install.sh must be copied into dist-demo by that workflow or the
 *    published URL returns 404 while every other page keeps working. A check
 *    asserts the script is present in the artifact, because the failure mode
 *    is a broken install command on a site that otherwise looks healthy."
 *
 * It was never written. Deleting the `cp` line from demo.yml left every test
 * in the suite passing — while README.md advertises that exact URL as the way
 * to install paddock, and the demo site would still load perfectly.
 */
const wf = await Bun.file(".github/workflows/demo.yml").text();

test("install.sh is copied into the directory that becomes the Pages artifact", () => {
  expect(wf, "the published install command 404s without this").toContain(
    "cp install.sh dist-demo/install.sh",
  );
});

test("the copy happens before the artifact is uploaded, and into the uploaded directory", () => {
  // Ordering is the whole point: a copy after upload-pages-artifact would be
  // just as invisible as no copy at all.
  const buildAt = wf.indexOf("bun run build:demo");
  const copyAt = wf.indexOf("cp install.sh");
  const uploadAt = wf.indexOf("upload-pages-artifact");
  expect(copyAt).toBeGreaterThan(-1);
  expect(uploadAt).toBeGreaterThan(-1);
  // After build:demo too — `vite build --outDir dist-demo` would otherwise
  // clean the directory out from under the copy.
  expect(copyAt).toBeGreaterThan(buildAt);
  expect(copyAt).toBeLessThan(uploadAt);
  // And the directory it lands in must be the one actually published.
  expect(wf).toMatch(/path:\s*dist-demo\s*$/m);
});

const installShExists = await Bun.file("install.sh").exists();

test("the script the workflow publishes is the one this repo tests", () => {
  // A copy of a stale or hand-edited install.sh would pass the checks above
  // while shipping something tests/install-script.test.ts never sees. The
  // source path must be the repo's own install.sh, at the root.
  expect(wf).toMatch(/cp install\.sh dist-demo\//);
  expect(installShExists).toBe(true);
});
