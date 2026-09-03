import type { RenderMode } from "@shared/types";

/**
 * What a file is, for the purpose of showing it on a phone.
 *
 * SHARED, because both sides need the same answer and a second copy is how
 * they stop agreeing. The server reads it to choose a content type and a
 * render mode; the UI reads it to decide whether a RELATIVE path in a
 * transcript is worth linking at all — a tap that resolves to a download is
 * worse than no link, so `src/web/paths.ts` links a relative token only when
 * this says the viewer can render it.
 *
 * DERIVED FROM THE EXTENSION, deliberately unlike `uploads/store.ts`, which
 * sniffs the bytes. That route accepts what a phone sends and hands the result
 * to an agent; this one reads a file the operator already has and hands it to
 * their own browser, where being wrong costs a bad render rather than a bad
 * file on disk. The route pairs this with `X-Content-Type-Options: nosniff`, so
 * the browser does not second-guess the answer either.
 *
 * An unknown extension is a DOWNLOAD, never a guess. Rendering an unknown
 * binary as text is how a screen fills with mojibake and the operator concludes
 * the file is corrupt — and a dotfile like `.env` has no extension at all,
 * which keeps the one case where guessing wrong would put credentials on screen
 * out of the text path.
 */
export interface FileKind {
  contentType: string;
  render: RenderMode;
}

const KINDS: Record<string, FileKind> = {
  html: { contentType: "text/html", render: "iframe" },
  htm: { contentType: "text/html", render: "iframe" },
  pdf: { contentType: "application/pdf", render: "iframe" },
  png: { contentType: "image/png", render: "image" },
  jpg: { contentType: "image/jpeg", render: "image" },
  jpeg: { contentType: "image/jpeg", render: "image" },
  gif: { contentType: "image/gif", render: "image" },
  webp: { contentType: "image/webp", render: "image" },
  svg: { contentType: "image/svg+xml", render: "image" },
  md: { contentType: "text/plain; charset=utf-8", render: "text" },
  txt: { contentType: "text/plain; charset=utf-8", render: "text" },
  json: { contentType: "text/plain; charset=utf-8", render: "text" },
  csv: { contentType: "text/plain; charset=utf-8", render: "text" },
  log: { contentType: "text/plain; charset=utf-8", render: "text" },
};

const UNKNOWN: FileKind = { contentType: "application/octet-stream", render: "download" };

export function kindFor(path: string): FileKind {
  // The last segment only: a directory named `.html` must not decide the type
  // of a file inside it. `dot <= 0` covers both "no extension" and a leading
  // dot, which is a NAME (`.env`) rather than an extension.
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return UNKNOWN;
  return KINDS[name.slice(dot + 1).toLowerCase()] ?? UNKNOWN;
}

/** Whether the viewer can show this on screen, rather than only save it. */
export const isViewable = (path: string): boolean => kindFor(path).render !== "download";
