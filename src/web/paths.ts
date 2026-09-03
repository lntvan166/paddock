import { isViewable } from "@shared/file-kinds";
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
 * `\S*` cannot span whitespace, so a match is exactly one token. Group 1 is the
 * boundary — start of span, or one whitespace character — and group 2 is the
 * token, which is what makes "after whitespace" the trigger rather than
 * "contains a slash".
 *
 * The token now includes RELATIVE shapes — anything with a slash in it — and
 * `linkable` below decides which of those is actually an address. It has to be
 * matched first and judged second: the regex cannot tell `docs/report.md` from
 * `and/or`, and only the extension can.
 *
 * A LOOKBEHIND said this more directly, and did: `(?<=^|\s)`. Safari had no
 * lookbehind until 16.4, and vite's `safari14` target does not save you —
 * esbuild rewrites the literal to `new RegExp("(?<=…)")`, which PARSES fine and
 * then throws `SyntaxError` at module evaluation, at the top level of the
 * bundle. React never mounts, and an empty `#root` paints an iframe's default
 * white. That was the white phone on the demo site, and this is the same bundle
 * an operator runs. tests/browser-support.test.ts reads the BUILT output for
 * it, because this suite runs on Bun's JavaScriptCore — the same engine family
 * as Safari, but current enough to accept everything Safari 15 refuses.
 *
 * The boundary is CONSUMED here where the lookbehind was zero-width, so the
 * token starts at `m.index + m[1].length` rather than at `m.index`.
 */
const PATH_RE = /(^|\s)((?:file:\/\/)?[~.]?[\w.~/-]*\/\S*|[~/]\S*)/g;

/** Punctuation that ends a sentence rather than a filename. */
const TRAILING = /[.,;:!?)\]}>'"]+$/;

/**
 * Is this token an address, or is it a word with a slash in it?
 *
 * ABSOLUTE shapes are addresses on sight — `/srv/a`, `~/notes`, `file:///x`.
 * There is nothing else they could be, so they link whatever their extension,
 * exactly as they always have.
 *
 * A RELATIVE token has no such tell. `and/or` and `docs/report.md` are the same
 * shape, and the only thing separating them is whether the last segment names
 * something the viewer can put on screen. So the extension decides, using the
 * same table the server uses to render it — a tap that resolves to a file save
 * is worse than no link, because the operator expected to read the thing.
 *
 * The consequence, stated because it surprises: `src/web/api.ts` does NOT link.
 * `.ts` is not a type the viewer renders, and this is the rule that keeps
 * `and/or` prose.
 */
function linkable(token: string): boolean {
  if (token.startsWith("file://")) return true;
  if (token.startsWith("/") || token.startsWith("~")) return true;
  // A scheme means a URL, and a URL is somebody else's file. `file://` is
  // already home above; everything else with an authority is not on this disk.
  if (token.includes("://")) return false;
  // A relative path has to actually be a path: a bare `report.md` in prose is
  // as often the name of a thing being discussed as it is an address.
  if (!token.includes("/")) return false;
  return isViewable(token);
}

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
      const start = m.index + m[1]!.length;
      const token = m[2]!.replace(TRAILING, "");
      if (token.length < MIN_PATH_LEN) continue;
      if (!linkable(token)) continue;

      if (start > last) out.push({ ...span, text: span.text.slice(last, start) });
      out.push({ ...span, text: token, path: token });
      last = start + token.length;
    }

    // Untouched when nothing matched: the common line has no path in it, and
    // returning the same object keeps that case free.
    if (last === 0) out.push(span);
    else if (last < span.text.length) out.push({ ...span, text: span.text.slice(last) });
  }

  return out;
}
