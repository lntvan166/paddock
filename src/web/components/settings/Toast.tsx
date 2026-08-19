interface ToastProps {
  /** Null hides it. Success text only — see below. */
  message: string | null;
}

/**
 * Success only, and deliberately.
 *
 * Errors keep the persistent `settings-banner`: an error the operator has to
 * catch inside a three-second window is a swallowed error, and this codebase's
 * central rule is that failures are surfaced. A live region rather than plain
 * text so the confirmation reaches a screen reader without stealing focus.
 */
export function Toast({ message }: ToastProps) {
  if (message === null) return null;
  return <p className="settings-toast" role="status" aria-live="polite">{message}</p>;
}
