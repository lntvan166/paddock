/**
 * A bordered group with three optional regions, which between them cover both
 * layouts the settings screen needs:
 *
 *  - `control` renders INSIDE the header row, right-aligned and centred
 *    against a two-line title+subtitle. This is a toggle: the switch belongs
 *    beside the thing it switches.
 *  - `children` renders below a divider. This is a segmented control, a button
 *    row, a diagnostics list — anything that needs the card's full width.
 *  - `footer` renders below a second divider, dimmed. This is where a disabled
 *    control says WHY. A control that is inert and silent leaves the operator
 *    to guess, which is the whole failure this slot exists to prevent.
 *
 * Each region is omitted entirely when its slot is empty, rather than
 * rendering a divided empty box that reads as a bug.
 */
export function Card({
  icon, title, subtitle, control, footer, children,
}: {
  icon?: React.ReactNode;
  title?: string;
  subtitle?: string;
  control?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasHead = Boolean(icon || title || subtitle || control);
  return (
    <section className="card">
      {hasHead && (
        <div className="card-head">
          {icon ? <span className="card-icon">{icon}</span> : null}
          <div className="card-heading">
            {/* `h3`, not `h2`: a card is nested content inside a settings
                band, whose own label (`Settings.tsx`'s `.band-label`) is now
                a real `h2`. A card title one level below its band lets a
                screen-reader user navigating by heading tell "This device"
                (writes immediately) from "All devices" (needs Save) apart
                from the cards inside them — the reason the two-band split
                exists in the first place. */}
            {title ? <h3 className="card-title">{title}</h3> : null}
            {subtitle ? <p className="card-sub">{subtitle}</p> : null}
          </div>
          {control ? <div className="card-control">{control}</div> : null}
        </div>
      )}
      {children ? <div className="card-body">{children}</div> : null}
      {footer ? <div className="card-foot">{footer}</div> : null}
    </section>
  );
}
