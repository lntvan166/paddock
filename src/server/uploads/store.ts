import { readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Images the operator attaches from their phone, on their way to an agent.
 *
 * THIS IS PADDOCK'S ONLY ROUTE THAT WRITES ARBITRARY BYTES TO DISK, which is
 * why every decision here is a refusal rather than a default:
 *
 * - **A directory paddock owns**, under `PADDOCK_CONFIG_DIR` — never the
 *   agent's working directory. The agent reads an absolute path either way, and
 *   this is what keeps "anything that can reach paddock can write into your
 *   repository" from being true. `docs/decisions.md` gives this listener no
 *   authentication of its own, so reachability IS authority: the blast radius
 *   of that has to stay one directory outside every repository.
 * - **The type is sniffed, never believed.** A declared `content-type` is a
 *   claim by the caller, and the file written here is one a coding agent is
 *   then told to open.
 * - **The name is generated here**, never taken from the client. A phone
 *   filename can collide, carry separators, or be a path.
 * - **Every write prunes.** See `planPrune`.
 */

/** The most one upload may be. A phone photo is 2–5 MB; this is generous. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** How much the directory may hold before the oldest are dropped. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** How long a file is kept regardless of the byte bound. */
export const MIN_KEEP_MS = 60 * 60 * 1000;

/** How long a file is kept at all. */
export const MAX_AGE_MS = 7 * 86_400_000;

/** The types a harness can actually open. See `sniffImageType`. */
export type ImageType = "png" | "jpg" | "gif" | "webp";

export interface StoredUpload {
  name: string;
  size: number;
  mtimeMs: number;
}

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean =>
  b.length >= sig.length && sig.every((v, i) => b[i] === v);

const asciiAt = (b: Uint8Array, at: number, text: string): boolean =>
  b.length >= at + text.length &&
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * What the bytes actually are, or null to refuse them.
 *
 * Only the four an agent can read. **HEIC is deliberately absent** even though
 * it is what an iPhone camera writes: Safari converts a Photo Library pick to
 * JPEG when it uploads, so this rarely fires — and when it does, refusing names
 * the problem at the moment of attaching rather than letting the agent fail to
 * open a file it was handed. A mislabelled attachment is the same class of
 * mistake as a mislabelled Approve button.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "gif";
  // RIFF<4 size bytes>WEBP.
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
  return null;
}

/**
 * The filename, generated here.
 *
 * Date-prefixed so age is visible in the path and a manual `rm` is obvious;
 * random-suffixed so two photos in one second cannot collide; extension from
 * the SNIFFED type, so the name cannot disagree with the contents.
 */
export function uploadName(
  type: ImageType,
  at: number,
  random: () => number = Math.random,
): string {
  const day = new Date(at).toISOString().slice(0, 10);
  const suffix = Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${day}-${suffix}.${type}`;
}

/**
 * Which files to delete, given what is there.
 *
 * TWO BOUNDS, because either alone leaks: age never touches thirty photos
 * uploaded this afternoon, and a byte cap never touches one file forgotten for
 * a year.
 *
 * ONE FLOOR that overrides the byte bound: nothing younger than `MIN_KEEP_MS`
 * is dropped for size, because a burst of uploads must not evict the image the
 * operator is about to name in their next message — and an agent may re-read a
 * path later in the conversation, so recency is not disposable. The age bound
 * needs no such exception: a file cannot be both older than a week and younger
 * than an hour.
 *
 * Pure, and returns NAMES rather than paths, so the caller can only unlink
 * inside the directory it listed.
 */
export function planPrune(
  files: readonly StoredUpload[],
  now: number,
  opts: { maxAgeMs?: number; maxBytes?: number; minKeepMs?: number } = {},
): string[] {
  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const minKeepMs = opts.minKeepMs ?? MIN_KEEP_MS;

  const doomed = new Set<string>();
  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) doomed.add(f.name);
  }

  // Oldest first, so the byte bound sheds history rather than the present.
  const survivors = files
    .filter((f) => !doomed.has(f.name))
    .slice()
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let total = survivors.reduce((n, f) => n + f.size, 0);
  for (const f of survivors) {
    if (total <= maxBytes) break;
    if (now - f.mtimeMs < minKeepMs) continue;
    doomed.add(f.name);
    total -= f.size;
  }

  return files.filter((f) => doomed.has(f.name)).map((f) => f.name);
}

/** Where uploads live, under the directory paddock already owns. */
export function uploadDir(configDir: string): string {
  return join(configDir, "uploads");
}

/**
 * List the directory, tolerating its absence.
 *
 * A file that vanishes between `readdir` and `stat` is dropped rather than
 * thrown: nothing else here is the only writer, and a race must not cost the
 * operator an upload.
 */
async function listUploads(dir: string): Promise<StoredUpload[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: StoredUpload[] = [];
  for (const name of names) {
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) out.push({ name, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Delete what `planPrune` names, reporting both halves.
 *
 * A failed unlink is logged and does not throw: the upload it follows has
 * already succeeded, and the operator asked for that, not for housekeeping. The
 * failure is still said out loud — a directory that has quietly stopped being
 * prunable is worth knowing about before it fills a disk.
 */
export async function pruneUploads(dir: string, now: number): Promise<string[]> {
  const removed: string[] = [];
  for (const name of planPrune(await listUploads(dir), now)) {
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch (err) {
      console.error(`uploads: could not remove ${name}`, err);
    }
  }
  if (removed.length > 0) {
    console.info(`uploads: pruned ${removed.length} file(s)`, { dir });
  }
  return removed;
}

export interface SavedImage {
  /** Absolute path, which is what the agent is told to open. */
  path: string;
  name: string;
  type: ImageType;
}

/**
 * Write one image, then prune.
 *
 * Pruning AFTER the write, and attached to it rather than to a timer: the
 * directory only grows when this runs, so this is the moment growth happens —
 * and it reports into a log the operator is already reading, where a background
 * sweep would fail at three in the morning unseen.
 */
export async function saveImage(
  configDir: string,
  bytes: Uint8Array,
  now: number,
): Promise<SavedImage | { refused: string }> {
  if (bytes.byteLength === 0) return { refused: "that file is empty" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { refused: `images are limited to ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB` };
  }

  const type = sniffImageType(bytes);
  if (!type) {
    return { refused: "that is not a PNG, JPEG, GIF or WebP — those are what an agent can read" };
  }

  const dir = uploadDir(configDir);
  await mkdir(dir, { recursive: true });
  const name = uploadName(type, now);
  const path = join(dir, name);
  await writeFile(path, bytes, { mode: 0o600 });

  await pruneUploads(dir, now);
  return { path, name, type };
}
