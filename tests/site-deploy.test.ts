import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const wf = readFileSync(".github/workflows/demo.yml", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  buildCommand?: string;
  outputDirectory?: string;
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

/**
 * demo.yml states why its gates exist: "a demo that ships from a red tree would
 * be advertising something that does not work." Vercel's own Git integration
 * would build on push and bypass all three, so it stays off and the workflow
 * keeps publishing.
 */
test("the three gates still run before anything is published", () => {
  for (const gate of ["make check", "make check-clean", "make test"]) {
    expect(wf, `${gate} no longer gates the deploy`).toContain(gate);
  }
});

/** The CLI is invoked as `bunx vercel@latest <cmd>`, so the version pin sits
 *  between the two words a naive `includes` would look for. */
const at = (cmd: string): number => wf.search(new RegExp(`vercel(@\\S+)?\\s+${cmd}`));

test("the gates run BEFORE the deploy, not beside it", () => {
  const tested = wf.indexOf("make test");
  const deploy = at("deploy");
  expect(deploy).toBeGreaterThan(-1);
  expect(deploy, "a deploy that races its own gates is not gated").toBeGreaterThan(tested);
});

test("the deploy publishes what vercel build produced, not a fresh remote build", () => {
  // --prebuilt reads .vercel/output, which `vercel build` writes. Without the
  // build step it deploys nothing; without --prebuilt Vercel rebuilds remotely
  // and the gates are bypassed after all.
  expect(at("build"), "nothing writes .vercel/output").toBeGreaterThan(-1);
  expect(wf).toContain("--prebuilt");
  expect(at("build")).toBeLessThan(at("deploy"));
});

test("vercel builds the assembled site, using the repo's own build", () => {
  expect(vercel.buildCommand).toBe("bun run build:demo");
  expect(vercel.outputDirectory).toBe("dist-site");
});

test("nothing in the repository still points at the retired host", () => {
  // The migration is all-or-nothing: a half-done one leaves an install command
  // that 404s in a README that otherwise reads correctly.
  const files = [
    "README.md",
    "install.sh",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/workflows/demo.yml",
    "docs/design/2026-08-18-distribution-and-update-design.md",
    "docs/plans/2026-08-18-distribution-and-update.md",
  ];
  for (const f of files) {
    expect(readFileSync(f, "utf8"), `${f} still points at the retired host`).not.toContain(
      "github.io",
    );
  }
});

test("the extensionless download is served as HTML, not guessed at", () => {
  // /api/files/<id>/index.html gets its type from the extension. Its sibling
  // `download` has none, and a host that guesses serves it as octet-stream.
  const rule = vercel.headers?.find((h) => h.source.includes("/api/files/"));
  expect(rule, "no content-type rule for the demo file routes").toBeDefined();
  const ct = rule!.headers.find((h) => h.key.toLowerCase() === "content-type");
  expect(ct?.value).toContain("text/html");
});

test("the served file carries the same sandbox header the real route sets", () => {
  // routes.ts sets `Content-Security-Policy: sandbox` on BOTH file routes and
  // explains why at length: without it an agent-authored page served here is
  // same-origin with paddock and can drive the operator's agents. The demo
  // mirrors production rather than modelling a weaker thing.
  const rule = vercel.headers?.find((h) => h.source.includes("/api/files/"));
  const csp = rule!.headers.find((h) => h.key.toLowerCase() === "content-security-policy");
  expect(csp?.value).toContain("sandbox");
});
