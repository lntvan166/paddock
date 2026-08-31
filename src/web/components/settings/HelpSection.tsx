import { TOUR_URL } from "@shared/links";
import { Card } from "@web/components/ui/Card";
import { LinkIcon } from "@web/components/ui/icons";

/**
 * The one external link in the application, and the reason it is written the
 * way it is.
 *
 * `target="_blank"` is load-bearing, not stylistic. The manifest sets
 * `"display": "standalone"`, so an installed paddock runs chromeless; a
 * same-window navigation to another origin from a standalone PWA historically
 * renders INSIDE the app shell with no browser chrome and no back button,
 * stranding the operator on a page they cannot leave without force quitting.
 * iOS 16.4 and later hand such links to the browser, but the older behaviour is
 * still in the field. `rel="noopener"` keeps the opened page from reaching
 * `window.opener`.
 *
 * `tests/external-links.test.ts` asserts both, here and on every link added
 * later — this was the first external link in `src/web/`, so there was no house
 * pattern to inherit and nothing to be consistent with.
 *
 * The tour itself lives on the site, not here: it would otherwise overlay a
 * real screen with real blocked agents, and every step would need a degraded
 * variant for an operator who has no blocked agent, no spaces, or one agent.
 */
export function HelpSection() {
  return (
    <Card
      icon={<LinkIcon />}
      title="How to use"
      subtitle="A guided pass over every screen, on the demo."
    >
      <div className="card-row">
        <span>New to paddock?</span>
        <a className="help-link" href={TOUR_URL} target="_blank" rel="noopener noreferrer">Take the tour</a>
      </div>
    </Card>
  );
}
