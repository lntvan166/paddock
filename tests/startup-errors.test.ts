import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  herdrUnreachableMessage,
  inspectSocketPath,
  portInUseMessage,
} from "@server/startup-errors";

// The two ways a first run fails, and what the operator is told about them.
//
// Both of these used to answer with a raw Bun stack trace — bundler frames,
// `syscall`, `errno`, and a `/$bunfs/root/paddock` path that exists nowhere on
// disk. That is the whole first impression of the tool for someone who just
// installed it and has not started herdr, or who already has a paddock running.
//
// These run the real entry point rather than unit-testing a formatter, because
// the defect was never in a message — it was that no code ran between the
// failure and the terminal.

const CONFIG = mkdtempSync(join(tmpdir(), "paddock-startup-"));

function runServer(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", "src/server/index.ts", ...args], {
    env: {
      ...process.env,
      PADDOCK_NO_UPDATE_CHECK: "1",
      PADDOCK_CONFIG_DIR: CONFIG,
      ...env,
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

/** The markers of an unhandled throw reaching the terminal. */
function expectNoRawTrace(text: string) {
  expect(text, "a bundled path must never reach the operator").not.toContain(
    "$bunfs",
  );
  expect(text, "raw errno detail must never reach the operator").not.toContain(
    "syscall",
  );
  expect(text, "a stack frame must never reach the operator").not.toContain(
    "    at ",
  );
}

test("a port already in use is explained, not thrown", () => {
  // Hold the port for real. Nothing about this test depends on WHAT holds it —
  // the operator's own foreground paddock is the common case, but so is any
  // unrelated process, and the message must not claim to know which.
  const held = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("held"),
  });
  const port = String(held.port);
  try {
    const r = runServer(["--demo"], { PADDOCK_PORT: port });

    expect(r.code, "a port conflict must exit non-zero").not.toBe(0);
    const said = r.err + r.out;
    expect(said, "the port the operator chose must be named").toContain(port);
    expect(said.toLowerCase(), "say what went wrong in words").toContain(
      "in use",
    );
    expect(said, "offer the way out").toContain("PADDOCK_PORT");
    expectNoRawTrace(said);
  } finally {
    held.stop(true);
  }
});

test("a missing herdr socket is explained, not thrown", () => {
  // The single most likely first run: paddock installed, herdr not started.
  const absent = join(CONFIG, "definitely-not-here.sock");
  const r = runServer([], { PADDOCK_HERDR_SOCKET: absent });

  expect(r.code, "no herdr means no dashboard — exit non-zero").not.toBe(0);
  const said = r.err + r.out;
  expect(
    said,
    "name the socket it looked for, so the guess is checkable",
  ).toContain(absent);
  expect(said, "name the thing that is missing").toContain("herdr");
  expect(said, "offer the escape hatch that needs no herdr").toContain(
    "--demo",
  );
  expectNoRawTrace(said);
});

test("a path that exists but is not a socket gets different advice", () => {
  // The reason this branch is decided by stat() and not by the connect error:
  // Bun reports ENOENT for a regular file too, so an errno-driven message told
  // this operator to "start herdr" when herdr was already running and the PATH
  // was wrong. Measured, then fixed.
  const notASocket = join(CONFIG, "regular-file.sock");
  writeFileSync(notASocket, "");
  const r = runServer([], { PADDOCK_HERDR_SOCKET: notASocket });

  expect(r.code).not.toBe(0);
  const said = r.err + r.out;
  expect(said, "name the path that failed").toContain(notASocket);
  expect(said, "say what is actually wrong with it").toContain("not a socket");
  expect(
    said,
    "do not send them to start a herdr that is already running",
  ).not.toContain("start herdr first");
  expectNoRawTrace(said);
});

// --- the pure parts, one case each -----------------------------------------

test("inspectSocketPath distinguishes absent from unreadable", () => {
  const enoent = () => {
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  const eacces = () => {
    throw Object.assign(new Error("nope"), { code: "EACCES" });
  };
  expect(inspectSocketPath("/nope", enoent as never)).toBe("missing");
  // EACCES means we could not look. Reporting that as "missing" would be a
  // guess dressed as a fact.
  expect(inspectSocketPath("/nope", eacces as never)).toBe("unreadable");
});

test("each socket path kind gets its own advice, and all keep the escape hatch", () => {
  const kinds = ["missing", "not-a-socket", "socket", "unreadable"] as const;
  const said = kinds.map((k) =>
    herdrUnreachableMessage("/p/herdr.sock", null, k),
  );

  for (const m of said) {
    expect(m, "every failure names the path").toContain("/p/herdr.sock");
    expect(m, "every failure offers demo mode").toContain("--demo");
  }
  expect(
    new Set(said.map((m) => m.split("\n")[0])).size,
    "each kind reads differently",
  ).toBe(4);
  expect(said[0]).toContain("start herdr first");
  expect(said[1]).toContain("not a socket");
});

test("the port message never guesses what holds the port", () => {
  const m = portInUseMessage(8787, "127.0.0.1");
  expect(m).toContain("8787");
  expect(m).toContain("PADDOCK_PORT=8788");
  // It is usually another paddock and it is just as legitimately not one.
  expect(m.toLowerCase()).not.toContain("another paddock");
});
