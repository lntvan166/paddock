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
export const SITE_URL = "https://paddock.vercel.app";
export const INSTALL_URL = `${SITE_URL}/install.sh`;
export const TOUR_URL = `${SITE_URL}/#tour`;
