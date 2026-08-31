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
 *
 * The copy has since moved out of the workflow and into
 * scripts/assemble-site.ts, which THROWS when install.sh is missing. That is
 * strictly stronger than the old `cp`: a missing script now fails the build
 * rather than publishing a site whose install command 404s. The guarantee is
 * unchanged, so the test follows it to its new home rather than being deleted.
 */
const assemble = await Bun.file("scripts/assemble-site.ts").text();
const installShExists = await Bun.file("install.sh").exists();

test("install.sh reaches the published directory", () => {
  expect(assemble, "the published install command 404s without this").toContain(
    "install.sh",
  );
});

test("a missing install.sh fails the build rather than publishing without it", () => {
  // The whole point. A silent skip here is a deploy that looks healthy and
  // whose advertised install command does not exist.
  expect(assemble).toContain("no install script at");
  expect(assemble).toContain("throw new Error");
});

test("the script published is the one this repo tests", () => {
  // A copy of a stale or hand-edited install.sh would pass the checks above
  // while shipping something tests/install-script.test.ts never sees. The
  // source path must be the repo's own install.sh, at the root.
  expect(assemble).toContain('installScript: "install.sh"');
  expect(installShExists).toBe(true);
});
