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
 * Served by GitHub, NOT by the site above.
 *
 * The published `curl … | sh` used to point at whatever host the landing page
 * lived on, and that host has changed three times — github.io, then two Vercel
 * names — each rename leaving an install command that 404s in a README which
 * otherwise reads correctly. The binaries this script downloads already come
 * from GitHub releases, so serving the script from the same origin takes the
 * marketing site out of the install path: renaming the site cannot break it.
 *
 * `raw.githubusercontent.com` rather than `releases/latest/download` because
 * the release URL only resolves once a tagged release CARRIES the asset, and
 * the tag that first attaches it has not shipped yet — a pinned URL that 404s
 * today is worse than an unpinned one that works. `release.yml` attaches it
 * from now on; this can move to the pinned form after the next release.
 */
export const INSTALL_URL =
  "https://raw.githubusercontent.com/lntvan166/paddock/main/install.sh";
export const TOUR_URL = `${SITE_URL}/#tour`;
