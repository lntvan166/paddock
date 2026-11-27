/** Each lookup's own limit. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * The newest release's version ("0.17.0"), for `paddock update` and the
 * update check.
 *
 * The REST API first, then github.com's own `releases/latest` redirect. The
 * API allows 60 unauthenticated requests an hour per IP, and an office or a
 * café behind one NAT spends that on its own: `paddock update` then failed
 * with a bare "HTTP 403" while the release was right there. The redirect is
 * the path `install.sh` downloads through (`releases/latest/download`), which
 * is not under that limit, and its `Location` names the tag.
 *
 * Throws with both reasons when neither answers, so a failure says what was
 * tried rather than only the first refusal.
 */
export async function latestRelease(
  repo: string,
  f: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  let apiWhy: string;
  try {
    const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
      // Bounded: a request that never answers held `paddock update` before it
      // had printed anything, the same class as the stalled download.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) {
      const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
      if (tag) return tag;
      apiWhy = "the release API returned no tag";
    } else {
      const limited = res.status === 403 || res.status === 429;
      apiWhy = `the release API answered HTTP ${res.status}${limited ? " (GitHub's rate limit for this network)" : ""}`;
    }
  } catch (e) {
    apiWhy = `the release API was unreachable: ${(e as Error).message}`;
  }

  let webWhy: string;
  try {
    const res = await f(`https://github.com/${repo}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    const to = res.headers.get("location") ?? "";
    const m = /\/releases\/tag\/v?([^/?#]+)$/.exec(to);
    if (m) return decodeURIComponent(m[1]!);
    webWhy = `github.com answered HTTP ${res.status} without a release tag`;
  } catch (e) {
    webWhy = `github.com was unreachable: ${(e as Error).message}`;
  }
  throw new Error(`${apiWhy}; ${webWhy}`);
}
