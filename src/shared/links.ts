/**
 * paddock's own public URLs, in one place.
 *
 * CLAUDE.md forbids special-casing a hostname in the client, and that rule
 * stands — but it protects DERIVED CONNECTION URLs: the `localhost` exclusion
 * that silently turns a working dashboard into a demo screen. A documentation
 * link is not that. It is still a hardcoded URL, so it lives here once rather
 * than being repeated at each call site — the site's own hero and the app's
 * Settings card both read it from here.
 */
/**
 * NOT `paddock.vercel.app` — that name belongs to someone else (the word is an
 * F1 term as well as a horse enclosure, and both were claimed). `trypaddock`
 * was chosen over `paddock-herdr` so the install URL does not depend on a name
 * this project does not control. Do not "correct" it to the shorter form.
 */
export const SITE_URL = "https://trypaddock.vercel.app";
/**
 * Served by the site, and shortest for it.
 *
 * This has been four URLs. github.io, retired with Pages. `paddock.vercel.app`,
 * which belongs to someone else. `paddock-bice`, which Vercel assigned. Then
 * the GitHub copy, at 56 characters against this one's 40 — long enough that
 * it stopped reading as a command and started reading as a paragraph, on a
 * string whose whole job is to be typed off a README or a phone screen.
 *
 * KNOWN COST, accepted deliberately: renaming the site breaks this command,
 * and it has broken three times already. The mitigations are that it is one
 * constant, that tests/site-meta.test.ts pins the landing page's copy of it to
 * this value, and that `release.yml` now attaches install.sh to every release —
 * so `github.com/lntvan166/paddock/releases/latest/download/install.sh` exists
 * as a permanent fallback that no rename can take away, whether or not it is
 * the one advertised.
 */
export const INSTALL_URL = `${SITE_URL}/install.sh`;
export const TOUR_URL = `${SITE_URL}/#tour`;
