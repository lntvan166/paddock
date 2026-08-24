/**
 * A new paddock is out, said where it will actually be seen.
 *
 * Styled like `ConnectionBanner` rather than `UpdateBar`, deliberately: those
 * two answer different questions. `UpdateBar` means "this TAB is running stale
 * JavaScript", and its button fixes it on the spot. This one means "the BINARY
 * on the host is behind", and there is no button that can fix that from here —
 * so it names the command instead of offering an affordance that would have to
 * lie about what tapping it does.
 *
 * `--accent` and not `--warn`: a warning colour would put a new release on the
 * same footing as a stale connection, and one of those two means an agent's
 * state may be wrong right now. Colour is not the only channel — the text says
 * what it is — and the dismiss control is a real button, not a hover-revealed
 * affordance, because on a phone there is no hover.
 */
import type { ManagedBy } from "@shared/types";

export function ReleaseBanner({
  version, managedBy, onDismiss,
}: {
  version: string;
  managedBy: ManagedBy | null;
  onDismiss: () => void;
}) {
  // Named from what actually owns the install, never guessed. `paddock update`
  // refuses inside a Homebrew keg (src/server/update.ts), so printing it there
  // labels the notice with an action that declines — the same defect as a
  // mislabelled Approve button, which CLAUDE.md rules out for the same reason.
  const command = managedBy === "homebrew" ? "brew upgrade paddock" : "paddock update";
  return (
    <div
      role="status"
      className="flex items-start gap-2 px-3 py-2 text-[11px]"
      style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--accent)",
        color: "var(--fg)",
      }}
    >
      <span className="min-w-0 flex-1">
        paddock <strong>{version}</strong> is available — run{" "}
        <code>{command}</code> on the machine running it
      </span>
      <button
        type="button"
        className="tap shrink-0 px-1"
        aria-label="Dismiss update notice"
        style={{ color: "var(--fg-dim)" }}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
