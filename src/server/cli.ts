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
  | "serve" | "update" | "start" | "stop" | "status" | "help" | "agent" | "hub" | "unknown";

export interface ParsedArgs {
  command: Command;
  flags: Set<string>;
  /** The verb as typed, so an error can quote it back. Null for a bare run. */
  verb: string | null;
}

/** Reserved, and deliberately not implemented — see docs/roadmap.md. */
const RESERVED = new Set(["agent", "hub"]);

export const USAGE = [
  "usage: paddock [--demo]          start the dashboard in the foreground",
  "       paddock start             start it detached; survives this terminal",
  "       paddock stop [--force]    stop the detached instance",
  "       paddock status            is it running?",
  "       paddock update [--check]  install the latest release",
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
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const verb = argv.find((a) => !a.startsWith("-")) ?? null;
  const command = commandFor(verb);

  // `--help` and `-h` ask exactly what the `help` verb asks, and they were the
  // sharp edge here: both start with "-", so `verb` was null, so commandFor
  // returned "serve" and `paddock --help` opened a herdr socket and served a
  // live dashboard while printing nothing about usage. The most standard way
  // to ask a CLI what it does silently started a server that can send
  // keystrokes to the operator's agents.
  //
  // Only where the command would otherwise be `serve`: `paddock updte --help`
  // stays `unknown`, the same rule --version already follows. The operator
  // asked for a command that does not exist, and answering a different
  // question pretends the typo was understood.
  if (command === "serve" && (flags.has("--help") || flags.has("-h"))) {
    return { command: "help", flags, verb };
  }
  return { command, flags, verb };
}

function commandFor(verb: string | null): Command {
  if (verb === null) return "serve";
  if (verb === "serve" || verb === "update") return verb;
  if (verb === "start" || verb === "stop" || verb === "status") return verb;
  if (verb === "help") return "help";
  if (RESERVED.has(verb)) return verb as Command;
  return "unknown";
}
