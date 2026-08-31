import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * The demo site is built by Vercel from this file, on every push to main.
 *
 * That is a RECONSIDERED position, and the cost is real: Vercel does not wait
 * for CI, so a red tree can publish. The gates still run in `ci.yml`; they no
 * longer block the deploy. `docs/decisions.md` 30 records why that was
 * accepted. What this file guards is everything that is still checkable
 * without a workflow: that the build produces the assembled directory, that
 * the retirement of the old host is complete, and that the served file routes
 * carry the headers the real ones do.
 */
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

test("vercel builds the assembled site with the repo's own build", () => {
  expect(vercel.buildCommand).toBe("bun run build:demo");
  // The published directory is the one scripts/assemble-site.ts writes — the
  // landing page at its root and the app under /app/. Point this anywhere else
  // and the deploy is green with no demo in it.
  expect(vercel.outputDirectory).toBe("dist-site");
});

test("the install uses bun and the committed lockfile", () => {
  // Without this Vercel may reach for npm, which has no lockfile here and
  // would resolve a different dependency tree than every test ran against.
  expect(vercel.installCommand).toContain("bun install");
  expect(vercel.installCommand).toContain("--frozen-lockfile");
});

test("the gates still run somewhere, even though they no longer block", () => {
  // They stopped gating the deploy when the Git integration was turned on. If
  // they stopped running altogether, nothing would report a red tree at all.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  for (const gate of ["make check", "make check-clean", "make test"]) {
    expect(ci, `${gate} no longer runs anywhere`).toContain(gate);
  }
});

test("nothing in the repository still points at the retired host", () => {
  // The migration is all-or-nothing: a half-done one leaves an install command
  // that 404s in a README that otherwise reads correctly.
  const files = [
    "README.md",
    "install.sh",
    ".github/ISSUE_TEMPLATE/config.yml",
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
