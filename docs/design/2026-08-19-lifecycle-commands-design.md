# `paddock start` / `stop` / `status` — design

**Status:** approved, not yet implemented.
**Extends** `docs/design/2026-08-18-distribution-and-update-design.md`.

## Goal

Let paddock outlive the terminal that started it, and let the operator stop it
again without hunting for a PID.

```bash
paddock start     # detached; survives closing the terminal
paddock stop
paddock status
```

That is the real requirement hiding behind "add a stop command": a dashboard
you check from your phone is useless if it dies when you close the laptop lid
on the terminal you launched it from. Today `paddock` is foreground-only, and
`ctrl+c` is the whole story.

## Why not the two obvious alternatives

**Not a shutdown endpoint.** herdr's sibling command, `herdr server stop`,
finds its server through the API socket it already listens on. paddock's
equivalent is its HTTP port — and paddock has **no authentication of its own**.
A shutdown route would add "kill the dashboard" to the list of things anyone
reaching that port can do, including anyone past the Cloudflare Access policy
in front of it. It is strictly less harmful than the keystroke access they
would already have, and it is still avoidable, so we avoid it.

It is also less correct. `PADDOCK_PORT` is configurable, so the port is not a
stable identity: if the port is occupied by **something that is not paddock**,
a port-based `stop` sends a shutdown request to a stranger. A PID file cannot
make that mistake — it reports that paddock is not running, and stops.

**Not systemd or launchd.** They do restart-on-boot and log rotation properly,
and they would be the right answer for a server. They are the wrong answer for
a tool a developer runs beside herdr on a laptop: two platform-specific unit
files, an install step, and `stop` becomes `systemctl --user stop paddock`,
which is no longer paddock's own vocabulary. Revisit if anyone asks to run
paddock on a always-on box.

## What was measured

Three facts established by probe, because each one shapes the design:

- **A Bun child survives its parent.** `Bun.spawn` with detached stdio, then
  the parent exiting, leaves the child running and reparented to a subreaper.
  So `paddock start` needs no external helper.
- **`comm` is not a reliable identity.** The compiled binary reports
  `comm=paddock`, but a dev run reports `comm=bun` — the script name never
  appears. Verification must use the full argument string, which carries the
  identifying information in both cases.
- **`ps -p <pid> -o args=` is NOT portable enough on its own.** It works on a
  normal Linux box and on macOS, and it fails in the image this project ships:
  `oven/bun:1-alpine` has busybox `ps`, which supports neither `-p` nor a
  selectable `args` column. `ps -p 1 -o args=` there exits 1 with a usage
  message. Relying on it alone would have made `stop` refuse *every* time
  inside Docker, because the identity string would be empty at both ends and
  the mismatch branch would fire.
- **`/proc/<pid>/cmdline` is the answer on Linux, and matches `ps` exactly.**
  Measured on the same compiled binary: `/proc` gave
  `"./bin/probe start --demo"` and `ps` gave `"./bin/probe start --demo"` —
  byte-identical. It is readable inside `oven/bun:1-alpine`, needs no
  subprocess, and does not exist on macOS. So identity is read from `/proc`
  when it is there and from `ps` when it is not.
- **That string cannot be reconstructed from inside the process.** Measured on
  a compiled binary invoked as `./bin/probe start --demo`: `ps` reports
  `"./bin/probe start --demo"` — the invocation *as typed*, relative path and
  all — while `Bun.argv` reports `["bun", "/$bunfs/root/probe", "start",
  "--demo"]` and `process.execPath` reports the resolved absolute path. No
  combination of the two yields what `ps` will later say.

  So the running process must capture **its own** `ps -p $$ -o args=` at
  startup and store that. `stop` then compares like with like: the same command
  asked about the same PID, once at start and once at stop. Building the string
  from `Bun.argv` would produce a value that never matches, and the identity
  check would reject every legitimate stop.

## Command surface

| Command | Behaviour |
|---|---|
| `paddock` | Foreground, unchanged. `ctrl+c` stops it. |
| `paddock start` | Spawns a detached copy, waits for it to bind, prints the port. |
| `paddock stop` | Signals the running instance and waits for it to exit. |
| `paddock stop --force` | `SIGKILL` after `SIGTERM` did not work. Never automatic. |
| `paddock status` | Reports running or not. Exit `0` running, `1` not. |

The exit code on `status` is deliberate: it is what makes the command usable
from a shell script, which is the only reason a `status` subcommand is worth
more than `ps`.

## The state file

`$PADDOCK_CONFIG_DIR/paddock.state.json`, defaulting to
`~/.config/paddock/paddock.state.json` — beside `settings.json` and
`update-check.json`.

**Not `paddock.pid`.** A `.pid` file is a well-established convention meaning
"one integer and nothing else"; anything that reads one — an init script, a
monitoring check, a colleague with `cat` — would get JSON and mis-parse it. The
name should say what the file is.

Putting it in the config directory gives **per-instance isolation for free**:
two paddocks with different `PADDOCK_CONFIG_DIR` values have separate state
files and do not fight, which matters because `PADDOCK_PORT` already makes two
instances possible.

It is JSON, not a bare PID, because a bare PID cannot be verified:

```json
{ "pid": 12345, "args": "paddock start", "port": 8787,
  "version": "0.4.0", "startedAt": 1787000000000 }
```

`args` is whatever `ps` said about this process at startup, verbatim — see the
measurement above. It is not derived from `Bun.argv`, and its exact form
depends on how the operator invoked paddock, which is precisely why it
identifies the process.

Written `0600` by the same atomic tmp-then-rename path `settings.json` uses.

**Every running paddock writes it, foreground or detached**, so `status` and
`stop` work regardless of how it was started. It is written only *after* the
port is successfully bound — a paddock that failed to bind must not clobber the
state of the one already holding the port — and removed on clean exit.

## The stale-PID hazard

This is the failure that makes a naive PID file dangerous, and the reason the
file holds more than a number.

A process exits without cleaning up — `SIGKILL`, a power cut — and the kernel
later recycles its PID for something unrelated. `paddock stop` then reads a PID
that is alive, and kills a stranger.

So `stop` and `status` both verify in three steps, and **refuse rather than
guess**:

1. **No state file** → not running. Exit cleanly.
2. **PID not alive** (`kill(pid, 0)` → `ESRCH`) → stale file. Remove it, report
   not running. This is the ordinary case after a crash.
3. **PID alive, but `ps -p <pid> -o args=` does not match the recorded
   `args`** → *something else now owns this PID*. **Do not signal it.** Report
   the PID and the command actually running there, and remove the state file
   so the next call is clean.

Only a PID that is alive *and* matches is signalled. The residual risk is two
identical paddock invocations racing for one PID number, which requires PID
recycling to land on a process with a byte-identical command line — accepted,
and recorded here rather than hidden.

## `start`

Spawn a detached child with the same executable and environment, stdio
redirected to `$PADDOCK_CONFIG_DIR/paddock.log`, then **wait for the child to
bind before reporting success**.

Waiting means polling for two things, not one: the state file appearing, *and*
`GET /api/health` on the recorded port answering. The file alone proves the
child got far enough to write it; the health check proves it is actually
serving. Poll every 100 ms up to 10 seconds, and treat the child exiting early
as an immediate failure rather than waiting out the timeout.

Reporting success and letting the operator discover a port conflict later is
the failure mode this command exists to avoid.

- Already running → refuse, naming the PID. Do not start a second.
- Child exits before binding → print the tail of the log and exit non-zero.
  A silent failed start is worse than no command.
- The log is **truncated on each start**, not appended. Unbounded growth with
  no rotation is a slow bug; one run's output is the useful scope, and anyone
  who needs more should run in the foreground or use a service manager.

## `stop`

`SIGTERM`, then poll for exit up to 10 seconds.

- Exited → report it and remove the state file.
- Still alive after 10s → report that, and say `paddock stop --force` sends
  `SIGKILL`. **Never escalate automatically.** `settings.json` is written
  atomically so a kill cannot corrupt it, but the operator should choose to
  kill a process that is refusing to leave rather than have it done silently.

## `status`

```
paddock 0.4.0 — running (pid 12345, port 8787, up 2h 14m)
paddock — not running
```

When the state file is stale, say so rather than reporting "not running" as if
nothing had happened: a crash left evidence and it is worth surfacing once.

## Failure modes

| Condition | Behaviour |
|---|---|
| `stop` with no state file | "not running", exit 0 |
| `stop` with a dead PID | Remove the file, "not running", exit 0 |
| `stop` where the PID is now someone else | **Refuse to signal.** Name the PID and its real command, remove the file, exit non-zero |
| `stop` and it will not die | Report, suggest `--force`, exit non-zero |
| `start` when already running | Refuse, name the PID, exit non-zero |
| `start` and the child never binds | Tail of the log, exit non-zero |
| `start` where the config dir is unwritable | Refuse before spawning, exit non-zero |
| `status` while running | Details, exit 0 |
| `status` not running | "not running", exit 1 |

## Testing

- A state file is written after bind and removed on clean exit.
- `stop` on a **dead** PID removes the file and reports not running.
- **`stop` on a recycled PID does not signal it** — the most important test
  here. Write a state file naming a live process whose `args` do not match, and
  assert nothing is signalled and the exit code is non-zero.
- `start` twice refuses the second.
- `start` whose child never binds exits non-zero and surfaces the log.
- `status` exit codes: `0` running, `1` not.
- A detached child genuinely outlives its parent — the probe above, as a test.

Each is to be broken deliberately and watched fail before it is trusted; the
recycled-PID one especially, since the code path it guards is the one that
signals another user's process.

## Decisions recorded

1. **PID file, not a shutdown endpoint** — paddock has no auth, and the port is
   not a stable identity.
2. **State in `$PADDOCK_CONFIG_DIR`** — per-instance isolation for free.
3. **JSON with `args`, not a bare PID** — a bare PID cannot be verified, and
   `comm` was measured to be `bun` for a dev run.
4. **Refuse rather than guess** on any mismatch.
5. **No automatic `SIGKILL`.**
6. **Foreground runs write the state file too**, so `status` and `stop` do not
   depend on how paddock was started.
7. **Log truncated per start** — rotation is a service manager's job.
