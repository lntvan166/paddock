import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, USAGE } from "@server/cli";

test("bare invocation serves — the Docker CMD and every doc depend on it", () => {
  expect(parseArgs([])).toEqual({ command: "serve", flags: new Set(), verb: null });
});

test("--demo still serves", () => {
  expect(parseArgs(["--demo"]))
    .toEqual({ command: "serve", flags: new Set(["--demo"]), verb: null });
});

test("an explicit `serve` verb serves too — CLAUDE.md documents `paddock serve --demo`", () => {
  expect(parseArgs(["serve", "--demo"]))
    .toEqual({ command: "serve", flags: new Set(["--demo"]), verb: "serve" });
});

test("update is a command, and carries its own flag", () => {
  expect(parseArgs(["update"]))
    .toEqual({ command: "update", flags: new Set(), verb: "update" });
  expect(parseArgs(["update", "--check"]))
    .toEqual({ command: "update", flags: new Set(["--check"]), verb: "update" });
});

test("flags may precede the command", () => {
  expect(parseArgs(["--check", "update"]))
    .toEqual({ command: "update", flags: new Set(["--check"]), verb: "update" });
});

test("an unrecognised verb is `unknown`, never `serve`", () => {
  // The defect: anything that was not "update" fell through to serve, so
  // `paddock updte` launched a dashboard instead of saying the verb does not
  // exist. The verb is carried through so the error can quote it back.
  expect(parseArgs(["updte"]))
    .toEqual({ command: "unknown", flags: new Set(), verb: "updte" });
  expect(parseArgs(["--demo", "nonsense"]))
    .toEqual({ command: "unknown", flags: new Set(["--demo"]), verb: "nonsense" });
});

test("the reserved verbs come through the parser, not a second argv scan", () => {
  // index.ts used to scan raw Bun.argv for these while parseArgs claimed the
  // same invocation was `serve` — two mechanisms, one function, free to
  // disagree. `paddock --demo agent` is the case where they did.
  expect(parseArgs(["agent"]).command).toBe("agent");
  expect(parseArgs(["hub"]).command).toBe("hub");
  expect(parseArgs(["--demo", "agent"]).command).toBe("agent");
});

test("the usage line names every implemented verb", () => {
  // What an operator who mistyped a verb is shown. If a verb is added without
  // being listed here, the error message teaches them the wrong vocabulary.
  expect(USAGE).toContain("paddock update");
  expect(USAGE).toContain("--demo");
  expect(USAGE).toContain("--version");
});

// --- What the process actually does with those commands --------------------
//
// parseArgs is a pure function; these run the real entry point. All of them
// exit before any port is bound or any herdr socket is opened, so they are
// cheap and touch nothing. The interpreted server is used rather than a
// compiled binary because the branch under test is the first thing in
// index.ts — compiling would test bun's bundler, not the dispatch.

const CONFIG = mkdtempSync(join(tmpdir(), "paddock-cli-"));

function runServer(args: string[]) {
  const r = Bun.spawnSync(["bun", "src/server/index.ts", ...args], {
    env: {
      ...process.env,
      // No network, and never the operator's real config directory.
      PADDOCK_NO_UPDATE_CHECK: "1",
      PADDOCK_CONFIG_DIR: CONFIG,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

test("an unknown verb exits non-zero with a usage line, instead of starting a dashboard", () => {
  const r = runServer(["updte"]);
  expect(r.code, "a mistyped verb must not start a server").not.toBe(0);
  expect(r.err).toContain("unknown command 'updte'");
  expect(r.err).toContain("usage: paddock");
  expect(r.out).not.toContain("paddock listening");
});

test("a mistyped verb is an error even when a flag would otherwise answer", () => {
  // --version is handled after the verb check on purpose: the operator asked
  // for a command that does not exist, and answering anything else pretends
  // the typo was understood.
  const r = runServer(["updte", "--version"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("unknown command");
});

test("the reserved verbs still exit 2 and still point at the roadmap", () => {
  for (const verb of ["agent", "hub"]) {
    const r = runServer([verb]);
    expect(r.code, `paddock ${verb}`).toBe(2);
    expect(r.err).toContain(`paddock ${verb}: not implemented`);
    expect(r.err).toContain("docs/roadmap.md");
  }
});

test("--version still works with no verb, which is what the release smoke step runs", () => {
  const r = runServer(["--version"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("0.0.0-dev");
});

afterAll(() => { rmSync(CONFIG, { recursive: true, force: true }); });
