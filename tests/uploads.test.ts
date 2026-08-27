import { expect, test } from "bun:test";
import {
  MAX_UPLOAD_BYTES,
  MIN_KEEP_MS,
  planPrune,
  sniffImageType,
  uploadName,
  type StoredUpload,
} from "@server/uploads/store";

// ---- what is actually in the bytes ----------------------------------------
//
// Sniffed, never taken from the request. A client-declared `content-type` is a
// claim, and this route writes files to the operator's disk that a coding agent
// is then told to open — the one place in paddock where believing a claim has a
// consequence past a bad screen.

const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(32).fill(0)]);
const ascii = (s: string, ...rest: number[]) =>
  new Uint8Array([...[...s].map((c) => c.charCodeAt(0)), ...rest, ...new Array(32).fill(0)]);

test("the four types a harness can read are recognised", () => {
  expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
  expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpg");
  expect(sniffImageType(ascii("GIF89a"))).toBe("gif");
  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  expect(sniffImageType(ascii("RIFF", 0, 0, 0, 0, ...[..."WEBP"].map((c) => c.charCodeAt(0))))).toBe("webp");
});

test("HEIC is refused, though it is what a phone camera produces", () => {
  // Deliberate. Safari converts a Photo Library pick to JPEG on upload, so
  // this rarely fires — and when it does, refusing names the problem here
  // rather than letting the agent fail to open a file it cannot read.
  const heic = new Uint8Array([
    0, 0, 0, 0x20,
    ...[..."ftypheic"].map((c) => c.charCodeAt(0)),
    ...new Array(32).fill(0),
  ]);
  expect(sniffImageType(heic)).toBeNull();
});

test("anything that is not an image is refused", () => {
  expect(sniffImageType(ascii("#!/bin/sh\\necho hi"))).toBeNull();
  expect(sniffImageType(ascii("%PDF-1.7"))).toBeNull();
  expect(sniffImageType(new Uint8Array([]))).toBeNull();
  // A PNG signature one byte short is not a PNG.
  expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
});

// ---- the name -------------------------------------------------------------

test("the name is date-prefixed, random-suffixed, and takes the sniffed type", () => {
  const at = Date.UTC(2026, 7, 27, 22, 15, 0);

  const name = uploadName("png", at, () => 0.5);

  expect(name).toMatch(/^2026-08-27-[0-9a-f]{8}\.png$/);
});

test("two uploads in the same second do not collide", () => {
  const at = Date.UTC(2026, 7, 27, 22, 15, 0);
  let n = 0;
  const rng = () => [0.1, 0.9][n++ % 2]!;

  expect(uploadName("jpg", at, rng)).not.toBe(uploadName("jpg", at, rng));
});

// ---- the prune ------------------------------------------------------------

const NOW = Date.UTC(2026, 7, 27, 22, 0, 0);
const DAY = 86_400_000;

const file = (name: string, ageMs: number, size = 1_000): StoredUpload =>
  ({ name, size, mtimeMs: NOW - ageMs });

test("nothing is pruned while both bounds are respected", () => {
  const kept = [file("a.png", DAY), file("b.png", 2 * DAY)];
  expect(planPrune(kept, NOW)).toEqual([]);
});

test("files past the age bound go", () => {
  const plan = planPrune([file("old.png", 8 * DAY), file("new.png", DAY)], NOW);
  expect(plan).toEqual(["old.png"]);
});

test("past the byte bound, the oldest go first", () => {
  // 40 MB each: three exceed the 100 MB cap, dropping ONE brings it to 80 and
  // the sweep stops. Sized so the assertion is about ordering, not arithmetic —
  // an earlier fixture used half-the-cap-plus-one and evicted two, which said
  // nothing about which went first.
  const big = 40 * 1024 * 1024;
  const plan = planPrune(
    [
      file("newest.png", 2 * 3_600_000, big),
      file("middle.png", 3 * DAY, big),
      file("oldest.png", 4 * DAY, big),
    ],
    NOW,
  );
  // Two of three exceed the cap, so the oldest is dropped until it fits — and
  // only one needs to go.
  expect(plan).toEqual(["oldest.png"]);
});

test("a file younger than the keep floor survives the byte bound", () => {
  // The case this floor exists for: a burst of uploads must not evict the
  // image the operator is about to name in their next message. The agent may
  // re-read the path later in the conversation, so recency is not disposable.
  const big = MAX_UPLOAD_BYTES;
  const plan = planPrune(
    [file("just-now.png", MIN_KEEP_MS / 2, big), file("also-now.png", MIN_KEEP_MS / 3, big)],
    NOW,
  );
  expect(plan).toEqual([]);
});

test("the age bound ignores the keep floor, because it cannot conflict with it", () => {
  // A week-old file is not within the hour, so no special case is needed —
  // asserted so a future edit does not add one and break the byte-bound floor.
  expect(planPrune([file("ancient.png", 30 * DAY, 1)], NOW)).toEqual(["ancient.png"]);
});

test("the plan is names only, so a caller cannot delete a path it was not given", () => {
  const plan = planPrune([file("old.png", 9 * DAY)], NOW);
  expect(plan.every((n) => !n.includes("/"))).toBe(true);
});
