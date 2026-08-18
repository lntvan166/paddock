/**
 * Tells an already-open tab that it is running stale JavaScript.
 *
 * `index.html` is served `no-cache`, which guarantees a FRESH load gets the
 * current bundle — and does nothing for a tab that is already open. That tab
 * keeps running whatever it loaded, indefinitely; on a phone left on a
 * dashboard, for days.
 *
 * The cost of not knowing is not hypothetical. Twice in this project a bug was
 * hunted in code that had already been fixed, because the tab under test was
 * stale — once for half an hour.
 *
 * A prompt rather than an automatic reload, deliberately: reloading without
 * asking would discard a half-typed reply and the reconstructed scrollback,
 * which is exactly the material an operator is in the middle of using.
 */
export function UpdateBar() {
  return (
    <div className="update-bar" role="status">
      <span>A newer version of paddock is available.</span>
      <button type="button" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
