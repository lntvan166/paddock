import type { ActionResult, ParsedPrompt } from "@shared/types";

type Fetch = typeof fetch;

/** Agent ids contain a colon (`w1:p1`), so they must be encoded. */
const url = (id: string, action: string) => `/api/agents/${encodeURIComponent(id)}/${action}`;

async function post<T>(path: string, body: object, f: Fetch): Promise<T> {
  const res = await f(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export async function fetchOutput(id: string, lines?: number, f: Fetch = fetch) {
  return post<{ lines: string[]; source: string }>(url(id, "output"), { lines }, f);
}

export async function fetchPrompt(id: string, f: Fetch = fetch) {
  return post<ParsedPrompt>(url(id, "prompt"), {}, f);
}

/**
 * Every action funnels failures into an ActionResult rather than throwing.
 * A refused answer ("someone answered at the desk first") is information the
 * operator needs on screen, not an exception that unmounts the sheet.
 */
async function act(path: string, body: object, f: Fetch): Promise<ActionResult> {
  try {
    return await post<ActionResult>(path, body, f);
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
