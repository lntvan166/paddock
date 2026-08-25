import qrcode from "qrcode-generator";

/**
 * The ONLY file in this repository that knows a QR library exists.
 *
 * Everything about how a QR LOOKS — the quiet zone, half-block glyphs, forced
 * colours, the width guard — belongs to `tunnel/display.ts`. This file answers
 * one question: which modules are dark. Keeping the split there is what let the
 * encoder be a dependency without the look becoming one.
 */
export interface QrMatrix {
  /**
   * The BARE module count — 29 for the version-3 symbol this payload
   * produces. The 4-module quiet zone is deliberately absent: it is the
   * renderer's, so a caller that wants a different margin does not have to
   * unpick one baked in here.
   */
  readonly size: number;
  isDark(row: number, col: number): boolean;
}

/**
 * Error correction level L, not the usual default of M.
 *
 * Error correction exists for smudged print and damaged labels. A terminal
 * render is pixel-perfect, so the redundancy buys nothing and costs size: this
 * payload is version 3 (29x29) at L and version 4 (33x33) at M. A smaller
 * matrix means physically larger modules on screen, which scan faster — the
 * opposite of what most defaults give you.
 *
 * Byte mode, unavoidably: QR's compact alphanumeric mode has no `#` in its
 * character set, so a fragment URL cannot use it however the rest is cased.
 */
const ECC = "L";

/**
 * A one-entry cache, because `render()` in `tunnel/display.ts` runs once a
 * second and the payload changes only when the pairing code rotates — roughly
 * six times an hour against 3,600 calls.
 */
let cached: { text: string; matrix: QrMatrix } | null = null;

export function qrMatrix(text: string): QrMatrix {
  if (cached !== null && cached.text === text) return cached.matrix;

  // 0 = pick the smallest version that fits. Pinning a version here instead
  // would turn a slightly longer hostname into a throw rather than a slightly
  // bigger QR.
  const qr = qrcode(0, ECC);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const matrix: QrMatrix = {
    size,
    isDark: (row, col) => qr.isDark(row, col),
  };
  cached = { text, matrix };
  return matrix;
}
