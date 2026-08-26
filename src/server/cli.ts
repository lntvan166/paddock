/**
 * `serve`, `update`, `start`, `status` and `stop` are implemented and act.
 * `help` is implemented and only prints — it is the one command that must
 * answer without touching a socket or a port, since asking what the tool does
 * must never start it.
 * `agent` and `hub` are RESERVED — the multi-host shape in
 * docs/architecture.md names them, and exiting with a pointer to the roadmap
 * is better than either doing something half-working or silently serving a
 * dashboard under a name that promises something else. `unknown` is anything
 * else the operator typed.
 */
export type Command =
  | "serve" | "update" | "start" | "stop" | "status" | "doctor" | "tunnel"
  | "help" | "agent" | "hub"
  | "unknown";

export interface ParsedArgs {
  command: Command;
  flags: Set<string>;
  /** Values for the flags that take one, e.g. `--for` → `"2h"`. */
  values: Map<string, string>;
  /** The verb as typed, so an error can quote it back. Null for a bare run. */
  verb: string | null;
}

/** Reserved, and deliberately not implemented — see docs/roadmap.md. */
const RESERVED = new Set(["agent", "hub"]);

/** The only flags that consume the token after them. */
const VALUE_FLAGS = new Set(["--for"]);

export const USAGE = [
  "usage: paddock [--demo]          start the dashboard in the foreground",
  "       paddock start             start it detached; survives this terminal",
  "       paddock stop [--force]    stop the detached instance",
  "       paddock status            is it running?",
  "       paddock update [--check]  install the latest release",
  "       paddock doctor            can this paddock talk to your herdr?",
  "       paddock tunnel [--for D]  publish it on a quick tunnel, gated by a code",
  "       paddock tunnel --attach   publish the paddock already running here",
  "                                 D is 30m, 2h or 7d",
  "       paddock help | --help     print this",
  "       paddock --version | -V    print the version",
].join("\n");

/**
 * Argument handling was `new Set(Bun.argv.slice(2))`, which is fine for flags
 * and cannot express a verb carrying its own flag (`update --check`).
 *
 * Bare invocation serves. That is not an accident to be tidied up later: the
 * Docker CMD, the README, and every screenshot caption assume it, and a
 * distribution change that broke the documented invocation would defeat its
 * own purpose.
 *
 * An UNRECOGNISED verb is `unknown`, never `serve`. `paddock updte` used to
 * fall through and launch a server — on a branch whose whole purpose is
 * introducing verbs, that is the "never swallow errors" shape: the operator
 * asked for something that does not exist and got a dashboard.
 *
 * The reserved verbs come back through here too. index.ts used to scan raw
 * `Bun.argv` for them separately, which meant two argv mechanisms in one
 * function and two places for them to disagree — `paddock --demo agent` was
 * parsed as `serve` here and as `agent` there.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let verb: string | null = null;

  // A POSITIONAL scan, not two independent filters. The old
  // `argv.find(a => !a.startsWith("-"))` had no way to know that the token
  // after `--for` belongs to the flag, so `paddock --for 2h tunnel` read "2h"
  // as the verb.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) {
      verb ??= a;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const name = a.slice(0, eq);
      flags.add(name);
      values.set(name, a.slice(eq + 1));
      continue;
    }
    flags.add(a);
    if (VALUE_FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      values.set(a, argv[++i]!);
    }
  }

  const command = commandFor(verb);
  if (command === "serve" && (flags.has("--help") || flags.has("-h"))) {
    return { command: "help", flags, values, verb };
  }
  return { command, flags, values, verb };
}

function commandFor(verb: string | null): Command {
  if (verb === null) return "serve";
  if (verb === "serve" || verb === "update") return verb;
  if (verb === "start" || verb === "stop" || verb === "status") return verb;
  if (verb === "doctor") return "doctor";
  if (verb === "tunnel") return "tunnel";
  if (verb === "help") return "help";
  if (RESERVED.has(verb)) return verb as Command;
  return "unknown";
}

/**
 * `45s`, `90m`, `2h`, `2d`. Returns null for anything else — including `2`,
 * `2.5h` and `2h30m`.
 *
 * Null is a REFUSAL, not a default. `--for` exists to bound how long a public
 * URL lives; a typo that quietly became "no deadline" would defeat the only
 * reason to type the flag.
 *
 * `d` was added alongside the day-aware `duration()` formatter: a tunnel whose
 * remaining time reads `4d 4h` must be requestable in the same units it is
 * reported in. There is deliberately still no cap — `--for 400h` was uncapped
 * before this change, and introducing a limit here would be an unrelated
 * policy decision smuggled in behind a formatting fix.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(input);
  if (m === null) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}
