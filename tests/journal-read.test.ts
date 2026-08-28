import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "@server/journal/claude";
import { MAX_TAIL_BYTES } from "@server/journal/files";
import { toLines } from "@server/journal/text";
import { createJournalReader } from "@server/journal/read";
import type { JournalRoots } from "@server/journal/types";
import type { HerdrAgentSession } from "@shared/herdr-api";

const UUID = "f4971cd4-d53b-430a-8fc6-a0d4572103ae";
const SESSION: HerdrAgentSession = { agent: "claude", kind: "id", source: "herdr:claude", value: UUID };

/** One synthetic JSONL record, alternating user/assistant, distinguishable by index. */
function record(i: number, pad = ""): string {
  const timestamp = `2026-08-20T00:00:${String(i).padStart(2, "0")}Z`;
  return i % 2 === 0
    ? JSON.stringify({
        type: "user",
        timestamp,
        message: { role: "user", content: `turn ${i}${pad}` },
      })
    : JSON.stringify({
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: `turn ${i}${pad}` }] },
      });
}

/** A session log with `n` records, plus a `roots` pointing at its temp project dir. */
async function journal(n: number, pad = ""): Promise<{ roots: JournalRoots; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "paddock-jr-"));
  const project = join(root, "docs-cleanup");
  await mkdir(project);
  const file = join(project, `${UUID}.jsonl`);
  const body = Array.from({ length: n }, (_, i) => record(i, pad)).join("\n") + "\n";
  await writeFile(file, body);
  return { roots: { claude: [root] }, file };
}

/** Pages backward with `limit` until exhausted, oldest-page-first, guarding against a runaway loop. */
async function pageAll(
  reader: ReturnType<typeof createJournalReader>,
  limit: number,
): Promise<{ pages: string[][]; hasMoreHistory: boolean[] }> {
  const pages: string[][] = [];
  const hasMoreHistory: boolean[] = [];
  let before: number | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = await reader.read(SESSION, before, limit);
    expect(page.source).toBe("journal");
    expect(page.detail).toBeNull();
    pages.unshift(page.lines);
    hasMoreHistory.unshift(page.hasMore);
    if (!page.hasMore) return { pages, hasMoreHistory };
    before = Number(page.cursor);
  }
  throw new Error("paging did not terminate — cursor is not making progress");
}

test("paging backwards is lossless and non-overlapping: reassembled pages equal one whole-file parse", async () => {
  // The property that matters: walking every page from the tail back to the
  // start must yield exactly what a single parse of the whole file yields —
  // same entries, same order, no gaps, no duplicates. This is what all three
  // loss modes broke.
  const { roots, file } = await journal(25);
  const reader = createJournalReader(roots);

  const { pages } = await pageAll(reader, 10);
  const paged = pages.flat();

  const expected = toLines(claudeAdapter.parse(readFileSync(file, "utf8")));
  expect(paged).toEqual(expected);
});

test("paging is still lossless across a file bigger than MAX_TAIL_BYTES, with the boundary landing mid-record", async () => {
  // Padded so records are large and MAX_TAIL_BYTES lands inside one of them,
  // not conveniently on a "\n" — the case that pins loss mode 2 (a record
  // straddling the tail-read boundary dropped on both sides of it).
  const pad = "x".repeat(3_000);
  const recordBytes = Buffer.byteLength(record(0, pad) + "\n", "utf8");
  const n = Math.ceil((MAX_TAIL_BYTES * 2.2) / recordBytes); // several chunks' worth
  const { roots, file } = await journal(n, pad);
  const reader = createJournalReader(roots);

  const { pages } = await pageAll(reader, 20);
  const paged = pages.flat();

  const expected = toLines(claudeAdapter.parse(readFileSync(file, "utf8")));
  expect(paged).toEqual(expected);
});

test("hasMore is true when a whole, un-truncated file still holds more entries than limit", async () => {
  // Regression for loss mode 1: hasMore used to be derived from BYTE
  // truncation alone, so a file small enough to read in one un-truncated
  // tailChunk call always reported hasMore:false — even when `limit` had
  // just discarded older turns via `.slice(-limit)`.
  const { roots } = await journal(25);
  const reader = createJournalReader(roots);

  const first = await reader.read(SESSION, null, 4);
  expect(first.source).toBe("journal");
  expect(first.hasMore).toBe(true);
  expect(first.cursor).not.toBeNull();

  // And paging must actually be able to reach the beginning from here.
  // `hasMoreHistory` is oldest-page-first (unshifted alongside `pages`), so
  // index 0 is the LAST page read — the one that terminated the loop.
  const { hasMoreHistory } = await pageAll(reader, 4);
  expect(hasMoreHistory[0]).toBe(false);
});

test("a tailChunk failure after a successful locate() is a detail, not a throw", async () => {
  // `Bun.file(path).size` only STATS the file, so it succeeds on a path the
  // read then fails on — the log rotated, replaced or made unreadable between
  // the two calls. Unhandled, that threw out of the route as a 500 with no
  // `detail`: a broken dashboard where "this agent has no history" was meant.
  //
  // A DIRECTORY where the log should be, rather than `chmod 0o000`: mode bits
  // do not apply to root, so a permissions test passes locally and fails in
  // any CI that runs as root — the same local/CI split `docs/gotchas.md`
  // already records for test-file ordering. A directory stats like a file
  // (4096 bytes, so the `end <= 0` early return is not taken) and fails the
  // read for every uid.
  const root = await mkdtemp(join(tmpdir(), "paddock-jr-"));
  await mkdir(join(root, "docs-cleanup"));
  await mkdir(join(root, "docs-cleanup", `${UUID}.jsonl`));

  const page = await createJournalReader({ claude: [root] }).read(SESSION, null, 10);
  expect(page.source).toBe("reconstruction");
  expect(page.lines).toEqual([]);
  // EXACTLY the fixed phrase, not merely containing it. A Bun/Node filesystem
  // error stringifies with the path it failed on, and `routes.ts` returns
  // `detail` to the browser verbatim, so `${String(err)}` turned an ordinary
  // miss into the operator's home path going over the wire — the filesystem
  // key decision 5 keeps off it. `toContain` is not enough to catch that:
  // interpolation APPENDS, so a leaking detail still contains the phrase.
  // Equality is what makes "nothing else travels" the assertion.
  expect(page.detail).toBe("could not read a page of the session log");
  expect(page.detail).not.toContain(root);
  expect(page.detail).not.toContain(UUID);
});

test("a cursor past the end of the file is clamped, not walked back through", async () => {
  // `before` is format-validated in the route (digits only), which says
  // nothing about its RANGE. A cursor from a log that has since been
  // compacted or rotated can sit far past the current end; unclamped, the
  // reader spends one whole round trip per MAX_TAIL_BYTES crossing bytes that
  // do not exist before it reaches any record.
  const { roots, file } = await journal(6);
  const size = Bun.file(file).size;
  const reader = createJournalReader(roots);

  const far = await reader.read(SESSION, size + MAX_TAIL_BYTES * 4, 50);
  const tail = await reader.read(SESSION, null, 50);

  // One request, and the SAME page a request with no cursor would have given:
  // clamping to the end of the file costs no history, because the end of the
  // file is where a tail read starts anyway.
  expect(far.source).toBe("journal");
  expect(far.lines).toEqual(tail.lines);
  expect(far.detail).toBeNull();
});

/** A log with an arbitrary body, for the two cases `journal(n, pad)` cannot shape. */
async function journalOf(body: string): Promise<{ roots: JournalRoots; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "paddock-jr-"));
  const project = join(root, "docs-cleanup");
  await mkdir(project);
  const file = join(project, `${UUID}.jsonl`);
  await writeFile(file, body);
  return { roots: { claude: [root] }, file };
}

test("every cursor is a real record boundary, even with multi-byte text", async () => {
  // The cursor is a BYTE offset into a file, but it is derived from text that
  // was DECODED. A tail read starts at an arbitrary byte, so it can split a
  // multi-byte character, and the decoder replaces the stray bytes with
  // U+FFFD — three bytes on re-encode, which is not what was on disk. An
  // offset measured ACROSS that line is skewed by the difference: +2 to +4
  // bytes per mid-character cut, measured. The cursor then names a byte a
  // little inside a record instead of the byte the record starts on.
  //
  // Not lossy on its own — the skew is positive and smaller than a record, so
  // the next page's window still holds the previous record whole — but "the
  // cursor is a record boundary" is the whole design, and agent prose is full
  // of em dashes and non-Latin text.
  //
  // The cut lands at `size - MAX_TAIL_BYTES`, so WHETHER it splits a character
  // is a function of the file's length. Left to chance this test passes on a
  // file whose cut happens to land cleanly — it did, before the padding search
  // below — so the file is sized until the cut is known to land mid-character.
  const body = (pad: number) => {
    const records = [];
    let bytes = 0;
    for (let i = 0; bytes < MAX_TAIL_BYTES * 1.3; i++) {
      records.push(JSON.stringify({
        type: "user",
        timestamp: "2026-08-20T00:00:00Z",
        message: { role: "user", content: `turn ${i}: ${"日本語".repeat(200)}${"y".repeat(pad)}` },
      }));
      bytes += Buffer.byteLength(records[records.length - 1]!, "utf8") + 1;
    }
    return records;
  };

  /** A UTF-8 continuation byte: 10xxxxxx. Landing here is a split character. */
  const isMidChar = (buf: Buffer, at: number) => (buf[at]! & 0xc0) === 0x80;

  let records: string[] | null = null;
  for (let pad = 0; pad < 8; pad++) {
    const buf = Buffer.from(body(pad).join("\n") + "\n", "utf8");
    if (isMidChar(buf, buf.length - MAX_TAIL_BYTES)) { records = body(pad); break; }
  }
  expect(records, "no padding put the tail-read cut inside a character").not.toBeNull();

  const { roots, file } = await journalOf(records!.join("\n") + "\n");
  const reader = createJournalReader(roots);

  // Where each record REALLY starts, measured off the encoded file.
  const starts = new Set<number>([0]);
  let at = 0;
  for (const r of records!) {
    at += Buffer.byteLength(r, "utf8") + 1;
    starts.add(at);
  }

  const cursors: number[] = [];
  let before: number | null = null;
  for (let guard = 0; guard < 200; guard++) {
    const page = await reader.read(SESSION, before, 40);
    if (!page.hasMore) break;
    cursors.push(Number(page.cursor));
    before = Number(page.cursor);
  }

  expect(cursors.length).toBeGreaterThan(1);
  expect(cursors.filter((c) => !starts.has(c))).toEqual([]);

  // And the multi-byte content still comes back whole and in order.
  //
  // Compared on CONTENT lines, which is what this test's property is about —
  // same entries, same order, no gaps, no duplicates. `toLines` groups turns
  // under one `who · HH:MM` header and renders one PAGE at a time, so a page
  // whose first turn continues the previous page's group re-states that header:
  // the reassembled pages carry a header per seam that a single whole-file
  // render does not. Every record in this fixture is the same speaker at the
  // same minute — one group, ten pages — so it is the one test here where that
  // shows. The two exact-equality tests above keep their stronger assertion
  // because their fixtures alternate speaker, and alternating renders the same
  // either way.
  const contentOf = (lines: string[]) =>
    lines.filter((l) => l !== "" && !/^(?:you|agent)(?: · \d\d:\d\d)?$/.test(l));

  expect(contentOf((await pageAll(reader, 40)).pages.flat()))
    .toEqual(contentOf(toLines(claudeAdapter.parse(readFileSync(file, "utf8")))));
});

test("a record larger than the window is reported out loud, and paged past", async () => {
  // A chunk that holds no complete line at all. Claude Code writes 600 KB
  // tool_result records routinely, so a single record wider than the read
  // window is ordinary, not hypothetical.
  //
  // Two wrong answers to avoid. Handing back the same cursor stalls the
  // client on "show earlier" for ever. Handing back a cursor with no
  // explanation — which is what deriving it from the chunk start alone does —
  // serves empty pages that look like the end of the history, and hides
  // everything RECORDED BEFORE the oversized record. So: say so, and keep
  // going, because the turns further back are still readable.
  const huge = JSON.stringify({
    type: "user",
    timestamp: "2026-08-20T00:00:00Z",
    message: { role: "user", content: "x".repeat(MAX_TAIL_BYTES + 50_000) },
  });
  expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(MAX_TAIL_BYTES);
  const older = [record(0), record(1)];
  const newer = [record(2), record(3), record(4)];
  const { roots } = await journalOf([...older, huge, ...newer].join("\n") + "\n");
  const reader = createJournalReader(roots);

  const lines: string[][] = [];
  const details: string[] = [];
  let before: number | null = null;
  let terminated = false;
  const seen = new Set<number>();
  for (let guard = 0; guard < 200; guard++) {
    const page = await reader.read(SESSION, before, 10);
    lines.unshift(page.lines);
    if (page.detail !== null) details.push(page.detail);
    if (!page.hasMore) { terminated = true; break; }
    const next = Number(page.cursor);
    if (seen.has(next)) throw new Error(`the cursor stalled at ${next}`);
    seen.add(next);
    before = next;
  }

  expect(terminated).toBe(true);
  // Accounted for, not swallowed.
  expect(details.length).toBeGreaterThan(0);
  expect(details[0]).toContain("larger than");
  // Everything readable on BOTH sides of it is still served, in order. The
  // oversized record itself is the only thing missing, and it is the thing
  // the detail names.
  expect(lines.flat()).toEqual(toLines(claudeAdapter.parse([...older, ...newer].join("\n"))));
});
