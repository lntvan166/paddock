import type {
  ActionResult, AgentCommand, CloseSpaceResult, CloseTabResult, CreateSpaceResult, CreateTabResult,
  HarnessesResult, HistoryResult, KeyResult, NavKey, OutputResult,
  PaneOutput, ParsedPrompt, RenderMode, SpaceTree, StartAgentResult,
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

/** A tab id is `w1:t2` — same colon, same need to encode it. */
const tabUrl = (id: string, action: string) => `/api/tabs/${encodeURIComponent(id)}/${action}`;

/**
 * A space id (herdr's `workspace_id`) — encoded because it is OPAQUE, not
 * because it contains a colon.
 *
 * It does not. Every workspace id measured is colon-free (`w1`, `w1S` — see
 * `docs/probes/2026-08-25-structural-events.md`); the colon appears only where
 * herdr composes a workspace id with a tab or pane suffix. This said "contains
 * a colon too", which was false, and a false reason is worse than none: the
 * next reader checks it, finds no colon, and concludes the encoding is
 * unnecessary. It is not — nothing measured constrains a workspace id's
 * charset, so paddock does not get to assume one is URL-safe.
 */
const spaceUrl = (id: string, action: string) => `/api/spaces/${encodeURIComponent(id)}/${action}`;

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

/**
 * The commands this agent's project declares, for the reply field's
 * autocomplete.
 *
 * Fetched ONCE per agent rather than per keystroke, and filtered locally by
 * `web/commands.ts`: a project declares a handful of commands, so the whole
 * list is smaller than the round trip that would fetch a filtered one — and a
 * request per character would put the network between a thumb and a list on
 * exactly the link paddock exists to work over.
 *
 * A POST with an empty body, like `fetchPaneOutput` above and for its reason.
 */
/**
 * Exchange a path for an id, so the viewer has a plain GET to point an iframe
 * and a download link at.
 *
 * The path travels in a POST body because a path in a URL lands in an edge
 * access log — the same rule every other action here follows, for the same
 * reason. What comes back is the id, the file's own name for a title, and how
 * it should be rendered, so opening costs one round trip rather than two.
 */
export async function openFile(
  path: string,
  f: Fetch = fetch,
): Promise<{ id: string; name: string; render: RenderMode }> {
  const body = await readJson<{
    ok?: boolean; detail?: string; id?: string; name?: string; render?: RenderMode;
  }>("/api/files", { path }, f);

  // Checked in the BODY as well as the status, like `uploadImage` and for the
  // same reason: `readJson` rejects on a non-2xx, and a 200 whose body says
  // `ok: false` would otherwise resolve with `id: undefined` — navigating the
  // operator to `#/file/undefined`, a broken screen produced by trusting a
  // reply that had already said no.
  if (body.ok === false || typeof body.id !== "string" || typeof body.name !== "string") {
    throw new RequestFailed(200, body.detail ?? "could not open that file");
  }
  return { id: body.id, name: body.name, render: body.render ?? "download" };
}

/**
 * What a file is, for a viewer that has only an id — after a reload, that is
 * all it has.
 */
export async function fetchFileMeta(
  id: string,
  f: Fetch = fetch,
): Promise<{ name: string; render: RenderMode }> {
  // `Fetch` takes an explicit init — the stub in tests is typed that way, so a
  // one-argument call would compile against `fetch` and not against the seam.
  const res = await f(fileMetaUrl(id), { method: "GET" });
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new RequestFailed(res.status, detail ?? "unknown file");
  }
  return (await res.json()) as { name: string; render: RenderMode };
}

/** The bytes, the bytes as an attachment, and the metadata. Id only: a path
 *  here is what the id exists to avoid. */
export const fileUrl = (id: string) => `/api/files/${id}`;
export const fileDownloadUrl = (id: string) => `/api/files/${id}/download`;
export const fileMetaUrl = (id: string) => `/api/files/${id}/meta`;

/**
 * Attach one image, and get back the path an agent can open.
 *
 * A RAW body, not JSON and not multipart: there is exactly one field, and
 * base64 inside JSON would inflate a phone photo by a third for nothing. The
 * server sniffs the type from the bytes, so the `content-type` here is a
 * courtesy rather than something it trusts.
 *
 * Rejects with the server's own `detail` on refusal — the wrong file type, or
 * one too large — so the caller can put that sentence in front of the operator
 * verbatim rather than inventing one.
 */
export async function uploadImage(
  id: string,
  file: Blob,
  f: Fetch = fetch,
): Promise<{ path: string; name: string }> {
  const res = await f(url(id, "image"), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new RequestFailed(res.status, detail ?? `upload failed: ${res.status}`);
  }

  // Checked in the BODY too, unlike every other read here — which trust the
  // status and say so. The difference is the consequence: a false success on
  // this route hands the operator a path to a file that was never written, and
  // they then tell an agent to open it. A wrong screen is recoverable; a
  // confident wrong path is the mislabelled control this project bans.
  const body = (await res.json()) as { ok?: boolean; detail?: string; path?: string; name?: string };
  if (body.ok === false || typeof body.path !== "string" || typeof body.name !== "string") {
    throw new RequestFailed(res.status, body.detail ?? "upload failed");
  }
  return { path: body.path, name: body.name };
}

export async function fetchCommands(
  id: string,
  f: Fetch = fetch,
): Promise<{ commands: AgentCommand[] }> {
  return readJson<{ commands: AgentCommand[] }>(url(id, "commands"), {}, f);
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

/**
 * Rename an agent, or clear its name with `name: null` — the one real clear
 * (§7.2, §17): herdr removes the field rather than storing an empty string.
 *
 * `name` has no default and no nullish-stripping in between: `null` must
 * reach the wire as the JSON literal `null`, not be coerced to `undefined`
 * and silently dropped from the body, which would turn the clear into a
 * no-op the operator would have no way to notice.
 *
 * Uses `readJson`, not the `act()` convention `answerWithKey` etc. use below:
 * a rename's refusal (unknown agent, an over-length or blank name) must
 * reject with the server's `detail` for the caller to render, per
 * `readJson`'s own note on why a non-2xx must not resolve with a value
 * shaped like success.
 */
export async function renameAgent(
  id: string, name: string | null, f: Fetch = fetch,
): Promise<ActionResult> {
  return readJson<ActionResult>(url(id, "name"), { name }, f);
}

/** Rename a tab. `label` is forwarded verbatim; the server refuses an empty
 *  or whitespace-only one (§17) rather than paddock re-checking that here. */
export async function renameTab(id: string, label: string, f: Fetch = fetch): Promise<ActionResult> {
  return readJson<ActionResult>(tabUrl(id, "name"), { label }, f);
}

/** Rename a space. Same shape as `renameTab`, for the same reasons. */
export async function renameSpace(id: string, label: string, f: Fetch = fetch): Promise<ActionResult> {
  return readJson<ActionResult>(spaceUrl(id, "name"), { label }, f);
}

/**
 * Close a tab — and every pane, and every agent, it holds. paddock's first
 * destructive action (design doc §10); the arm-then-confirm interaction and
 * its consequence line are a UI concern built on top of this call, not
 * inside it.
 *
 * No body: closing takes no parameter beyond the id already in the path, so
 * an empty object is sent, the same as the other bodyless POSTs in this file
 * (`fetchPrompt`, `acknowledge`).
 *
 * The success body is `{ok, tabId, label, paneCount}` — what the route
 * already knew about the tab from the tree read that validated the id, so
 * the caller can say what closed without a second round trip. A refusal
 * (unknown id, or herdr declining) rejects with the server's `detail`, same
 * as every other read here.
 */
export async function closeTab(id: string, f: Fetch = fetch): Promise<CloseTabResult> {
  return readJson<CloseTabResult>(tabUrl(id, "close"), {}, f);
}

/**
 * Close a space — every tab, every pane, every agent any of them held. Same
 * shape as `closeTab` above, and for the same reasons: no body, and a
 * success response (`{ok, spaceId, label, tabCount, paneCount}`) built from
 * the tree read that already validated the id.
 */
export async function closeSpace(id: string, f: Fetch = fetch): Promise<CloseSpaceResult> {
  return readJson<CloseSpaceResult>(spaceUrl(id, "close"), {}, f);
}

/**
 * Create a space (herdr's workspace). `label`/`cwd` are both optional — an
 * absent or blank label is not a client concern to guard against here, the
 * server treats it as "let herdr pick its own default" rather than an
 * error (unlike rename, where the label being replaced already exists).
 *
 * Uses `readJson`, same as `closeTab`/`closeSpace`: a refusal (an
 * over-length label/cwd, or herdr declining) rejects with the server's
 * `detail` for the caller to render.
 */
export async function createSpace(
  opts: { label?: string; cwd?: string } = {}, f: Fetch = fetch,
): Promise<CreateSpaceResult> {
  return readJson<CreateSpaceResult>("/api/spaces", opts, f);
}

/** Create a tab in an existing space. Same shape as `createSpace`, one
 *  level down. */
export async function createTab(
  spaceId: string, opts: { label?: string; cwd?: string } = {}, f: Fetch = fetch,
): Promise<CreateTabResult> {
  return readJson<CreateTabResult>(spaceUrl(spaceId, "tabs"), opts, f);
}

/**
 * Start a coding agent in an existing pane. `name` is REQUIRED — the server
 * refuses an absent, empty, or whitespace-only one with 400, the same shape
 * a rename label uses; the create sheet pre-fills it from the space's own
 * label (herdr's own naming convention, §14.7) rather than this client
 * guessing a default.
 *
 * A REJECTED response here does not mean nothing happened — the pane the
 * operator is looking at is real either way, and the server's `detail`
 * says so explicitly when only the agent failed to start (mirrors
 * `sendPaneText`'s "typed, but not run").
 */
export async function startAgent(
  paneId: string, kind: string, name: string, args?: string[], f: Fetch = fetch,
): Promise<StartAgentResult> {
  return readJson<StartAgentResult>(paneUrl(paneId, "agent"), { kind, name, args }, f);
}

/**
 * The harness kinds this machine actually has installed, for the create
 * sheet's picker. A GET with no body, same reasoning as `fetchSpaceTree`:
 * there is no payload to keep out of an access log, and a non-2xx response
 * rejects rather than resolving with a value shaped like success.
 */
export async function fetchHarnessKinds(f: Fetch = fetch): Promise<HarnessesResult> {
  const res = await f("/api/harnesses", { method: "GET" });
  if (!res.ok) {
    const detail = await detailFrom(res);
    throw new RequestFailed(res.status, detail ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as HarnessesResult;
}

/**
 * Register this browser for push. The endpoint and keys come straight from
 * `PushSubscription.toJSON()`; the server validates their shapes before storing
 * one, because a malformed subscription fails hours later at send time.
 */
export async function subscribePush(sub: PushSubscriptionJSON, f: Fetch = fetch): Promise<void> {
  const res = await request("/api/push/subscribe", {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys?.p256dh, auth: sub.keys?.auth },
  }, f);
  if (!res.ok) throw new Error(`subscribe failed (HTTP ${res.status})`);
}

/**
 * Turn the server-wide push switch on.
 *
 * Separate from `subscribePush` because they are separate facts: a
 * subscription says WHERE a notification can go, and `push.enabled` says
 * whether paddock may send one at all. `index.ts` gates every send on the
 * second, and nothing set it — so a device could subscribe, the settings page
 * could report it subscribed, and no notification could ever arrive.
 *
 * Called from the enable flow rather than from the subscribe ROUTE, because
 * the design is explicit that subscriptions arrive through their own routes
 * and settings change through the settings patch. This keeps that line intact.
 */
export async function setPushEnabled(enabled: boolean, f: Fetch = fetch): Promise<void> {
  const res = await f("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ push: { enabled } }),
  });
  if (!res.ok) throw new Error(`could not turn push on (HTTP ${res.status})`);
}

export async function unsubscribePush(endpoint: string, f: Fetch = fetch): Promise<void> {
  const res = await request("/api/push/unsubscribe", { endpoint }, f);
  if (!res.ok) throw new Error(`unsubscribe failed (HTTP ${res.status})`);
}
