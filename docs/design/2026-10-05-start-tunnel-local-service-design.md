# `start` publishes, `local` survives a reboot

Status: approved design, 2026-10-05. Reverses one paragraph of
`2026-08-19-lifecycle-commands-design.md` ("Not systemd or launchd") — that
paragraph ended "Revisit if anyone asks to run paddock on an always-on box",
and this is that ask.

## Why

The operator reaches paddock from a phone through a **named** Cloudflare
tunnel that runs on its own and points at port 8787. After a machine restart
nothing brings paddock back, so the phone gets an error page until someone sits
down at the machine and types `paddock start`. And `paddock start` — the verb
people reach for first — starts the one shape that is useless away from the
desk: a localhost-only instance.

Success is:

- `paddock start` gives a phone-reachable dashboard (a detached quick tunnel).
- `paddock local` gives a localhost dashboard that comes back by itself after
  a reboot, so the named tunnel in front of it works again without a login.
- `paddock stop` leaves nothing behind that comes back at boot.

## Command surface

| Command | Behaviour |
|---|---|
| `paddock` | Unchanged: foreground serve. The Docker CMD, and what the service unit runs. |
| `paddock start [--for D]` | Detached quick tunnel — today's `tunnel --detach`. If a paddock already answers on the port, it publishes that one (today's `--publish-running`), automatically. |
| `paddock tunnel …` | Unchanged, every flag kept, including `--detach`. |
| `paddock local` | **New.** Register paddock as a user service, start it, enable start-at-boot, wait until `/api/health` answers. Re-running repairs/refreshes the unit (idempotent). |
| `paddock stop [--force]` | Closes the tunnel, then stops the paddock; if it is a service, stops **and unregisters** it. |
| `paddock status` | Adds a service line: `systemd, starts at boot` / `launchd, starts at login` / not registered. |

Binding does not change: paddock already binds loopback by default
(`src/server/index.ts`, `PADDOCK_HOST`). "local" names how it is supervised,
not a new bind.

The old meaning of `start` is **removed, not aliased**. Someone typing
`paddock start` expecting a localhost instance now gets a public URL; that is
the requested change, so `USAGE`, the README and the release notes say so
plainly, and `start` prints the URL and pairing code as `tunnel --detach` does
today — nobody gets a public URL they did not see.

## The service module

New directory `src/server/lifecycle/service/`. The rest of paddock sees one
interface:

```ts
export interface ServiceManager {
  kind: "systemd" | "launchd";
  /** What `local` and `status` report. Never claimed beyond what was achieved. */
  startsAt(): Promise<"boot" | "login">;
  /** Write the unit, enable it, start it. Idempotent. */
  install(spec: ServiceSpec): Promise<void>;
  /** Stop, disable, remove the unit file. Idempotent. */
  uninstall(): Promise<void>;
  inspect(): Promise<"absent" | "registered" | "active">;
}

export interface ServiceSpec {
  argv: string[];               // childCommand() with no verb
  env: Record<string, string>;  // snapshot, see below
  logFile: string;              // launchd only; systemd uses the journal
}
```

`serviceManager(platform, run)` selects the implementation from
`process.platform`. Every shell-out goes through one injected `run` so tests
assert exact commands and file contents without touching a real service
manager.

**Refusal, never a silent fallback.** On an unsupported platform, or when
`systemctl --user` has no user bus (the Docker image, some SSH sessions),
`paddock local` refuses and names the reason. It does not quietly fall back to
a detached process that will not survive a reboot — that would be the
mislabelled control CLAUDE.md bans.

### What the unit runs

`childCommand()` (`src/server/lifecycle/commands.ts`) with no verb: this exact
build, in the foreground. `docs/running-locally.md` already says that is the
right thing to point a unit at — systemd's `Type=simple` tracks it directly.

### Environment snapshot

A service starts with a stripped environment and could not find the herdr
socket or bun. `local` snapshots, at install time: `PATH`, `HOME`, every
`HERDR_*` and every `PADDOCK_*` variable, and sets `PADDOCK_SERVICE=<kind>`.
It prints the names (not values) of what it captured, so a later "it can't find
herdr" has an obvious first place to look. Re-running `local` refreshes the
snapshot.

### systemd (Linux)

- File: `~/.config/systemd/user/paddock.service` (`$XDG_CONFIG_HOME` honoured).
- `Type=simple`, `Restart=always`, `RestartSec=10`, `WantedBy=default.target`.
- `systemctl --user daemon-reload`, then `systemctl --user enable --now paddock`.
- `loginctl enable-linger` so the user manager starts at boot without a login.
  If that is refused (polkit/sudo on some distros), `local` still succeeds and
  reports `starts at login, not boot — run: sudo loginctl enable-linger $USER`.
  `startsAt()` reads `loginctl show-user --property=Linger` rather than
  remembering what was attempted.
- Logs: the journal. `status` and `local` point at
  `journalctl --user -u paddock`.

### launchd (macOS)

- File: `~/Library/LaunchAgents/paddock.plist`, label `paddock`.
- `RunAtLoad`, `KeepAlive`, `StandardOutPath`/`StandardErrorPath` to the
  existing `paddock.log` in the config dir.
- `launchctl bootstrap gui/$UID <plist>`; removal `launchctl bootout
  gui/$UID/paddock`.
- `startsAt()` is always `"login"` — a LaunchAgent cannot start before login,
  and `local` says so.

### Public-repo rule

Templates contain no paths, usernames or hostnames; every path is computed at
install time from `$HOME`/`$XDG_CONFIG_HOME`. Tests use invented values
(`/path/to/home`, `operator`).

## Integration with stop, status and start

- **Recording.** When `PADDOCK_SERVICE` is set, `recordState` adds
  `managedBy: "systemd" | "launchd"` to `paddock.state.json`. Optional field;
  older records still parse.
- **`stop`.** Closes the tunnel first (unchanged). Then, if the record says
  `managedBy` OR `inspect()` reports the unit registered, it calls
  `uninstall()` instead of signalling — a SIGTERM to a supervised process is
  the race where it comes back right after `stop` reported it gone. It then
  waits for the port to go quiet and reports `stopped, and removed from boot`.
  A unit registered but not running (crash-looping while herdr is down) is
  uninstalled too. `--force` keeps its meaning for an unmanaged instance.
- **`status`.** Adds the service line from `inspect()` + `startsAt()`. The
  exit-code contract (0 running, 1 not) is unchanged.
- **`start`.** If a paddock answers on the port (via the existing
  `httpListener`), run the detached tunnel with `publishRunning: true`.
  Otherwise run today's `runDetach`, which serves its own paddock — so `start`
  is useful without `local`. An untracked paddock on the port is refused as
  today.
- **`local` with a non-service paddock already running** (a foreground run, an
  old detached instance): refuse with "stop it first". Two paddocks contending
  for 8787 is a known way to make a working build look broken.

## Known gap, accepted

After a reboot herdr is usually not running until the operator logs in and
starts it. paddock's herdr wait is bounded (`src/server/herdr/await-start.ts`),
so the service exits and systemd/launchd restarts it every ~10s; the phone sees
the tunnel's 502 until herdr appears, then everything connects on its own. A
"herdr is not running" screen served by paddock instead is a separate change to
startup and goes on the roadmap, not into this work.

## Testing

- **Service managers:** for each, against an injected runner — exact unit /
  plist text, exact command sequence for install / uninstall / inspect, linger
  refused → `startsAt` `"login"` and the message, no user bus → refusal,
  idempotent re-install.
- **CLI:** `parseArgs` for `local`; `USAGE` text; `start` maps to the detached
  tunnel.
- **Lifecycle:** `stop` on a `managedBy` record calls `uninstall` and sends no
  signal; `stop` on a registered-but-dead unit still uninstalls; `start` with a
  listener present passes `publishRunning`; `local` refuses beside an
  unmanaged instance; `status` prints the service line.
- No automated test touches a real service manager.
- **Manual check from a used state**, per CLAUDE.md: `paddock local` →
  `systemctl --user restart paddock` and a real reboot → `paddock start`
  (publishes the running one) → `paddock stop` → confirm
  `systemctl --user list-unit-files paddock.service` is empty and
  `paddock status` reports nothing registered.

## Docs

- `USAGE` in `src/server/cli.ts`, `README.md`, `docs/running-locally.md`
  (replace the "do not point a unit at `start`" section).
- `docs/decisions.md`: decision 33 — paddock manages a user service, reversing
  the lifecycle design's "Not systemd or launchd", with the named-tunnel reason.
- `docs/roadmap.md`: the herdr-down screen.
