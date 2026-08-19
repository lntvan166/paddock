import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFile } from "@server/lifecycle/state";
import { freePort } from "./support/port";

/**
 * Process group and session id for a pid, from /proc — Linux only.
 *
 * Field order in `/proc/<pid>/stat` is fixed: pid, comm, state, ppid, pgrp,
 * session, ... and `comm` is parenthesised and may itself contain spaces, so
 * the split has to start after the LAST ')' rather than at the first space.
 */
function pgidSid(pid: number): { pgid: number; sid: number } | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // no /proc — macOS. The assertions below are skipped there.
  }
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // after[0] is `state`, so pgrp and session are at indexes 2 and 3.
  return { pgid: Number(after[2]), sid: Number(after[3]) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("a detached child genuinely outlives the parent that started it", async () => {
  // The property this whole command is named for, and until this test nothing
  // in the suite observed it. Two halves, and both are load-bearing:
  //
  //  1. The child is still alive and still SERVING after `paddock start` has
  //     exited. That is what README.md and docs/running-locally.md promise.
  //  2. The child is in its own session and process group. Without
  //     `detached: true` the child inherits the invoking shell's session, so a
  //     ctrl+c during start's own wait — or in some shell configurations the
  //     terminal closing — signals the instance the operator just asked for.
  //     `unref()` does not do this: it releases the parent's event loop and
  //     changes no process group at all.
  const cfg = await mkdtemp(join(tmpdir(), "paddock-detach-"));
  // 9060-9099 used to be picked here, and it overlaps common
  // developer-chosen `PADDOCK_PORT` values in the 9090 neighbourhood — this
  // very command run a second time, by hand, on the same box. A test that
  // fails because you are running the product it tests is a defect in the
  // test, not bad luck: the range only made the collision rare, not
  // impossible, which is why a dedicated stress run of dozens of iterations
  // could still land zero failures without proving the bug absent. Picked
  // from the 40000+ range instead: far from both paddock's own default
  // (8787) and the common 3000/5173/8000/8080/9090-style dev-server ports,
  // while still ephemeral-but-unassigned rather than a registered service
  // port.
  const port = freePort();
  const parent = Bun.spawn(["bun", "src/server/index.ts", "start", "--demo"], {
    env: {
      ...process.env,
      PADDOCK_PORT: String(port),
      PADDOCK_CONFIG_DIR: cfg,
      PADDOCK_NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let child = 0;
  try {
    const code = await parent.exited;
    // BOTH streams. `stderr` is piped, so anything written there is captured
    // and then thrown away unless it is read — and a startup diagnostic is
    // exactly the thing that goes to stderr. A failure on this branch could not
    // be identified because this message was built from stdout alone.
    const [out, err] = await Promise.all([
      new Response(parent.stdout).text(),
      new Response(parent.stderr).text(),
    ]);
    expect(code, `paddock start failed\n--- stdout ---\n${out}\n--- stderr ---\n${err}`).toBe(0);

    const s = JSON.parse(await readFile(stateFile(cfg), "utf8"));
    child = s.pid;
    expect(child, "the recorded pid is the parent's own — nothing was detached")
      .not.toBe(parent.pid);

    // The parent is gone (awaited above) and the child is not.
    expect(alive(child), "the detached child died with its parent").toBe(true);
    const health = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    expect(health.ok, "the surviving child is no longer serving").toBe(true);

    const ours = pgidSid(process.pid);
    const theirs = pgidSid(child);
    if (ours && theirs) {
      expect(theirs.sid, "the child is still in the test runner's session — setsid() never ran")
        .not.toBe(ours.sid);
      expect(theirs.pgid, "the child is still in the test runner's process group")
        .not.toBe(ours.pgid);
      // setsid() makes the new process both session leader and group leader.
      expect(theirs.sid).toBe(child);
      expect(theirs.pgid).toBe(child);
    }
  } finally {
    // A detached child outlives this test too, by construction — so the test
    // that proves it must be the thing that cleans it up.
    if (child !== 0 && alive(child)) {
      try {
        process.kill(child, "SIGTERM");
      } catch {
        // Already gone between the check and here: nothing to clean up.
      }
      for (let i = 0; i < 50 && alive(child); i++) await Bun.sleep(100);
    }
  }
}, 60_000);
