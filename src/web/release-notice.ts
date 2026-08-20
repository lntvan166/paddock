/**
 * Whether the dashboard is still telling you about a new release.
 *
 * `HostHeader` carried this as one dim line among the other dim metadata, on
 * the recorded reasoning that `paddock update` is "something the operator runs
 * when they feel like it, not an alarm". That reasoning holds; the placement
 * did not. Measured: an operator running a version behind did not know, because
 * a 10px line the colour of the surrounding metadata is not something you
 * read — it is something you have already learned to skip.
 *
 * So: a banner, once, dismissible. Dismissible because of an asymmetry that
 * does not apply to any other notice in this app — you CANNOT act on this one
 * from the device you are reading it on. `paddock update` runs on the machine
 * paddock is running on, which is by definition not the phone. A notice you
 * can neither act on nor silence is how a dashboard trains you to ignore its
 * banners, and the next one will be the connection banner.
 *
 * Keyed by VERSION, not a boolean. Dismissing 0.8.0 must not also dismiss
 * 0.9.0 — otherwise the first dismissal is permanent and the feature quietly
 * stops existing.
 */
const KEY = "paddock.release.dismissed";

/**
 * The version whose notice was dismissed, or null.
 *
 * Fails open on a throw. This is read during render, and `localStorage` can
 * throw on mere property access under an enterprise policy or blocked-storage
 * setting, quite apart from Safari private mode throwing on write. A banner
 * that reappears is a triviality; a dashboard that crashes while an agent is
 * blocked is not. Same posture as `install.ts`.
 */
export function dismissedRelease(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function dismissRelease(version: string): void {
  try {
    localStorage.setItem(KEY, version);
  } catch {
    // Best-effort — see above. The banner returning next load is acceptable.
  }
}

/**
 * Show the notice for `latestKnown` unless THIS version was dismissed.
 *
 * Pure, and separate from the storage access, because it is the part worth
 * asserting: the interesting behaviour is a newer release re-showing after an
 * older one was dismissed, and that must not need a DOM to prove.
 */
export function shouldShowRelease(
  latestKnown: string | null,
  dismissed: string | null,
): boolean {
  if (latestKnown === null) return false;
  return latestKnown !== dismissed;
}
