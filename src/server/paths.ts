/**
 * paddock's tilde convention, for BOTH backends.
 *
 * Each backend's tree (`herdr/tree.ts`, `herdr-core/tree.ts`) tilde-ises the
 * folders it reports, and the create and file routes undo it. These lived in
 * `herdr/tree.ts`, which made the herdr-core tree import terminal herdr's
 * module to shape an app pane — the one import across the two backends.
 * Neither backend owns the convention, so neither module holds it.
 *
 * Pure: no imports, no environment. The caller passes `home`.
 */

/**
 * A path herdr can actually chdir into: absolute, and with paddock's own
 * tilde already undone.
 *
 * Both halves are enforced, which was not always true: `expandHome` once
 * guaranteed only the second, refusing a tilde it could not resolve while
 * forwarding `./relative` — so the sentence above was false in writing about
 * the word "absolute". It now refuses anything that is not absolute after
 * expansion, and this doc is a promise again rather than an aspiration.
 *
 * A BRAND, not a validation helper — the only way to obtain one is
 * `expandHome` below, which is the single function that casts into it.
 * That is the whole point. Both backends' trees tilde-ise every cwd on the way out so a
 * username never crosses the wire, the create sheet offers those tilde-ised
 * cwds back as quick picks, and herdr was measured to neither expand nor
 * refuse a `~` — it silently starts the pane in the home directory instead.
 * The first fix for that put the expansion in one route and left nothing
 * forcing the next route to call it. This does: a future `pane.split` or any
 * other cwd-accepting route cannot assign a raw client string here, so it
 * cannot compile without going through the expansion.
 *
 * `HostPath` is assignable to `string`, so every consumer of `opts.cwd` —
 * including a test fake typed `(opts: {cwd?: string})` — is unaffected. Only
 * the direction that matters is blocked.
 */
export type HostPath = string & { readonly __hostPath: unique symbol };

/**
 * `/base/operator/work` -> `~/work`.
 *
 * Not cosmetic. A pane with no agent is labelled by its folder (§16.6), and
 * the folder of a home directory IS the username — which this repo's first
 * rule exists to keep out of screens and screenshots. Doing it server-side
 * means the username never crosses the wire at all, rather than being hidden
 * by the client that happens to render it.
 */
export function tildeise(cwd: string, home: string | undefined): string {
  if (!home || home === "/" || !cwd) return cwd;
  const h = home.replace(/\/+$/, "");
  if (cwd === h) return "~";
  return cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}

/**
 * `~/work` -> `/base/operator/work`, or `null` when the tilde cannot be
 * resolved here. The EXACT inverse of `tildeise` above, and it lives beside it
 * for that reason.
 *
 * The tilde is paddock's own convention, invented here so a username never
 * crosses the wire. It therefore has to be undone here too, because it comes
 * BACK: the create sheet offers the cwds already in the tree as quick picks
 * (§9.3), and every one of them is tilde-ised. Measured on a live herd —
 * `workspace.create {cwd: "~/Documents/…"}` does not expand the tilde and does
 * not refuse it either: the new pane came up in the HOME directory, with
 * nothing anywhere saying the folder the operator picked had been ignored.
 * That is the silent-wrong-outcome class this codebase exists to refuse, so
 * the expansion happens before the value reaches herdr rather than being left
 * to a shell that never sees it.
 *
 * A bare `~` and `~/...` only, and only when there is a home to expand
 * against. Anything that is not ABSOLUTE after that comes back `null` rather
 * than being forwarded, because forwarding is the defect:
 *
 * - `~operator/...` is another user's home on a real shell. paddock knows ONE
 *   home directory, so resolving it against `$HOME` would silently point at a
 *   different account's path — worse than refusing.
 * - `~/...` with `HOME` unset or `/` has nothing to expand against at all.
 * - `./relative`, `relative`, `../up` — whether herdr resolves these against
 *   its OWN process cwd is unmeasured, and the measured answer for the tilde
 *   was "silently, in the wrong folder". Same class of value: a path whose
 *   meaning depends on a working directory paddock cannot see. An earlier
 *   version refused the tilde and forwarded these with a 200, which is the
 *   same defect wearing a different prefix — and it made both this function's
 *   own promise and the route's 400 text false in writing.
 *
 * The rule, stated once: **refuse an unmeasured value when a measured
 * alternative already expresses the same intent; relay when there is none.**
 * An absolute path is that alternative, and every cwd the UI can produce is
 * already one — the quick picks are the tree's own tilde-ised cwds, and free
 * text is the operator's own path — so nothing the operator can do regresses.
 * A refusal they can read beats a folder silently ignored, so the caller gets
 * `null` and turns it into a 400.
 *
 * Returning `HostPath` is the other half of that guarantee: this is the ONLY
 * function that casts into the brand `CreateOpts.cwd` requires, so a cwd
 * cannot reach herdr without passing through here. See `HostPath` in
 * `actions.ts`.
 */
export function expandHome(cwd: string, home: string | undefined): HostPath | null {
  const h = home && home !== "/" ? home.replace(/\/+$/, "") : null;
  let out = cwd;
  if (h !== null) {
    if (cwd === "~") out = h;
    else if (cwd.startsWith("~/")) out = `${h}${cwd.slice(1)}`;
  }
  // ONE gate, and it is the brand's own promise: absolute, or nothing. A value
  // still tilde-prefixed fails it, and so does `./relative`, `relative` and the
  // empty string — every shape whose meaning depends on a working directory
  // paddock cannot see.
  return out.startsWith("/") ? (out as HostPath) : null;
}
