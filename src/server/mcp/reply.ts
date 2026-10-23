import { stripAnsi } from "@server/journal/text";

/**
 * How a bridge message is marked, and how its reply is found again.
 *
 * The tag is the whole anchoring mechanism: a wait finds THIS message in the
 * journal by it, so a client that comes back late still gets its reply, and a
 * message queued behind a running task is not "finished" by that task's end.
 */
export const REMOTE_PREFIX = (tag: string) => `[from remote #${tag}] `;

export function newTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

/** `toLines`'s speaker headers, matched on stripped lines. */
export const AGENT_HEADER_RE = /^agent( · \d{2}:\d{2})?$/;
const USER_HEADER_RE = /^you( · \d{2}:\d{2})?$/;

const marker = (tag: string) => `[from remote #${tag}]`;

export function hasTag(lines: readonly string[], tag: string): boolean {
  return lines.some((l) => stripAnsi(l).includes(marker(tag)));
}

/**
 * The agent's lines after the tagged user turn, ANSI stripped, up to the next
 * user turn. Null when the tag is absent or no agent header follows it yet.
 */
export function replyAfter(lines: readonly string[], tag: string): string[] | null {
  const plain = lines.map(stripAnsi);
  const at = plain.findIndex((l) => l.includes(marker(tag)));
  if (at === -1) return null;
  const header = plain.findIndex((l, i) => i > at && AGENT_HEADER_RE.test(l));
  if (header === -1) return null;
  const end = plain.findIndex((l, i) => i > header && USER_HEADER_RE.test(l));
  const out = plain.slice(header + 1, end === -1 ? undefined : end);
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
