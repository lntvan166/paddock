export type Command = "serve" | "update";

/**
 * Argument handling was `new Set(Bun.argv.slice(2))`, which is fine for flags
 * and cannot express a verb carrying its own flag (`update --check`).
 *
 * Bare invocation serves. That is not an accident to be tidied up later: the
 * Docker CMD, the README, and every screenshot caption assume it, and a
 * distribution change that broke the documented invocation would defeat its
 * own purpose.
 */
export function parseArgs(argv: string[]): { command: Command; flags: Set<string> } {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const verb = argv.find((a) => !a.startsWith("-"));
  return { command: verb === "update" ? "update" : "serve", flags };
}
