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

function runServer(args: string[], extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", "src/server/index.ts", ...args], {
    env: {
      ...process.env,
      // No network, and never the operator's real config directory.
      PADDOCK_NO_UPDATE_CHECK: "1",
      PADDOCK_CONFIG_DIR: CONFIG,
      ...extraEnv,
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

// A bogus, guaranteed-nonexistent herdr socket path plus no `--demo` means a
// regression back to the old fall-through would try the real herdr-connect
// path and fail fast (ENOENT), not hang — but `timeout` is a safety net
// regardless: a real serving instance keeps the event loop alive forever, and
// an un-timed spawnSync would hang this test suite rather than fail it.
function runVerb(verb: string, extraArgs: string[] = []) {
  const r = Bun.spawnSync(["bun", "src/server/index.ts", verb, ...extraArgs], {
    env: {
      ...process.env,
      PADDOCK_NO_UPDATE_CHECK: "1",
      PADDOCK_CONFIG_DIR: CONFIG,
      PADDOCK_HERDR_SOCKET: join(CONFIG, "no-such-herdr.sock"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  return {
    timedOut: r.exitedDueToTimeout,
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

test("start's own parsing process never binds a port, whatever the detached child does", () => {
  // `start` is now dispatched to real behaviour (runStart, tested in
  // lifecycle-start.test.ts): it spawns a detached child — this same binary,
  // re-invoked with no verb — and waits for THAT child's state file and
  // health endpoint before reporting success. So this no longer exits 0 vs
  // non-zero on a fixed rule; the durable property this test guards is
  // narrower and still holds regardless: the process handling `start`'s own
  // parsing and dispatch must never itself bind a port. Before Task 5's gate
  // existed, it fell through every `if` in index.ts all the way to
  // Bun.serve: `paddock start` silently became a foreground `serve` rather
  // than the detach-and-return the verb promises.
  //
  // The bogus herdr socket above means the spawned child fails fast
  // (ENOENT, not a hang), so this is also, incidentally, the case where the
  // child never binds a port either — but that is not what is asserted here.
  const r = runVerb("start");
  expect(r.timedOut, "paddock start never exited on its own — it is serving").not.toBe(true);
  expect(r.out, "paddock start printed the listening line — it bound a port")
    .not.toContain("paddock listening");
  expect(r.out, "start should report why the detached process did not come up")
    .toContain("did not start");
});

test("stop never binds a port or opens a herdr socket, whether or not anything is running", () => {
  // `stop` is now dispatched to real behaviour (runStop, tested in
  // lifecycle-stop.test.ts), so it legitimately exits 0 when nothing is
  // running — the "not implemented" assertion no longer applies to it. What
  // must remain true regardless of outcome: `stop` answers using only the
  // state file and a signal-0 probe, so it must never bind a port or reach
  // for the (bogus) herdr socket above.
  const r = runVerb("stop");
  expect(r.timedOut, "paddock stop never exited on its own — it is serving").not.toBe(true);
  expect(r.out, "paddock stop printed the listening line — it bound a port")
    .not.toContain("paddock listening");
  // Nothing was started in this CONFIG dir, so this is the legitimate
  // "not running" case: exit 0, not an error.
  expect(r.code, "paddock stop with nothing running").toBe(0);
});

test("--version still works with no verb, which is what the release smoke step runs", () => {
  const r = runServer(["--version"]);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toBe("0.0.0-dev");
});

afterAll(() => { rmSync(CONFIG, { recursive: true, force: true }); });

// --- help ------------------------------------------------------------------

test("help is a verb, and --help/-h ask the same question", () => {
  expect(parseArgs(["help"]).command).toBe("help");
  // These two were the bug: they start with "-", so `verb` was null, so
  // commandFor(null) returned "serve" and `paddock --help` served a dashboard.
  expect(parseArgs(["--help"]).command).toBe("help");
  expect(parseArgs(["-h"]).command).toBe("help");
});

test("a mistyped verb is still an error, even carrying --help", () => {
  // Same rule --version already follows: the operator asked for a command that
  // does not exist, and answering something else pretends the typo was
  // understood. The flag only answers where the command would have been serve.
  expect(parseArgs(["updte", "--help"]).command).toBe("unknown");
});

test("'paddock help' prints usage and succeeds", () => {
  const r = runServer(["help"]);
  expect(r.code, "asking for help is not an error").toBe(0);
  expect(r.out).toContain("usage: paddock");
  expect(r.err, "usage is the answer, not a complaint").not.toContain("unknown command");
});

test("'paddock --help' answers instead of starting a dashboard", () => {
  // The regression that matters. runServer points PADDOCK_HERDR_SOCKET at a
  // path that does not exist ON PURPOSE: if this ever falls through to serve
  // again, the process exits non-zero against the missing socket instead of
  // binding a port and hanging this test for ever.
  const r = runServer(["--help"], { PADDOCK_HERDR_SOCKET: "/nonexistent/herdr.sock" });
  expect(r.code, "--help must not start anything").toBe(0);
  expect(r.out).toContain("usage: paddock");
  // Behaviour, not vocabulary. A fall-through to serve names the socket it could
  // not reach BY PATH (herdrUnreachableMessage), so the injected path is the
  // tell. Matching the bare word "herdr" also forbade the usage text from naming
  // the tool paddock talks to, which `paddock doctor` has to do.
  expect(r.out + r.err, "no herdr socket may be opened").not.toContain("/nonexistent/herdr.sock");
  expect(r.out + r.err, "no port may be bound").not.toContain("listening");
});

test("doctor is a verb, not an unknown typo", () => {
  expect(parseArgs(["doctor"]).command).toBe("doctor");
});

test("usage lists doctor, so a mistyped verb teaches the real vocabulary", () => {
  expect(USAGE).toContain("paddock doctor");
});

// Same contract as update/status/stop/start: answers and exits without binding a
// port or opening the event stream. It reports 2 here — the socket path does not
// exist, so nothing was learned about herdr — which is exactly the code install.sh
// treats as a friendly skip rather than a failure.
test("'paddock doctor' answers against a missing socket without starting anything", () => {
  const r = runServer(["doctor"], { PADDOCK_HERDR_SOCKET: "/nonexistent/herdr.sock" });
  expect(r.code, "undetermined, not incompatible").toBe(2);
  expect(r.out + r.err).toContain("/nonexistent/herdr.sock");
  expect(r.out + r.err, "no port may be bound").not.toContain("listening");
});
