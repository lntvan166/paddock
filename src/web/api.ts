import type {
  ActionResult, HistoryResult, KeyResult, NavKey, OutputResult, PaneOutput, ParsedPrompt,
  SpaceTree,
} from "@shared/types";

/**
 * Just the call signature these helpers use — not `typeof fetch`.
 *
 * `typeof fetch` drags in runtime-specific extras (Bun adds `preconnect`),
 * which a test stub cannot satisfy, which is what pushed every call site into
 * `as any` — and a cast in a test disables the checking the test exists for.
 * Exported so tests share this contract rather than redeclaring it.
 */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Agent ids contain a colon (`w1:p1`), so they must be encoded. */
const url = (id: string, action: string) => `/api/agents/${encodeURIComponent(id)}/${action}`;

/** The pane route's own URL, encoded the same way — a pane id is the same
 *  string as an agent id, just addressed through `/api/panes/` instead. */
const paneUrl = (id: string, action: string) => `/api/panes/${encodeURIComponent(id)}/${action}`;

async function request(path: string, body: object, f: Fetch): Promise<Response> {
  return f(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A read the server REFUSED, carrying the status it refused with.
 *
 * An `Error` subclass rather than a second return shape, so every existing
 * `catch` and every `rejects.toThrow(/detail/)` keeps working unchanged. The
 * status is on it because one caller genuinely needs to tell refusals apart:
 * `409` from the pane route means "this pane has an agent now", which is a
 * transition rather than a failure — see `PaneTerminal`'s opening read. A
 * caller that does not care still gets the server's own message.
 */
export class RequestFailed extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestFailed";
    this.status = status;
  }
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
 * Reads must resolve with a value whose type is honest for the non-2xx case:
 * a non-2xx response (e.g. `{ ok: false, detail: "unknown agent" }` on a 404)
 * is valid JSON but has no `lines`/`options` — resolving with it would hand
 * the caller an object TypeScript believes matches the shape but doesn't. So
 * a non-2xx status rejects instead, carrying the server's `detail` in the
 * message when there is one. This does not make a 200 body honest on its
 * own — a malformed 200 response would still resolve with e.g. `lines`
 * undefined, since nothing here validates the body's shape once the status
 * check passes.
 */
async function readJson<T>(path: string, body: object, f: Fetch): Promise<T> {
  const res = await request(path, body, f);
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new RequestFailed(res.status, detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * `scrollback` defaults to false so the first paint is the cheap read.
 * Requesting history costs a herdr pane-scroll (~35 ms per line past the
 * viewport), which belongs after something is already on screen, not before.
 */
export async function fetchOutput(
  id: string, lines?: number, scrollback = false, since?: string | null, f: Fetch = fetch,
) {
  return readJson<OutputResult>(
    url(id, "output"), { lines, scrollback, since: since ?? undefined }, f,
  );
}

/**
 * The screen of a pane that has NO agent.
 *
 * Its own route, and its own function, because the store cannot validate the
 * id: a shell pane is deliberately absent from it (§3), so the server checks
 * the session tree instead. Nothing else differs — same POST-only rule (a
 * payload in a query string lands in edge access logs, even an empty one's
 * path does not need to be a second shape), and the same rejection on non-2xx
 * that every read here uses, so an unknown or already-promoted pane arrives as
 * a message the terminal can show rather than as a value shaped like a screen.
 */
export async function fetchPaneOutput(id: string, f: Fetch = fetch): Promise<PaneOutput> {
  return readJson<PaneOutput>(paneUrl(id, "output"), {}, f);
}

export async function fetchPrompt(id: string, f: Fetch = fetch) {
  return readJson<ParsedPrompt>(url(id, "prompt"), {}, f);
}

/**
 * Earlier history from the agent's own session log.
 *
 * `before` is the OPAQUE cursor from a previous response's `cursor`, echoed
 * back verbatim — never constructed here — or `null` for the newest page.
 * `limit` counts TURNS, not lines; see `JOURNAL_PAGE_TURNS` in
 * `AgentTerminal.tsx` for why that unit — and that page size — differs from
 * the reconstructed-scrollback path's `HISTORY_PAGE`.
 *
 * A non-2xx response (unknown agent, malformed cursor) rejects, same as
 * every other read — see `readJson`'s note on why a failure must not resolve
 * with a value shaped like success.
 */
export async function fetchHistory(
  id: string, before: string | null, limit: number, f: Fetch = fetch,
): Promise<HistoryResult> {
  return readJson<HistoryResult>(url(id, "history"), { before, limit }, f);
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

/**
 * Send a navigation key and take back the screen it produced.
 *
 * Uses the action convention, not the read convention: a rejected key is a
 * normal outcome the operator should see reported next to the keypad, not an
 * exception that tears down the terminal view they are working in. `lines`
 * defaults to empty on failure so the caller can render the result without a
 * shape check, and callers must therefore branch on `ok` before replacing the
 * screen — an empty `lines` on a failed key means "no new screen", never "the
 * pane is empty".
 */
export async function sendKey(id: string, key: NavKey, f: Fetch = fetch): Promise<KeyResult> {
  try {
    const res = await request(url(id, "key"), { key }, f);
    return (await res.json()) as KeyResult;
  } catch (err) {
    return { ok: false, detail: String(err), lines: [], source: "" };
  }
}

/**
 * Type into the terminal, in any state.
 *
 * Distinct from `answerWithText`, which answers a PROMPT and is refused with a
 * 409 once the agent stops being blocked. Pointing the terminal's reply box at
 * `/answer` is what made it fail in three states out of four.
 */
export async function sendText(id: string, text: string, f: Fetch = fetch): Promise<KeyResult> {
  try {
    const res = await request(url(id, "text"), { text }, f);
    return (await res.json()) as KeyResult;
  } catch (err) {
    return { ok: false, detail: String(err), lines: [], source: "" };
  }
}

/**
 * Type into a pane that has NO agent — the shell case §16.3 promised input
 * for and never got a route until now.
 *
 * `pane.send_text`, not `agent.prompt`: a shell is being typed AT, not
 * answering a question, and the pane's `harness` (null, here) is what
 * decides which verb applies. `AgentTerminal`'s `submitReply` is the mirror
 * image of this same asymmetry on the agent side.
 *
 * `submit` asks the route to press Enter after the text, in the same round
 * trip. It is the whole difference between typing a command and RUNNING one:
 * `pane.send_text` does not submit, so without this a tap on Send left `ls`
 * sitting unexecuted on the prompt line. The reply box passes `true`; the
 * parameter exists because typing without running is still a real thing to
 * want, and because a route that always submitted would change what every
 * earlier caller did.
 *
 * Uses `readJson`, unlike `sendText`/`sendKey` above: the pane route's whole
 * success body is `{ok: true}` (see `PaneOutput`'s note on why a shell has
 * no server-side screen cache to fold a reply into), so there is no partial
 * "resolve with a failure shape" to preserve. A refusal — unknown pane, a
 * pane promoted to an agent mid-type, text over the length ceiling, or the
 * half-landed `typed, but not run` — rejects with the server's own `detail`,
 * the same as every read here; the caller must catch it and show it, never
 * let a keystroke that did not land look like it did.
 */
export async function sendPaneText(
  id: string, text: string, submit = false, f: Fetch = fetch,
): Promise<ActionResult> {
  return readJson<ActionResult>(paneUrl(id, "text"), { text, submit }, f);
}

/**
 * One navigation key to a pane that has NO agent. Same `NavKey` allowlist and
 * the same rejection convention as `sendPaneText` above — see its note for
 * why this differs from the agent-side `sendKey`.
 */
export async function sendPaneKey(id: string, key: NavKey, f: Fetch = fetch): Promise<ActionResult> {
  return readJson<ActionResult>(paneUrl(id, "key"), { key }, f);
}

/**
 * The session tree. A GET with no body — the only read here that is not a
 * POST, because it has no payload to keep out of an access log.
 *
 * Rejects on non-2xx rather than resolving, for the reason `readJson`
 * records: a 404 body has no `spaces`, and resolving with it would hand the
 * caller an object TypeScript believes is a SpaceTree and isn't.
 */
export async function fetchSpaceTree(f: Fetch = fetch): Promise<SpaceTree> {
  const res = await f("/api/spaces", { method: "GET" });
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new RequestFailed(res.status, detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as SpaceTree;
}
