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
 * NOT `releases/latest/download/install.sh`, which would be the pinned form:
 * that URL resolves only once a TAGGED release carries the asset, and the tag
 * that first attaches it has not shipped. `release.yml` attaches it from now
 * on, so this can move to the pinned form after the next release.
 *
 * And `/raw/main/` rather than `raw.githubusercontent.com` for length alone.
 * The two serve identical bytes — the first 302s to the second, which `-L`
 * follows — but it is 56 characters against 67, and this string is read off a
 * README, a landing page and a terminal. The retired github.io URL was 46 and
 * this is the shortest that does not depend on a host paddock is renting.
 */
export const INSTALL_URL = "https://github.com/lntvan166/paddock/raw/main/install.sh";
export const TOUR_URL = `${SITE_URL}/#tour`;
