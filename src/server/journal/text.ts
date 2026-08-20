import type { JournalEntry } from "@server/journal/types";

/** Ceiling on one turn's prose. Generous for a message, bounded on the wire. */
export const MAX_TEXT_CHARS = 4_000;

/** Ceiling on a tool summary line. Orientation, never a transcript. */
const MAX_TOOL_HINT = 80;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|./g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * A digit-numbered option row, cursor optional: "1. Yes", "❯ 2. No",
 * "1) Yes", "> 3) No, keep it". `>` is treated the same as `❯` — the glyph
 * is not universal and ASCII `>` is at least as common a cursor marker.
 *
 * No length cap on the label: length must never decide whether a row is an
 * option, or a long real option (e.g. "❯ 1. Yes, and also run the full
 * regression suite before merging") would survive whole.
 */
const DIGIT_OPTION_RE = /^\s*(?:[❯>]\s*)?\d+[.)]\s+\S.*$/;

/**
 * A lettered option row, cursor REQUIRED: "❯ a. Yes". Without a cursor, a
 * bare "a. done" is too easily real prose — over-stripping is the worse
 * failure than the one this guards, so a lettered row only counts as an
 * option when a cursor marks it as selected.
 */
const CURSOR_LETTER_OPTION_RE = /^\s*[❯>]\s*[A-Za-z][.)]\s+\S.*$/;

function isOptionRow(line: string): boolean {
  return DIGIT_OPTION_RE.test(line) || CURSOR_LETTER_OPTION_RE.test(line);
}

/**
 * Remove option rows from journal text, dropped line by line, leaving "" if
 * every line was one.
 *
 * WHY LINE BY LINE: a real prompt is a question plus two or more option
 * lines, not one bare option line on its own. Matching the anchored pattern
 * against the WHOLE turn text only ever fires on that single-line toy case;
 * a real multi-line menu — "Do you want to proceed?\n❯ 1. Yes\n  2. No" —
 * would sail through unchanged. Splitting into lines and dropping only the
 * ones shaped like options is what strips the menu down to its question.
 *
 * WHY a bare cursor on non-option text is KEPT, not stripped: journal lines
 * are blended directly above the live screen with no divider (design
 * decision 3), and a menu from an already-answered question reading as the
 * live prompt is the specific failure `prompt-parse.ts` already records. But
 * a cursor glyph sitting on ordinary prose — "❯ npm install" quoted in a
 * message — is not that hazard, and deleting it would silently eat real
 * content, which is the worse failure this function exists to avoid.
 */
export function stripMenu(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isOptionRow(line))
    .join("\n");
}

/**
 * The block elements Claude Code INJECTS into a `user` record's string
 * content. Not typed by anyone.
 *
 * WHY THIS EXISTS. `claude.ts` used to serve any `user` record whose content
 * was a string, on the rule "a STRING is a person typing". That rule is
 * insufficient, and the gap is measured rather than suspected: across the
 * three largest session logs on the development machine, 733 such records
 * would have been served, of which 176 carried a `<result>…</result>` body
 * (subagent and tool result text) and 180 carried
 * `<task-notification>`/`<output-file>` blocks. Design decision 4 promises
 * prose only and tool RESULTS never, so those bodies must not reach the wire.
 *
 * This also closes the `isSidechain` gap that was previously deferred:
 * `isSidechain` is a TOP-LEVEL flag, and a `<result>` block is precisely how a
 * subagent's output reappears in a record whose top level is not marked at
 * all. Dropping the block drops the sidechain traffic with it.
 *
 * STRIP, NOT DROP THE WHOLE RECORD, and the asymmetry is the point: a record
 * that is ONLY an injected block has nothing left worth showing and is dropped
 * by the caller once stripping empties it, while a record that is a real typed
 * message with a block appended — the ordinary shape, since the harness
 * appends its notifications to whatever the operator said — is still worth
 * showing minus the block. Dropping wholesale would silently delete real
 * messages; stripping alone would leave empty speaker rows. Doing both is what
 * serves prose and only prose.
 */
const INJECTED_BLOCKS = [
  "result",
  "task-notification",
  "output-file",
  "system-reminder",
  "local-command-stdout",
  "command-name",
  "command-message",
  "command-args",
] as const;

/**
 * Remove every injected block from a record's text, leaving only prose.
 *
 * Three passes, and each one is deliberately biased toward removing too much
 * rather than too little — this is an EXPOSURE guard, so the failure it must
 * never have is content escaping:
 *
 *  1. Balanced `<tag>…</tag>` pairs, non-greedy, so two blocks of the same
 *     name do not swallow the prose between them.
 *  2. An OPENING tag with no close: everything from it to the end of the
 *     record goes. A truncated block is still block content, and keeping the
 *     tail because the harness did not close its own tag would leak exactly
 *     the bodies pass 1 exists to remove.
 *  3. A CLOSING tag with no open: everything from the start of the record up
 *     to and including it goes, for the mirror reason — that text was inside
 *     the block.
 *
 * Passes 2 and 3 can, in principle, eat real prose from someone who typed a
 * bare `</result>` into a message. That is accepted: the cost is a message the
 * operator can still read on the live screen, and the alternative cost is
 * command output on a phone screen with no authentication in front of it.
 */
export function stripInjected(text: string): string {
  let out = text;
  for (const tag of INJECTED_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
  }
  for (const tag of INJECTED_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, "i"), "");
    out = out.replace(new RegExp(`^[\\s\\S]*</${tag}\\s*>`, "i"), "");
  }
  return stripMachineElements(out);
}

/**
 * Any element whose tag name is MACHINE-SHAPED, and everything under it.
 *
 * The named list above is a list, and a list only ever covers injectors
 * somebody has already seen. Hooks, plugins and future harness versions all
 * write into this same `user` string field with tag vocabularies of their own,
 * so a rule is needed as well as a list.
 *
 * The rule is the tag NAME. Harness and hook injections name their blocks in
 * `kebab-case` or `snake_case` — `<task-notification>`, `<local-command-stdout>`,
 * `<observed_from_primary_session>` — while the markup that turns up in a message
 * a PERSON wrote is HTML or JSX, whose element names are a single lowercase word
 * or PascalCase: `<div>`, `<span>`, `<button>`, `<AgentRow>`. So an element name
 * containing a `-` or `_` is treated as injected, and no other element is
 * touched.
 *
 * Measured on the three largest session logs on the development machine, after
 * the named blocks were stripped: 357 of the 550 surviving records still OPENED
 * with such an element and a further 87 carried one appended after genuinely
 * typed prose — every one of them containing an absolute home path — while no
 * record whose markup was human-written used a name of this shape at all. With
 * this rule in place, no served `user` record on those logs contains an
 * injected element of any kind.
 *
 * THE FALSE POSITIVE IS NAMED RATHER THAN DENIED. A message quoting a real
 * custom element or framework tag — `<router-view>`, `<ng-content>`, a web
 * component — loses that element and its body. That is a piece of one typed
 * message, still readable on the live screen; the alternative is command
 * output and file contents on a route with no authentication in front of it
 * (decision 3), which decision 4 says must never happen. When those two trade
 * off, the exposure side wins.
 */
const MACHINE_NAME = "[a-zA-Z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)+";

function stripMachineElements(text: string): string {
  let out = text;
  // Balanced pairs, to a fixed point: an outer wrapper consumes its children
  // in one pass, but a child whose parent was never closed only becomes
  // matchable once the text around it has settled.
  for (;;) {
    const next = out.replace(
      new RegExp(`<(${MACHINE_NAME})(?:\\s[^>]*?)?>[\\s\\S]*?</\\1\\s*>`, "g"),
      "",
    );
    if (next === out) break;
    out = next;
  }
  out = out.replace(new RegExp(`<${MACHINE_NAME}(?:\\s[^>]*?)?/>`, "g"), "");
  // An opener with no close: the rest of the record is its body. Same
  // reasoning as pass 2 above — a truncated block is still block content.
  out = out.replace(new RegExp(`<${MACHINE_NAME}(?:\\s[^>]*?)?>[\\s\\S]*$`, ""), "");
  return out;
}

/**
 * Truncate to AT MOST `max` characters, ellipsis included, so a cut is never
 * mistaken for the end and a caller's cap is never off by one.
 */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** One tool call, before it is summarised. */
export interface ToolCall {
  name: string;
  input: unknown;
}

/**
 * One line for a tool call: its name, and a short hint at what it touched.
 *
 * Never its RESULT. Tool results are where file contents, command output and
 * any secret that passed through the agent live, and design decision 4 keeps
 * them off the wire entirely.
 *
 * The hint comes from a SHORT ALLOW-LIST of input fields, never from whatever
 * the input happens to hold. `pattern` used to be on that list and has been
 * removed deliberately: a search pattern is operator-supplied text that
 * routinely embeds the very thing being searched for — an API key, a token, a
 * hostname — so serving it serves a secret under the name of a hint. A `Grep`
 * therefore renders as a bare `Grep`. Orientation is the whole job of this
 * line; "which tool ran" delivers it, and decision 4 does not trade that for
 * "on what".
 */
export function summariseTool(name: string, input: unknown): string {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const raw =
    typeof obj.description === "string" ? obj.description
    : typeof obj.file_path === "string" ? obj.file_path.split("/").pop() ?? ""
    : "";
  const hint = stripAnsi(raw).replace(/\s+/g, " ").trim();
  // Clamped on the FINISHED line, not on the hint, so the cap holds whatever
  // the tool name's length happens to be.
  return clamp(hint === "" ? name : `${name} · ${hint}`, MAX_TOOL_HINT);
}

/**
 * Summarise a turn's tool calls, collapsing a RUN of the same tool into one
 * `Name ×N` token.
 *
 * `src/shared/types.ts` and the design's §4 both promise `▸ Bash ×3 · Read
 * timer.ts`, and nothing aggregated: three `Bash` calls rendered as
 * `Bash · x · Bash · y · Bash · z`, which is the promise being false and also
 * the longest possible line on the narrowest possible screen.
 *
 * A run, not a total: the tokens stay in the order the agent called them, so
 * the line still reads as a sequence of what happened rather than a
 * frequency table. A collapsed run drops its hints on purpose — three Bash
 * calls have three different ones, and showing only the first would claim the
 * run was about that one thing.
 */
export function summariseTools(calls: readonly ToolCall[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < calls.length; ) {
    const name = calls[i]!.name;
    let n = 1;
    while (i + n < calls.length && calls[i + n]!.name === name) n++;
    out.push(n === 1 ? summariseTool(name, calls[i]!.input) : `${name} ×${n}`);
    i += n;
  }
  return out;
}

/**
 * `13:04` from an ISO stamp, or "" when the record carried none.
 *
 * The HOST's local time, not UTC. These lines sit inches above the live screen
 * on a phone, and that screen shows whatever clock the agent's own terminal
 * printed — local. Two clocks an inch apart, differing by the machine's UTC
 * offset, is a reader silently mis-ordering their own session. The journal
 * stamp is ISO with an offset, so converting is exact; rendering `getUTCHours`
 * was simply the wrong half of that conversion.
 */
function hhmm(at: string | null): string {
  if (at === null) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Flatten turns to the lines the terminal renders.
 *
 * Server-side, because the client must gain no per-harness knowledge — the same
 * reason `parsePrompt` lives on this side of the socket.
 */
export function toLines(entries: readonly JournalEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const body = clamp(stripMenu(stripAnsi(e.text)).trim(), MAX_TEXT_CHARS);
    if (body === "" && e.tools.length === 0) continue;
    const who = e.role === "user" ? "you" : "agent";
    const time = hhmm(e.at);
    out.push(time === "" ? who : `${who} · ${time}`);
    if (e.tools.length > 0) out.push(`▸ ${e.tools.join(" · ")}`);
    if (body !== "") out.push(...body.split("\n"));
    out.push("");
  }
  return out;
}
