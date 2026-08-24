import {
  Card as ShadcnCard,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@web/components/shadcn/card";

/**
 * A bordered group with three optional regions.
 *
 * Built on shadcn's Card, but the API is paddock's and unchanged — shadcn's
 * version is a set of seven unopinionated parts you assemble at every call
 * site, and paddock's whole point is that a settings group is assembled ONCE
 * and the same way each time. Keeping this wrapper is also what let the swap
 * touch no consumer.
 *
 * The three slots, and the two layouts that fall out of which are used:
 *
 *  - `control` — rendered INSIDE the header row, right-aligned and centred
 *    against a two-line title+subtitle. This is a toggle: the switch belongs
 *    beside the thing it switches. shadcn has `CardAction` for exactly this
 *    position, which is what it maps to.
 *  - `children` — rendered below a divider. A segmented control, a button row,
 *    a diagnostics list — anything needing the card's full width.
 *  - `footer` — below a second divider, dimmed. Where an inert control says
 *    WHY. A control that is inert and silent leaves the operator to guess,
 *    which is the whole failure this slot prevents.
 *
 * Each region is omitted entirely when its slot is empty, rather than rendering
 * a divided empty box that reads as a bug.
 */
export function Card({
  icon, title, subtitle, control, footer, children,
}: {
  icon?: React.ReactNode;
  title?: string;
  /** A node, not a string: a subtitle that quotes a version or a hostname needs
   *  to set that part in the machine voice (`.ident`) while the sentence around
   *  it stays sans. See `InfoSection`. */
  subtitle?: React.ReactNode;
  control?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasHead = Boolean(icon || title || subtitle || control);
  return (
    <ShadcnCard className="card">
      {hasHead && (
        <CardHeader className="card-head">
          {icon ? <span className="card-icon">{icon}</span> : null}
          <div className="card-heading">
            {/* NOT shadcn's `CardTitle`: that is a hardcoded <div> with no
                `render` or `asChild` escape hatch, so it cannot be a heading.
                The settings page's outline is load-bearing — h1 Settings, h2
                per band, h3 per card — because the screen has two different
                commit models and someone navigating by heading has to be able
                to tell "this saves immediately" from "this needs Save". A card
                title that is a div erases that distinction. */}
            {title ? <h3 className="card-title">{title}</h3> : null}
            {subtitle ? <CardDescription className="card-sub">{subtitle}</CardDescription> : null}
          </div>
          {control ? <CardAction className="card-control">{control}</CardAction> : null}
        </CardHeader>
      )}
      {children ? <CardContent className="card-body">{children}</CardContent> : null}
      {footer ? <CardFooter className="card-foot">{footer}</CardFooter> : null}
    </ShadcnCard>
  );
}
