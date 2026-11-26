/**
 * Where an attached image sits in a reply.
 *
 * The reply field marks an image with `[Image #N]` at the caret, N counting
 * the reply's attachments from 1: the label Claude Code itself gives an image
 * pasted into its input. Measured on a live Claude Code: a bracketed paste of
 * an image's path ALONE becomes `[Image #1]`, an attached image, while the
 * same path inside a sentence stays a path. So a reply is delivered as parts,
 * each image path pasted on its own between the words around it, and the
 * agent receives the image where the operator put it.
 *
 * Shared because the field writes the tokens and the server reads them.
 */

export type ReplyPart = { text: string } | { image: string };

const TOKEN = /\[Image #(\d+)\]/g;

export function imageToken(n: number): string {
  return `[Image #${n}]`;
}

/**
 * The reply as parts. A token naming an attachment becomes that image; any
 * other `[Image #N]` is left as the words it is. An attachment no token names
 * leads the reply, in order, which is where every image went before tokens.
 */
export function replyParts(text: string, images: string[]): ReplyPart[] {
  const used = new Set<number>();
  const parts: ReplyPart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const n = Number(m[1]);
    if (!(n >= 1 && n <= images.length)) continue;
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ image: images[n - 1]! });
    used.add(n);
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  const lead: ReplyPart[] = images
    .map((image, i) => ({ image, n: i + 1 }))
    .filter(({ n }) => !used.has(n))
    .map(({ image }) => ({ image }));
  return [...lead, ...parts].filter((p) => !("text" in p) || p.text !== "");
}

/**
 * The reply as one string, each image's path where its token was (unnamed
 * images first). For a backend that takes a single paste: the agent still
 * gets every path, in the place the operator put it, just as text.
 */
export function inlinePaths(text: string, images: string[]): string {
  return replyParts(text, images)
    .map((p) => ("image" in p ? p.image : p.text))
    .reduce((out, piece, i, all) => {
      // An unnamed image ahead of the words needs a space after it.
      const prev = all[i - 1];
      return out + (i > 0 && prev !== undefined && !/\s$/.test(out) && !/^\s/.test(piece) ? " " : "") + piece;
    }, "");
}

/**
 * The field after attachment `n` is removed: its token goes (with one space
 * beside it, so no double space is left), and every later token counts down
 * one, so `[Image #N]` keeps naming the N-th chip.
 */
export function dropImageToken(text: string, n: number): string {
  // One space survives between two words; none at either end of the field.
  const gone = text
    .replace(new RegExp(`(^|\\s)\\[Image #${n}\\](\\s|$)`, "g"), (_m, a: string, b: string) => (a && b ? b : ""))
    // A token typed hard against a word.
    .replace(new RegExp(`\\[Image #${n}\\]`, "g"), "");
  return gone.replace(TOKEN, (whole, m: string) => {
    const k = Number(m);
    return k > n ? imageToken(k - 1) : whole;
  });
}

/**
 * Put `[Image #n]` into `text` at `at`, spaced from the words either side.
 * Returns the new text and where the caret goes (just after the token).
 */
export function insertImageToken(text: string, at: number, n: number): { text: string; caret: number } {
  const i = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, i);
  const after = text.slice(i);
  const ins = (before !== "" && !/\s$/.test(before) ? " " : "") + imageToken(n) + (/^\s/.test(after) ? "" : " ");
  return { text: before + ins + after, caret: i + ins.length };
}
