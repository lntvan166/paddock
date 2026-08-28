import type { AnsiSpan } from "@web/ansi";

/**
 * A span the terminal may render as a link.
 *
 * `path` present means the WHOLE span is the path, so the renderer wraps the
 * span or it does not — no substring arithmetic at render time, where it would
 * run on every line of every poll.
 */
export interface PathSpan extends AnsiSpan {
  path?: string;
}

/**
 * Path-shaped tokens, split out of already-styled spans.
 *
 * ANCHORED to the start of the span or to whitespace, which is the same rule
 * the slash-command trigger uses and guards the same regression: a slash inside
 * a word is not an address. So `src/web/api.ts`, `and/or` and
 * `http://example.com/x` stay prose, while `/srv/a.html` and `~/notes/a.md`
 * become links.
 *
 * Trailing punctuation is trimmed, because a sentence ends in a full stop and a
 * filename does not — "wrote /srv/a.html." names a file called `a.html`.
 *
 * Whether the file EXISTS is not checked. Deciding would cost a filesystem
 * round trip per token per poll, on a screen that polls while it is open, and
 * the viewer already says plainly when a path is not there.
 */

/**
 * `\S*` cannot span whitespace, so a match is exactly one token. The lookbehind
 * is what makes "after whitespace" the trigger rather than "contains a slash".
 */
const PATH_RE = /(?<=^|\s)(?:file:\/\/)?[~/]\S*/g;

/** Punctuation that ends a sentence rather than a filename. */
const TRAILING = /[.,;:!?)\]}>'"]+$/;

/**
 * Below this a token is punctuation, not an address: a bare `/` in "either / or"
 * and a bare `~` are not files, and neither is `/a`.
 */
const MIN_PATH_LEN = 3;

export function splitPaths(spans: readonly AnsiSpan[]): PathSpan[] {
  const out: PathSpan[] = [];

  for (const span of spans) {
    let last = 0;
    PATH_RE.lastIndex = 0;

    for (let m = PATH_RE.exec(span.text); m !== null; m = PATH_RE.exec(span.text)) {
      const token = m[0].replace(TRAILING, "");
      if (token.length < MIN_PATH_LEN) continue;

      if (m.index > last) out.push({ ...span, text: span.text.slice(last, m.index) });
      out.push({ ...span, text: token, path: token });
      last = m.index + token.length;
    }

    // Untouched when nothing matched: the common line has no path in it, and
    // returning the same object keeps that case free.
    if (last === 0) out.push(span);
    else if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }

  return out;
}
