import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Crockford base32: `I`, `L`, `O` and `U` are absent so a code read off a
 * terminal and typed on a phone cannot be lost to `1`/`I` or `0`/`O`. Exactly
 * 32 symbols — a shorter alphabet would silently cost entropy.
 */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LEN = 8;
/** ~40 bits. Entropy is not the control here; MAX_ATTEMPTS is. */
export const CODE_TTL_MS = 600_000;
export const MAX_ATTEMPTS = 5;
/** 30 days. Load-bearing — see the note on `setCookie` in gate.ts. */
export const SESSION_MAX_AGE_S = 2_592_000;
export const COOKIE_NAME = "paddock_pair";

export interface LiveCode {
  code: string;
  expiresAt: number;
}

export type Attempt =
  | { kind: "paired"; token: string }
  | { kind: "wrong"; remaining: number }
  | { kind: "burned" };

export function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Crockford's own specification decodes `I` and `L` as `1` and `O` as `0`.
 * This used to DROP them, which is worse than either accepting or refusing
 * them: the input silently lost a character, failed the length check inside
 * `sameCode`, and came back as `wrong code, 4 attempts remaining` — spending
 * an attempt on the one confusion the alphabet was chosen to prevent, and
 * reissuing the code on screen after five.
 *
 * `U` is NOT here. It is excluded from the alphabet to avoid an accidental
 * obscenity, not for visual confusion, and there is no digit it means — so it
 * stays dropped, along with every other character that is not a code.
 */
const CONFUSABLE: Record<string, string | undefined> = { I: "1", L: "1", O: "0" };

/** The dash and the case are presentation. Anything else is dropped. */
export function normalise(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    const mapped = CONFUSABLE[ch] ?? ch;
    if (ALPHABET.includes(mapped)) out += mapped;
  }
  return out;
}

/**
 * Constant-time comparison of two codes.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length
 * through an exception — so a wrong-length input is compared against itself
 * and then reported false. The work is done either way.
 */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export interface PairingOptions {
  now?: () => number;
  /** Injected so a test can predict a code. Never used in production. */
  bytes?: (n: number) => Uint8Array;
}

/**
 * The live pairing code and the set of sessions it has minted.
 *
 * There is exactly ONE live code at a time, and there is ALWAYS one: `current()`
 * re-mints lazily once the TTL has passed rather than reporting an expiry. A
 * window with no code would mean an operator who wants to add a tablet on day
 * three has nothing to type, and expiry must never be a reason to tear the
 * tunnel down.
 *
 * Sessions are a plain `Set` with no expiry sweep and no revoke: the process
 * ending is the revoke, and it changes the tunnel's URL too, which is what is
 * actually wanted after a device is lost.
 */
export class Pairing {
  readonly #now: () => number;
  readonly #bytes: (n: number) => Uint8Array;
  readonly #sessions = new Set<string>();
  #code: LiveCode;
  #attempts = 0;

  constructor(opts: PairingOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#bytes = opts.bytes ?? ((n) => new Uint8Array(randomBytes(n)));
    this.#code = this.#mint();
  }

  #mint(): LiveCode {
    const raw = this.#bytes(CODE_LEN);
    let code = "";
    // Modulo bias over a 32-symbol alphabet and a 256-value byte is nil:
    // 256 is a whole multiple of 32.
    for (const b of raw) code += ALPHABET[b % ALPHABET.length];
    this.#attempts = 0;
    return { code, expiresAt: this.#now() + CODE_TTL_MS };
  }

  current(): LiveCode {
    if (this.#now() > this.#code.expiresAt) this.#code = this.#mint();
    return this.#code;
  }

  reissue(): LiveCode {
    this.#code = this.#mint();
    return this.#code;
  }

  attempt(input: string): Attempt {
    const live = this.current();
    if (sameCode(normalise(input), live.code)) {
      const token = Buffer.from(this.#bytes(32)).toString("base64url");
      this.#sessions.add(token);
      return { kind: "paired", token };
    }
    this.#attempts += 1;
    if (this.#attempts >= MAX_ATTEMPTS) {
      this.reissue();
      return { kind: "burned" };
    }
    return { kind: "wrong", remaining: MAX_ATTEMPTS - this.#attempts };
  }

  has(token: string): boolean {
    return token !== "" && this.#sessions.has(token);
  }

  get pairedCount(): number {
    return this.#sessions.size;
  }
}

/**
 * What a pairing attempt means, without a framework around it.
 *
 * Extracted because two listeners must answer a code the SAME way: the app's
 * `/pair` route, and an attached tunnel's listener, which serves no app at all
 * and would otherwise need a transcribed copy of these three outcomes. A
 * refusal that differs between the two modes — a different status, a different
 * sentence, a different attempt count — is the divergence this project keeps
 * finding wherever one rendering was copied.
 *
 * Returns data, never a `Response`: one caller shapes it through Hono and the
 * other through `Bun.serve`.
 */
/** What `Pairing.attempt` answers. Named so `pairOutcome` can be typed against
 *  it without depending on the class that produces it. */
export type PairAttempt =
  | { kind: "paired"; token: string }
  | { kind: "wrong"; remaining: number }
  | { kind: "burned" };

export function pairOutcome(
  code: unknown,
  /** Structural, not the class: `routes.ts` is handed a `deps.pairing` shaped
   *  like this rather than the concrete `Pairing`, and narrowing to the one
   *  method used keeps both callers and every test fake valid. */
  pairing: { attempt(code: string): PairAttempt },
): {
  status: number;
  body: { ok: boolean; detail?: string };
  /** Present only on success — the caller sets it as `set-cookie`. */
  token?: string;
} {
  if (typeof code !== "string") {
    return { status: 400, body: { ok: false, detail: "code must be a string" } };
  }
  const r = pairing.attempt(code);
  if (r.kind === "paired") return { status: 200, body: { ok: true }, token: r.token };
  if (r.kind === "burned") {
    return {
      status: 429,
      body: { ok: false, detail: "too many attempts — a new code is on the terminal" },
    };
  }
  return {
    status: 400,
    body: { ok: false, detail: `that code is not right — ${r.remaining} attempts left` },
  };
}
