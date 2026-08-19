interface ToastProps {
  /** Null renders the region empty. Success text only — see below. */
  message: string | null;
}

/**
 * Success only, and deliberately.
 *
 * Errors keep the persistent `settings-banner`: an error the operator has to
 * catch inside a three-second window is a swallowed error, and this codebase's
 * central rule is that failures are surfaced. A live region rather than plain
 * text so the confirmation reaches a screen reader without stealing focus.
 *
 * The region is ALWAYS mounted, and only its text is conditional. A
 * `role="status"` element inserted at the same moment as its content is
 * announced unreliably across assistive technologies — the region has to be
 * there for the update to be an update. `.settings-toast:empty` collapses it to
 * nothing visually; it is deliberately not `display: none`, which would take it
 * back out of the accessibility tree and undo the point.
 */
export function Toast({ message }: ToastProps) {
  return <p className="settings-toast" role="status" aria-live="polite">{message ?? ""}</p>;
}
