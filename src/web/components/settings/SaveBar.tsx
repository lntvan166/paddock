interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}

/**
 * Renders NOTHING when the form is clean.
 *
 * Save used to sit at the bottom of a long single-column form: on a phone the
 * operator changed a field near the top, never scrolled, and left believing
 * the change had taken. A bar that appears the moment anything is dirty is
 * both the reminder and the button, and costs no screen space while the
 * operator is only reading.
 */
export function SaveBar({ dirty, saving, onSave }: SaveBarProps) {
  if (!dirty) return null;
  return (
    <div className="settings-save-bar" role="region" aria-label="Unsaved changes">
      <span>Unsaved changes</span>
      <button type="button" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
