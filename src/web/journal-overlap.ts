/**
 * Cutting the part of a journal page that is already on screen.
 *
 * `emptyJournal()` opens with `cursor: null`, and the reader reads a null
 * cursor as "from the end of the file" (`src/server/journal/read.ts`) — so the
 * FIRST page of "Show earlier" is the newest turns, which are exactly the ones
 * the live viewport is showing. Prepending them put the same passage on screen
 * twice. Every later tap carries a cursor and is genuinely older; only the
 * first one is unbounded, and this is its bound.
 *
 * WHY NOT COMPARE LINES. The journal serves the harness's stored MARKDOWN, the
 * viewport shows the harness's RENDERING of that same text, and the viewport
 * wraps to its own width. One message is therefore a different string on each
 * path: an exact line match reported ZERO duplicates against a screen visibly
 * full of them. So both sides are flattened — ANSI out, markdown punctuation
 * out, whitespace collapsed, wrapping dissolved by joining — and compared as
 * running text.
 *
 * Pure, and deliberately free of React and the DOM, like `history.ts` beside
 * it: this is the piece most likely to need tuning against another harness's
 * transcript format, and that tuning should be a change to one file with tests.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Markdown the journal keeps and the harness's renderer has already spent. */
const MARKUP_RE = /[*`_~#>]/g;

/**
 * Words a line needs before its presence on screen can mean anything.
 *
 * Six consecutive words do not recur by accident in prose. Below that they do:
 * "Done.", a timestamp, a bare path, a spinner frame — all of which appear on
 * both sides constantly, and any of which would otherwise trim away the real
 * history above it. Short lines are carried but never counted, so a blank line
 * or a `agent · 17:45` stamp inside a duplicated run does not end the run.
 */
const MIN_WORDS = 6;

function flatten(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(MARKUP_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The whole screen as one line of running text.
 *
 * Joined rather than compared line by line, because the viewport's line breaks
 * are its own wrapping and carry no meaning — the journal's copy of the same
 * sentence has different ones, or none.
 */
function runningText(lines: string[]): string {
  return lines.map((l) => flatten(l)).filter((l) => l !== "").join(" ");
}

/**
 * Unmatched lines tolerated between two matched ones before the run is over.
 *
 * The duplicated region is NOT a solid run of matches, and assuming it was is
 * what made the first version of this function trim nothing at all. The journal
 * writes a tool call as `▸ Bash · <description>`; the viewport renders tool
 * calls another way entirely, so those lines match NOTHING on screen even while
 * the prose either side of them matches perfectly. Measured against a live
 * session, one page's tail read MATCH / miss / MATCH / miss miss / MATCH, and a
 * walk that stopped at the first miss stopped on line two.
 *
 * Three absorbs the runs that were actually there while still ending the walk
 * at a real boundary, where misses do not stop.
 */
const MAX_MISSES = 3;

/**
 * Drop the tail of `page` that is already visible in `screen`.
 *
 * Walks back from the newest line and cuts at the OLDEST line still found on
 * screen, tolerating `MAX_MISSES` unmatched lines in a row so a tool call the
 * viewport draws differently does not end the run early.
 *
 * The trade this makes, stated because it is a real one: a genuinely older line
 * sandwiched between two matched lines is trimmed with them. `MIN_WORDS` is
 * what keeps that from mattering — six consecutive words do not coincide by
 * accident, so two lines matching either side of it means the region really is
 * the one on screen, not a repetition that resembles it.
 *
 * Returns a possibly-empty array: a page entirely on screen is a real outcome,
 * and the caller must notice it and fetch the next page rather than leave a tap
 * that appears to do nothing.
 */
export function trimSeen(page: string[], screen: string[]): string[] {
  const haystack = runningText(screen);
  if (haystack === "") return page;

  // Only a match moves the boundary. Whatever sits below the oldest matched
  // line — blank lines, tool calls, a spinner — is inside the duplicated region
  // by position and goes with it.
  let cut = page.length;
  let sawReal = false;
  let misses = 0;

  for (let i = page.length - 1; i >= 0; i--) {
    const flat = flatten(page[i]!);
    const words = flat === "" ? [] : flat.split(" ");

    // Carried, never counted, and never charged as a miss. Ends nothing and
    // proves nothing: a blank line or an `agent · 17:45` stamp says only that
    // it is short.
    if (words.length < MIN_WORDS) continue;

    // The line's OPENING words, not the whole line: the topmost duplicated turn
    // is usually cut off by the top of the viewport, so its tail is genuinely
    // absent while its head is plainly there.
    if (haystack.includes(words.slice(0, MIN_WORDS).join(" "))) {
      sawReal = true;
      cut = i;
      misses = 0;
      continue;
    }

    if (++misses > MAX_MISSES) break;
  }

  return sawReal ? page.slice(0, cut) : page;
}
