/**
 * What is sitting unsent in Claude Code's input box, read off the screen.
 *
 * Shared because both sides need the same answer: the browser offers to pull
 * a desk draft into the reply field, and the server checks, right before it
 * clears that draft, that the screen still holds exactly what was pulled.
 *
 * MEASURED on a live Claude Code through herdr-core, one key at a time
 * (docs/gotchas.md, "A draft in Claude Code's input"; tests/core-draft-live.test.ts
 * executes it):
 *
 *  - The input sits between two rules of `─`. Its first line starts with
 *    `❯` and a NO-BREAK SPACE (U+00A0), each further line with two ordinary
 *    spaces. The no-break space looks like a space in every dump of the
 *    screen, including `JSON.stringify`; a parser that looked for `❯ ` read
 *    every real box as unknown while passing every hand-written fixture.
 *  - An EMPTY input shows a suggestion ("Try …") drawn entirely in SGR 2
 *    (dim). Read as plain text it is indistinguishable from a typed draft,
 *    which is why this reads the ANSI screen and never the plain one.
 *  - A typed draft carries NO SGR at all.
 *  - A paste collapses to `[Pasted text #1 +11 lines]`, as plain text. Its
 *    content is not on the screen, so pulling it would pull the label and
 *    clearing the draft would destroy the paste. Same for `[Image #1]`.
 *
 * Anything outside that shape is `unknown`, and `unknown` never offers a
 * merge: a guessed draft is the same failure as a guessed keystroke.
 */

export type DraftRead =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

const RULE = /^─{3,}\s*$/;
// Every escape the line holds. Only SGR is expected; anything else is unknown.
const ESCAPE = /\x1b\[([0-9;]*)([A-Za-z])/g;
const CHIP = /\[(Pasted text|Image) #\d+/;
/** `❯` and the space after it: U+00A0 measured, an ordinary space accepted. */
const MARK = /^❯[ \u00a0]/;

function plain(line: string): string {
  return line.replace(ESCAPE, "");
}

/**
 * Split a line into its text and whether that text was dim. Null when it
 * holds any escape other than reset (`0` or empty) and dim (`2`).
 */
function segments(line: string): { text: string; dim: boolean }[] | null {
  const out: { text: string; dim: boolean }[] = [];
  let dim = false;
  let at = 0;
  for (const m of line.matchAll(ESCAPE)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index), dim });
    at = m.index! + m[0].length;
    if (m[2] !== "m") return null;
    for (const code of (m[1] || "0").split(";")) {
      if (code === "0" || code === "") dim = false;
      else if (code === "2") dim = true;
      else return null;
    }
  }
  if (at < line.length) out.push({ text: line.slice(at), dim });
  return out;
}

export function readClaudeDraft(screen: string[]): DraftRead {
  // The LAST `❯` line that sits directly under a rule: the input box is the
  // bottom-most such structure, and a `❯` higher up is transcript.
  let start = -1;
  for (let i = screen.length - 1; i > 0; i--) {
    if (MARK.test(plain(screen[i]!)) && RULE.test(plain(screen[i - 1]!).trim())) { start = i; break; }
  }
  if (start === -1) return { kind: "unknown" };
  let end = start + 1;
  while (end < screen.length && !RULE.test(plain(screen[end]!).trim())) end++;
  if (end >= screen.length) return { kind: "unknown" }; // no closing rule

  const lines: string[] = [];
  let anyDim = false;
  let anyPlain = false;
  for (let i = start; i < end; i++) {
    const segs = segments(screen[i]!);
    if (!segs) return { kind: "unknown" };
    let text = segs.map((s) => s.text).join("");
    // An empty continuation line is a blank line in the draft.
    const prefixed = i === start ? MARK.test(text) : text.startsWith("  ");
    if (text.trim() !== "" && !prefixed) return { kind: "unknown" };
    text = text.slice(2);
    for (const s of segs) {
      if (s.text.replace(i === start ? "❯" : "", "").trim() === "") continue;
      if (s.dim) anyDim = true; else anyPlain = true;
    }
    lines.push(text.trimEnd());
  }
  // A dim suggestion beside typed text is not a shape that was measured.
  if (anyDim && anyPlain) return { kind: "unknown" };
  if (!anyPlain) return { kind: "empty" };
  const text = lines.join("\n").replace(/\n+$/, "");
  if (CHIP.test(text)) return { kind: "unknown" };
  return { kind: "text", text };
}

/** Two reads of one draft agree, ignoring what a screen cannot show: trailing
 *  spaces on a line and trailing blank lines. */
export function sameDraft(a: string, b: string): boolean {
  const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
  return norm(a) === norm(b);
}
