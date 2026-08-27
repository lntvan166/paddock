import type { AgentCommand } from "@shared/types";

/**
 * The reply field's command autocomplete: when it is open, and what it offers.
 *
 * Both functions are pure and live on the CLIENT deliberately. The list for one
 * agent is small — a project declares a handful of commands, not hundreds — so
 * it is fetched once when the sheet opens and filtered locally. A round trip
 * per keystroke would put the network between a thumb and a list on exactly the
 * connection paddock exists to work over.
 */

/**
 * The token being typed at the caret, when it is a command.
 *
 * TRIGGERS ANYWHERE IN THE FIELD, not only at the start — `please run /ch` is
 * as much a command as `/ch`. The rule that keeps that from firing on ordinary
 * prose is the one `@`-mentions use everywhere: the slash must sit at the start
 * of the field or immediately after whitespace. So `src/web`, `a/b` and
 * `http://example.com` open nothing, because their slashes are inside a word.
 *
 * This replaced a stricter rule — the field's whole value had to begin with a
 * slash. It was wrong for the way people actually write to an agent: the
 * command is often the second half of a sentence.
 *
 * SCOPED TO THE CARET, so editing mid-line searches the token being edited
 * rather than the end of the line. `caret` defaults to the end of the value,
 * which is where typing puts it.
 *
 * A completed command plus a space yields null, because the token after the
 * space is empty: the name is settled and an argument is being written, and
 * continuing to filter would fight the operator for their own field.
 */
export function commandQuery(value: string, caret: number = value.length): string | null {
  const token = tokenAt(value, caret);
  return token.text.startsWith("/") ? token.text.slice(1) : null;
}

/**
 * The whitespace-delimited run ending at the caret, and where it starts.
 *
 * `\S*` cannot span whitespace, so the match is exactly one token; anchoring
 * on `^|\s` is what makes "after whitespace" the trigger rather than "contains
 * a slash".
 */
function tokenAt(value: string, caret: number): { text: string; start: number } {
  const end = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, end);
  const text = /(?:^|\s)(\S*)$/.exec(before)?.[1] ?? "";
  return { text, start: end - text.length };
}

/**
 * The field after picking a command: the typed token replaced, everything else
 * left alone.
 *
 * Splicing rather than assigning is what makes a mid-sentence command work.
 * Replacing the whole value would delete the words already written around it —
 * which is exactly what this did before the trigger moved off the start of the
 * field, and would have been a silent regression once it did.
 *
 * The trailing space is load-bearing twice: it is where an argument goes, and
 * it closes the list, because the token after a space is no longer a command.
 */
export function replaceCommandToken(
  value: string,
  caret: number,
  command: string,
): { value: string; caret: number } {
  const end = Math.max(0, Math.min(caret, value.length));
  const { start } = tokenAt(value, end);
  const inserted = `${command} `;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    caret: start + inserted.length,
  };
}

/** Where a term was found. Lower sorts first. */
const enum Tier {
  NamePrefix = 0,
  NameAnywhere = 1,
  Description = 2,
  NoMatch = 3,
}

function tierFor(entry: AgentCommand, term: string): Tier {
  // Compared without the slash, so typing `ch` matches `/check`. Nobody types
  // the slash twice.
  const name = entry.command.replace(/^\//, "").toLowerCase();
  if (name.startsWith(term)) return Tier.NamePrefix;
  if (name.includes(term)) return Tier.NameAnywhere;
  if ((entry.description ?? "").toLowerCase().includes(term)) return Tier.Description;
  return Tier.NoMatch;
}

/**
 * The commands a term offers, best first.
 *
 * Ranked rather than merely filtered: on a phone the first row is the one a
 * thumb reaches without reading, so a name that STARTS with the term has to
 * come before one that merely contains it, and both before a description-only
 * match.
 *
 * A term that matches nothing offers nothing. Falling back to the full list
 * would look like the filter was ignored and would put an unrelated command
 * under the thumb — worse than an empty list, which at least says so.
 */
export function filterCommands(
  all: readonly AgentCommand[],
  term: string,
): AgentCommand[] {
  const needle = term.toLowerCase();
  if (needle === "") return [...all];

  return all
    // The index keeps the sort stable: within one tier the project's own
    // order survives, rather than being reshuffled by the sort's internals.
    .map((entry, index) => ({ entry, index, tier: tierFor(entry, needle) }))
    .filter((r) => r.tier !== Tier.NoMatch)
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((r) => r.entry);
}
