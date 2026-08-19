/**
 * The version, injected at build time from the git tag via `bun build
 * --define`. The tag is the single source of truth — package.json's `version`
 * field is deliberately NOT used, because it drifts (it still reads 0.1.0 at
 * the time of writing, several releases later).
 *
 * A build with no tag reports `0.0.0-dev`, so a binary can always answer
 * whether it came from a release — which matters when a bug is reported
 * against a binary someone compiled themselves.
 */
export const VERSION: string = process.env.PADDOCK_VERSION ?? "0.0.0-dev";
