// The downgrade guard for `make types`, kept apart from gen-herdr-types.ts so it
// is testable: that script spawns herdr and writes the contract at import time,
// which a test cannot import without regenerating the real file.
//
// Why this exists: `make types` rewrites src/shared/herdr-api.d.ts from whatever
// `herdr` happens to be on PATH, and nothing compared that against what is
// already committed. Run on a machine with an older herdr it lowered
// HERDR_PROTOCOL and shrank the generated status enums, reporting success — the
// contract silently narrowing to match the oldest herdr anyone ran it against.
// A protocol mismatch used to advise exactly that, which is how it stayed
// plausible.

export const ALLOW_DOWNGRADE_ENV = "HERDR_ALLOW_DOWNGRADE";

// Matches the line gen-herdr-types.ts emits. Anchored per-line so a mention of
// the constant in a comment cannot be mistaken for the declaration.
const COMMITTED_PROTOCOL = /^export const HERDR_PROTOCOL = (\d+) as const;$/m;

/** The protocol the generated file is currently committed at, if it says. */
export function parseCommittedProtocol(source: string): number | null {
  const match = source.match(COMMITTED_PROTOCOL);
  return match ? Number(match[1]) : null;
}

/**
 * The message to refuse regeneration with, or null when it is safe.
 *
 * A gate, not a wall: pinning to an older herdr deliberately stays possible, so
 * the refusal has to name the override rather than just say no.
 */
export function downgradeRefusal(
  schemaProtocol: number,
  committed: number | null,
  allowDowngrade: boolean,
): string | null {
  if (committed === null || allowDowngrade || schemaProtocol >= committed) return null;
  return [
    "make types: refusing to regenerate — the installed herdr is older than this checkout",
    `  herdr reports  ${schemaProtocol}`,
    `  committed      ${committed}`,
    "  regenerating would lower HERDR_PROTOCOL and shrink the generated status",
    "  enums, so paddock would stop understanding states this checkout already",
    "  handles — and it would report success while doing it. Upgrade herdr.",
    `  to pin to the older protocol on purpose: ${ALLOW_DOWNGRADE_ENV}=1 make types`,
  ].join("\n");
}
