/**
 * The ONE definition of the quick-tunnel hostname shape.
 *
 * Imported by `server/tunnel/cloudflared.ts` to read the URL out of
 * `cloudflared`'s output, by `server/tunnel/preflight.ts` to decide whether a
 * saved `publicUrl` is a real deployment, and by the settings UI to flag a
 * stale one. It lives here because the UI may not import from `@server`, and
 * because a second copy would drift — one of the two would end up accepting
 * `a.trycloudflare.com.example.net`, which is somebody else's domain wearing
 * the suffix as a prefix.
 *
 * There is exactly ONE regex fragment for the hostname shape. `QUICK_TUNNEL_RE`
 * (scanning arbitrary text for a boxed URL, with a negative lookahead so it
 * cannot match a prefix of a longer host) and the anchored check inside
 * `isQuickTunnelUrl` (testing an already-parsed hostname) are both built from
 * it, so the two can never drift apart and independently get the lookalike
 * case wrong.
 */
const HOST_FRAGMENT = "[a-z0-9][a-z0-9-]*\\.trycloudflare\\.com";

/**
 * Matches a quick-tunnel URL inside arbitrary text, such as a line of
 * `cloudflared` log output. `https` only: a quick tunnel is always TLS, so a
 * plaintext match means we misread the line. The trailing negative lookahead
 * is the other half of the anchoring: without it, `a.trycloudflare.com` would
 * also match the first part of `a.trycloudflare.com.example.net`, which is
 * somebody else's domain wearing the suffix as a prefix.
 */
export const QUICK_TUNNEL_RE = new RegExp(`https:\\/\\/${HOST_FRAGMENT}(?![.\\w-])`, "i");

/** Anchored on both ends, for testing an already-extracted hostname exactly. */
const QUICK_TUNNEL_HOST_RE = new RegExp(`^${HOST_FRAGMENT}$`, "i");

/**
 * Is this URL a quick tunnel?
 *
 * Parsed rather than pattern-matched against the whole string: a path or query
 * that mentions the suffix says nothing about where the URL points, and
 * `isQuickTunnelUrl` is used to decide whether an operator has a real
 * deployment. Getting that backwards silences a hint they need.
 */
export function isQuickTunnelUrl(url: string | null): boolean {
  if (url === null || url === "") return false;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname;
  } catch {
    // Not a URL at all. Not a quick tunnel either.
    return false;
  }
  return QUICK_TUNNEL_HOST_RE.test(host);
}
