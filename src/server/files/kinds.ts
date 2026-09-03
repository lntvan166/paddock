/**
 * The server's view of what a file is.
 *
 * The map itself moved to `@shared/file-kinds` when the transcript started
 * linking RELATIVE paths: the UI has to make the same judgement — is this
 * something the viewer can show? — and two copies of an extension table is two
 * answers to one question. Re-exported rather than re-declared so the existing
 * call sites here are unchanged.
 */
export { kindFor, isViewable, type FileKind } from "@shared/file-kinds";

/**
 * How much may be sent to a phone over a tunnel.
 *
 * A ceiling rather than a stream: this is a dashboard read over mobile data,
 * and a refusal that names the size is more useful than a download that stalls.
 *
 * Server-only, unlike the map above — it is a policy about this deployment,
 * not a fact about a file extension.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
