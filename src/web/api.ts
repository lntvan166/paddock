import type { ActionResult, ParsedPrompt } from "@shared/types";

type Fetch = typeof fetch;

/** Agent ids contain a colon (`w1:p1`), so they must be encoded. */
const url = (id: string, action: string) => `/api/agents/${encodeURIComponent(id)}/${action}`;

async function request(path: string, body: object, f: Fetch): Promise<Response> {
  return f(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pulls `detail` out of a JSON error body, if the body has one. */
async function detailFrom(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : null;
  } catch {
    return null;
  }
}

/**
 * Reads must resolve with a value whose type is honest: a non-2xx response
 * (e.g. `{ ok: false, detail: "unknown agent" }` on a 404) is valid JSON but
 * has no `lines`/`options` — resolving with it would hand the caller an
 * object TypeScript believes matches the shape but doesn't. So a non-2xx
 * status rejects instead, carrying the server's `detail` in the message
 * when there is one.
 */
async function readJson<T>(path: string, body: object, f: Fetch): Promise<T> {
  const res = await request(path, body, f);
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new Error(detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchOutput(id: string, lines?: number, f: Fetch = fetch) {
  return readJson<{ lines: string[]; source: string }>(url(id, "output"), { lines }, f);
}

export async function fetchPrompt(id: string, f: Fetch = fetch) {
  return readJson<ParsedPrompt>(url(id, "prompt"), {}, f);
}

/**
 * Every action funnels failures into an ActionResult rather than throwing.
 * A refused answer ("someone answered at the desk first") is information the
 * operator needs on screen, not an exception that unmounts the sheet. Unlike
 * reads, actions parse the body regardless of status — a 409 refusal is a
 * normal outcome carrying its own `detail`, not a failure to reject.
 */
async function act(path: string, body: object, f: Fetch): Promise<ActionResult> {
  try {
    const res = await request(path, body, f);
    return (await res.json()) as ActionResult;
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

export const answerWithKey = (id: string, key: string, f: Fetch = fetch) =>
  act(url(id, "answer"), { key }, f);

export const answerWithText = (id: string, text: string, f: Fetch = fetch) =>
  act(url(id, "answer"), { text }, f);

export const acknowledge = (id: string, f: Fetch = fetch) =>
  act(url(id, "ack"), {}, f);
