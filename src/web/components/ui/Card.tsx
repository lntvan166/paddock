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
            {title ? <h2 className="card-title">{title}</h2> : null}
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
