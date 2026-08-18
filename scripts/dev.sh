#!/usr/bin/env bash
# The iteration loop: the API server and the Vite dev server side by side,
# outside Docker on purpose — HMR through a bind mount is a reliable source of
# "why isn't my change showing".
#
# This exists as a script, rather than the one-liner it replaces, for one
# reason: when the API server dies, the loop has to stop and say so. The old
# form was
#
#   bun run dev:server & bun run dev:web; kill %1
#
# which backgrounds the server and waits on the WEB half. When the server died,
# nothing noticed. Vite kept serving the page, `make dev` kept printing HMR
# updates, and the dashboard loaded normally with every /api call failing — the
# shape of breakage that looks like a working app. One instance ran that way for
# about eleven hours. `kill %1` never fired, because it only runs once Vite
# exits, and Vite was the half still alive.
#
# So the fix is mostly to wait on the other half. The server runs in the
# FOREGROUND and Vite in the background, which makes the server's exit the thing
# that ends the script — no polling, no job-table inspection, no bash-version
# floor.
#
# The reverse case, Vite dying while the server lives, is deliberately not
# handled: it announces itself. The page stops loading at all, which nobody
# mistakes for a working dashboard. It was only ever the silent direction that
# needed a mechanism.
set -uo pipefail

cd "$(dirname "$0")/.."

# `*.log` is gitignored, which matters beyond tidiness: bun stack traces carry
# absolute paths, and check-private.sh scans tracked and untracked-but-not-
# ignored files. A log under a name the scanner walks would fail check-clean on
# the developer's own home directory.
#
# The log is the second half of the point. When the server died before, its
# stderr went to the terminal and vanished with it, and herdr's log records only
# outcome="stream_closed" for the subscription — which it also logs on every
# --watch reload, so a crash was indistinguishable from a routine restart.
LOG="dev-server.log"

bun run dev:web &
web=$!

# Appended, not truncated, and stamped per run. After a crash the question is
# what the server said on its way out, and that is in the PREVIOUS run's tail —
# truncating on start would erase the answer at the moment someone comes looking.
printf '\n=== dev:server started %s ===\n' "$(date -Is)" >> "$LOG"

# Terminal AND log, in the foreground. Process substitution rather than a pipe so
# that $? below is bun's own status; through a pipe it would be tee's.
#
# Deliberate tradeoff: bun no longer sees a TTY on stdout, so its output loses
# colour. A crash that can be read afterwards is worth more than coloured logs.
# Vite keeps the real terminal and is unaffected.
bun run dev:server > >(tee -a "$LOG") 2>&1
status=$?

# Ctrl-C needs no special case here, which is worth stating because the obvious
# guess is that it does. The terminal signals the whole foreground process group:
# bash takes SIGINT and dies at this point, Vite takes it too, and nothing below
# runs. Verified in a real pty — the whole output is "^C", with no stray message
# and no orphaned child.
#
# An earlier version treated status 130/143 as "stopped" for this reason. It was
# unreachable on the path it was written for, and the one case it COULD catch — a
# SIGTERM aimed at the server alone — is a death that deserves reporting, not a
# clean shutdown notice. So it is gone.
echo "dev: dev:server exited (status $status) — stopping dev:web." >&2
echo "dev: the API is what died; the UI would have kept serving without it." >&2

# Safe without a liveness check, and without silencing stderr: Vite is this
# script's own child and has not been waited on, so even if it has already
# exited its pid is still a zombie rather than a free number. `kill` on a zombie
# succeeds quietly, and the pid cannot have been recycled onto some other
# process in the meantime.
kill "$web"
wait "$web"

echo "dev: its last output, from $LOG:" >&2
tail -n 20 "$LOG" >&2

# The server exiting at all ends the dev loop, so this is a failure even when it
# exited 0. Reporting success would put us back where we started: `make dev`
# looking fine while the thing it exists to run is gone.
if [ "$status" -eq 0 ]; then
  exit 1
fi
exit "$status"
