import { expect, test } from "bun:test";
import {
  ALPHABET, CODE_LEN, CODE_TTL_MS, MAX_ATTEMPTS,
  formatCode, normalise, Pairing,
} from "@server/tunnel/pairing";

/** Deterministic byte source: 0,1,2,... so the code is predictable. */
function counter(): (n: number) => Uint8Array {
  let i = 0;
  return (n) => Uint8Array.from({ length: n }, () => i++ % 256);
}

test("the alphabet excludes the four ambiguous letters", () => {
  for (const ch of "ILOU") expect(ALPHABET).not.toContain(ch);
  // Crockford base32 is 32 symbols; a shorter one silently loses entropy.
  expect(ALPHABET.length).toBe(32);
  expect(new Set(ALPHABET).size).toBe(32);
});

test("a code is CODE_LEN symbols from the alphabet, shown with a dash", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  expect(code).toHaveLength(CODE_LEN);
  for (const ch of code) expect(ALPHABET).toContain(ch);
  expect(formatCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
});

test("current() is stable until the TTL elapses, then re-mints", () => {
  let t = 0;
  const p = new Pairing({ now: () => t, bytes: counter() });
  const first = p.current().code;
  t += CODE_TTL_MS - 1;
  expect(p.current().code).toBe(first);
  t += 2;
  expect(p.current().code).not.toBe(first);
});

test("a code is always live — expiry never leaves us without one", () => {
  let t = 0;
  const p = new Pairing({ now: () => t, bytes: counter() });
  p.current();
  t += CODE_TTL_MS * 5;
  const { code, expiresAt } = p.current();
  expect(code).toHaveLength(CODE_LEN);
  expect(expiresAt).toBe(t + CODE_TTL_MS);
});

test("the right code pairs, and the token is then recognised", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  const r = p.attempt(code);
  expect(r.kind).toBe("paired");
  if (r.kind !== "paired") throw new Error("unreachable");
  expect(p.has(r.token)).toBe(true);
  expect(p.pairedCount).toBe(1);
});

test("the dash and the case are cosmetic", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const { code } = p.current();
  expect(p.attempt(formatCode(code).toLowerCase()).kind).toBe("paired");
});

test("normalise strips anything that is not an alphabet symbol", () => {
  expect(normalise(" 4f7k-qp2m\n")).toBe("4F7KQP2M");
});

test("a wrong code reports the attempts remaining and pairs nothing", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const r = p.attempt("00000000");
  expect(r).toEqual({ kind: "wrong", remaining: MAX_ATTEMPTS - 1 });
  expect(p.pairedCount).toBe(0);
});

test("MAX_ATTEMPTS wrong guesses burn the code and mint a new one", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const original = p.current().code;
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    expect(p.attempt("00000000").kind).toBe("wrong");
  }
  expect(p.attempt("00000000").kind).toBe("burned");
  expect(p.current().code).not.toBe(original);
  // The burned code must not still work.
  expect(p.attempt(original).kind).toBe("wrong");
  // ...and the fresh code must, with a full budget behind it.
  expect(p.attempt(p.current().code).kind).toBe("paired");
});

test("the attempt budget resets with each new code", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  for (let i = 0; i < MAX_ATTEMPTS; i++) p.attempt("00000000");
  const r = p.attempt("00000000");
  expect(r).toEqual({ kind: "wrong", remaining: MAX_ATTEMPTS - 1 });
});

test("reissue replaces the live code immediately", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const first = p.current().code;
  const next = p.reissue();
  expect(next.code).not.toBe(first);
  expect(p.current().code).toBe(next.code);
  expect(p.attempt(first).kind).toBe("wrong");
});

test("an unknown token is not a session, and a token is long", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  expect(p.has("")).toBe(false);
  expect(p.has("nope")).toBe(false);
  const r = p.attempt(p.current().code);
  if (r.kind !== "paired") throw new Error("unreachable");
  // 32 bytes, base64url — never shorter than the code it replaces.
  expect(r.token.length).toBeGreaterThanOrEqual(40);
  expect(r.token).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("two pairings are two sessions", () => {
  const p = new Pairing({ now: () => 0, bytes: counter() });
  const a = p.attempt(p.current().code);
  const b = p.attempt(p.current().code);
  if (a.kind !== "paired" || b.kind !== "paired") throw new Error("unreachable");
  expect(a.token).not.toBe(b.token);
  expect(p.pairedCount).toBe(2);
});
