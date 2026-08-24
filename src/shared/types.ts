import type { ScreenPatch } from "@shared/screen";

export type NotifyTrigger = "blocked" | "done";

/** What GET /api/settings returns. The token is NEVER a member. */
export interface SettingsView {
  telegram: { configured: boolean; hint: string | null; chatId: string | null };
  notify: {
    enabled: boolean;
    triggers: NotifyTrigger[];
    /** Per trigger, how long the state must hold before a message is sent.
     *  0 fires on the edge, which is what v2 did unconditionally. */
    settleMs: Record<NotifyTrigger, number>;
    /** Epoch ms. Notifications are suppressed while `serverNow < mutedUntil`.
     *  An absolute instant rather than a schedule: it has no timezone to be
     *  misread by a phone in one zone and a server in another. */
    mutedUntil: number | null;
    cooldownMs: number;
  };
  publicUrl: string | null;
  /**
   * Non-null only while `paddock tunnel` is running. The UI renders its
   * "add a device" control from this, so `null` means the section is absent
   * rather than empty — a paddock served the ordinary way has no tunnel to
   * describe and must not offer to pair one.
   */
  tunnel: { url: string; pairedDevices: number } | null;
  /** The server's clock at the moment this view was built. The UI renders
   *  "muted until 07:14 (in 6h 22m)" from `mutedUntil`, and the phone's clock
   *  is not the server's — so the offset is computed from this, not Date.now(). */
  serverNow: number;
  /** Non-null when settings.json failed to load. Surfaced, never swallowed. */
  error: string | null;
}

export interface SettingsPatch {
  telegram?: { token?: string | null; chatId?: string | null };
  /** `mutedUntil` is deliberately absent: mute is POST /api/settings/mute, so
   *  the server stamps the instant from a client-supplied duration, and so
   *  that "applies immediately" is structural rather than a convention. */
  notify?: Partial<Omit<SettingsView["notify"], "mutedUntil">>;
  publicUrl?: string | null;
}

/** A Telegram inline keyboard. Declared in the shared contract because the
 *  notifier composes it and the transport serialises it. */
export interface InlineKeyboard {
  inline_keyboard: { text: string; url: string }[][];
}

export type AgentState = "blocked" | "done" | "working" | "idle";

export interface Agent {
  hostId: string;
  agentId: string;
  /** Operator-assigned name. The PRIMARY label. Never derived from cwd. */
  name: string;
  /** Live task line, from terminal_title_stripped. */
  task: string;
  state: AgentState;
  workspaceId: string;
  workspaceLabel: string | null;
  cwd: string;
  /**
   * The harness running in this pane — "claude", "codex" — as herdr reports it
   * in `HerdrAgentRaw.agent`.
   *
   * It was always on the wire. `toAgent` used it as a truthiness gate and threw
   * the value away, so the UI had no way to tell one harness from another.
   *
   * Required, not optional, on the same reasoning as `hasJournal`: an optional
   * field lets a future edit drop it silently, and every tile would fall back
   * to a placeholder with nothing to notice. Safe to require because `toAgent`
   * returns null for any raw agent whose `agent` is falsy — a surviving Agent
   * always had one.
   */
  harness: string;
  /** Epoch ms of the earliest moment paddock can vouch for this state. */
  stateSince: number;
  /**
   * Whether `stateSince` is the real transition, or only the moment paddock
   * started watching.
   *
   * herdr's `agent.list` row carries NO timestamp — `state_change_seq` and
   * `revision` are sequence numbers, not clocks — so an agent paddock meets for
   * the first time has an age paddock cannot know. `toAgent` stamps `ctx.now`
   * because that is the only defensible floor, and the consequence was a screen
   * that lied: five agents idle for days all read `1h` because that is how long
   * paddock had been up, and every one of them shared the identical
   * `stateSince` to the millisecond.
   *
   * False means "at least this long", and the UI says so with a `+`. True means
   * paddock saw the transition, via `pane.agent_status_changed` or a reconcile
   * that caught the change, and the number is the real one.
   *
   * Required, not optional, for the reason `harness` gives: optional lets a
   * future edit drop it silently, and the failure mode is a number that reads
   * as fact when it is a floor.
   */
  stateSinceExact: boolean;
  updatedAt: number;
  /**
   * Epoch ms when the operator dismissed this agent's `done` from paddock,
   * or null.
   *
   * herdr derives `done` from idle-plus-*unseen*, and reading over the socket
   * does not clear it — so without this, finished agents accumulate in Needs
   * you and can never be cleared from a phone. This flag is paddock's own:
   * herdr's `done` stays true, paddock just stops surfacing it.
   */
  acknowledgedAt: number | null;
  /**
   * Whether paddock can read this agent's own session log, which decides
   * WHICH history source the terminal view uses (see
   * `docs/design/2026-08-20-journal-history-design.md`).
   *
   * A boolean and nothing more, deliberately. The session id it is derived
   * from is a filesystem key that stays on the server: the UI's only question
   * is "fetch, or use my local reconstruction?".
   *
   * Required, not optional — an optional field lets a future edit drop it
   * silently, and the terminal would fall back to reconstruction for every
   * agent with nothing to notice.
   */
  hasJournal: boolean;
}

/**
 * The one rule for carrying `acknowledgedAt` across a state update: preserved
 * while the agent is still `done`, cleared the moment it is not.
 *
 * Used on BOTH paths that can move an agent's state — the 30s reconcile
 * (`AgentStore.replaceAll`) and the real-time push event
 * (`applyStatusEvent`) — for the same reason `compareAgents` and `sectionFor`
 * are each a single function: two copies of a state rule are free to drift,
 * and push is the PRIMARY path here, not reconcile. A rule that only lived on
 * the healing (reconcile) side would leave any agent whose run is shorter
 * than the reconcile interval to slip through: acknowledge → done leaves via
 * a push event → done returns via a push event, all without an intervening
 * reconcile, and a stale flag would permanently suppress every future finish
 * for that agent.
 */
export function carryAcknowledged(prev: Agent, nextState: AgentState): number | null {
  return nextState === "done" ? prev.acknowledgedAt : null;
}

export interface PromptOption {
  /** The option's text EXACTLY as the agent rendered it. Never rewritten. */
  label: string;
  /** The key to send via agent.send_keys — the option's digit. */
  key: string;
  /** True when the agent's `❯` cursor sits on this option. */
  selected: boolean;
}

export interface ParsedPrompt {
  /** The question line, e.g. "Do you want to proceed?". Null when not found. */
  question: string | null;
  /**
   * The parsed options, or null when the snapshot could not be parsed.
   *
   * null is an OUTCOME, not an error: the UI falls back to raw output plus a
   * free-text reply. A mislabelled Approve button is worse than no button.
   */
  options: PromptOption[] | null;
  /**
   * The line the agent's `❯` cursor sits on, marker stripped, or null.
   *
   * Reported INDEPENDENTLY of `options`, and that independence is the point.
   * The keypad's ↓ wraps from the last option back to the first, and the
   * middle option of a permission prompt is routinely a persistent grant
   * ("and don't ask again"), so one tap too many can commit a standing
   * permission. The wrap is not really the hazard — the wrap being invisible
   * is. Showing what Enter will commit removes it, and keeps working on
   * prompt shapes the option parser deliberately refuses to read.
   */
  selected: string | null;
  /** The snapshot as read. Always present, so the UI can always show something. */
  raw: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
}

/**
 * The keys the terminal view is allowed to send, as a CLOSED allowlist.
 *
 * These are navigation, not answers. An arrow key makes no claim about what
 * an option means — the operator reads the agent's real screen, watches the
 * agent's own `❯` cursor move, and commits with Enter. That is strictly more
 * faithful than a parsed button, and it is why this path works on prompt
 * shapes the parser cannot read (`options: null`) as well as ones it can.
 *
 * Closed on purpose. `agent.prompt` accepts arbitrary text and `send_keys`
 * accepts arbitrary control sequences, so the boundary is enforced here and
 * at the route rather than trusted to the UI: paddock still has no
 * general-purpose key-send endpoint. Every name below was verified accepted
 * by herdr 0.8.0 on a throwaway pane; `pageup`, `pagedown`, `home` and `end`
 * are rejected by herdr (`invalid_key`) and are therefore absent.
 */
export const NAV_KEYS = [
  "up", "down", "left", "right", "enter", "esc", "tab", "space", "backspace",
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(value: unknown): value is NavKey {
  return typeof value === "string" && (NAV_KEYS as readonly string[]).includes(value);
}

/**
 * A key press plus the screen it produced.
 *
 * The re-read is part of the response rather than a follow-up request because
 * the two are one interaction: pressing ↓ and seeing the cursor move is a
 * single act to the operator, and splitting it into two round trips over a
 * ~250 ms link is what would make navigation feel broken.
 */
export interface KeyResult extends ActionResult {
  lines: string[];
  source: string;
  /**
   * The cursor line after the key landed, so the "Enter will select" preview
   * tracks every ↓ without a second round trip. Null when no cursor is on
   * screen — which is the normal case for an agent that is not being asked
   * anything.
   */
  selected?: string | null;
}

/**
 * Earlier turns from the agent's own session log — the success body of
 * `POST /api/agents/:id/history`.
 *
 * `source: "reconstruction"` is not an error: it is the server saying "I have
 * no journal for this agent," and it always arrives with `lines: []` — the
 * caller falls back to its existing client-side reconstruction silently, the
 * same way it does today.
 *
 * `cursor` is OPAQUE. The client echoes it back as the next request's
 * `before` and never constructs one; the server refuses anything that is not
 * a run of digits with a 400.
 */
export interface HistoryResult {
  lines: string[];
  source: "journal" | "reconstruction";
  hasMore: boolean;
  cursor: string | null;
  detail: string | null;
}

/**
 * A read response, which may say "nothing changed" instead of resending.
 *
 * Measured on a live working agent: consecutive 3s polls differ by 3 lines out
 * of 63, so ~95% of a 10.8 KB response is bytes the client already has. The
 * client sends the digest of the screen it is holding; when it still matches,
 * the server answers `{ unchanged: true }` and no screen is transmitted.
 *
 * This is deliberately an application-level revalidation rather than an HTTP
 * `ETag`: these are POST routes (spec §12 — payloads must never reach a query
 * string, and a GET would put read parameters in edge access logs), and
 * browsers do not perform conditional revalidation on POST.
 */
export type OutputResult =
  | { unchanged: true }
  /**
   * Only the lines that moved. The common case by a wide margin: measured on
   * a live agent at 250ms, the MEDIAN changed update touched ONE line of 63,
   * because a thinking agent redraws only its spinner and token counter.
   * Sending the whole screen for that cost ~2052 B gzipped against ~211 B for
   * the lines alone — about 30 MB/hour versus 3.
   *
   * `digest` is the digest of the screen the patch should PRODUCE, so the
   * client can verify after applying and ask for a full screen if it
   * disagrees. A patch that silently mis-applies would show terminal output
   * that never existed.
   */
  | { unchanged?: false; patch: ScreenPatch; source: string }
  | { unchanged?: false; lines: string[]; source: string; digest: string };

export type ServerMessage =
  | {
      type: "snapshot"; hostId: string; agents: Agent[]; serverTime: number;
      build?: string | null;
      /**
       * The newest paddock version `checkForUpdate` has seen, or `null` if
       * none is known yet or the running build is already current. Carried
       * here (and on `heartbeat`, below) rather than fetched once from
       * `/api/health`: `App` mounts once and never unmounts for the life of
       * the tab (same reasoning as `build`, right above), so a single fetch
       * racing the server's own unawaited startup check would read `null`
       * and never learn of a real update for as long as the tab stays open.
       * The WS envelope already has working reconnect and a 20s heartbeat;
       * riding it gives eventual consistency for free.
       */
      latestKnown?: string | null;
      /**
       * The package manager that owns this install, or null for the ordinary
       * case (the installer's `~/.local/bin`, a container, a source build).
       *
       * On the wire because the UPGRADE COMMAND differs and the client cannot
       * know which one applies: `paddock update` refuses inside a Homebrew keg
       * (see `update.ts`), so a banner naming it would be telling the operator
       * to run something that declines. Absent and null are different claims —
       * "this frame does not say" versus "nothing owns it" — and the store
       * distinguishes them.
       */
      managedBy?: ManagedBy | null;
    }
  | { type: "delta"; upserted: Agent[]; removedIds: string[]; serverTime: number }
  /**
   * "I am still here" — carries no agent data and changes nothing on screen.
   *
   * Its own variant rather than an empty delta on purpose: an empty delta
   * states "nothing changed", which is a different claim from "the link is
   * alive", and a client is entitled to treat a delta as agent news. The
   * client counts any received message as liveness, so this is what keeps a
   * genuinely quiet overnight session — every agent idle, zero traffic — from
   * declaring itself stale at T+60s and leaving the operator unable to tell
   * "nothing is happening" from "the link died".
   */
  /**
   * Carries the server's current build id so an ALREADY-OPEN tab can notice it
   * is running stale JavaScript. `index.html` is `no-cache`, which fixes fresh
   * loads and does nothing for a tab left open on a phone for days.
   */
  | {
      type: "heartbeat";
      serverTime: number;
      build?: string | null;
      latestKnown?: string | null;
      managedBy?: ManagedBy | null;
    };

/**
 * A package manager that owns a paddock install and therefore owns its
 * upgrades. One member today; a union rather than a boolean because the
 * command to print differs per manager, so a second entry adds a case rather
 * than a second field.
 */
export type ManagedBy = "homebrew";

/**
 * The command that actually upgrades THIS install.
 *
 * One definition, because there are now two places that print it and
 * `paddock update` REFUSES inside a Homebrew keg (`src/server/update.ts`) —
 * a stale second copy would tell a brew user to run something that declines.
 * Named from what owns the install, never guessed.
 */
export function upgradeCommand(managedBy: ManagedBy | null): string {
  return managedBy === "homebrew" ? "brew upgrade paddock" : "paddock update";
}

/** What GET /api/health returns. */
export interface HealthBody {
  ok: boolean;
  hostId: string;
  agents: number;
  clients: number;
  herdrConnected: boolean;
  /**
   * Epoch ms of the last herdr event. Exposed deliberately: a stuck event stream
   * is otherwise invisible, which is how a comparable system dropped every
   * event while reporting success.
   */
  lastEventAt: number | null;
  /**
   * The notifier's last send failure (a bad token, an unreachable API), or
   * `null` if the most recent attempt succeeded or none has been made yet.
   * Required, not optional: a broken token must be visible within seconds via
   * `/api/health`, and an optional field lets a future edit to `health()`
   * silently drop it with nothing — neither the type checker nor a test —
   * to notice.
   */
  lastNotifyError: string | null;
  /**
   * The running build's own version string (see `@server/version`).
   * Required for the same reason as `lastNotifyError`: an operator debugging
   * a report against "whatever paddock happened to be running" should never
   * have to guess it from a binary that may since have been replaced.
   */
  version: string;
  /**
   * The newest version `checkForUpdate` has seen on GitHub, or `null` if none
   * is known yet or none is newer than `version`. Required, not optional —
   * the same reasoning as `lastNotifyError`: a future edit that drops this
   * field from `health()` must be a type error, not a silently missing key.
   */
  latestKnown: string | null;
  /**
   * The package manager that owns this install, or null for the ordinary case.
   *
   * Exposed because the UPGRADE COMMAND depends on it: `paddock update`
   * refuses inside a Homebrew keg, so anything telling an operator to run it
   * there is wrong. Required rather than optional, for the same reason as
   * `latestKnown` above — a future edit to `health()` that drops it must be a
   * type error, not a silently missing key a phone then reads as "unmanaged".
   */
  managedBy: ManagedBy | null;
  /**
   * The protocol the LIVE herdr reports, or null before it has answered.
   *
   * A fact, not a warning — paddock now accepts a herdr newer than the one it
   * was built against (see `herdr/socket.ts`), so drift is normal and this is
   * how an operator sees it without reading a log. Required for the same reason
   * as `lastNotifyError`: an optional field lets a future edit to `health()`
   * drop it silently, with neither the type checker nor a test to notice.
   */
  herdrProtocol: number | null;
  /**
   * Set when herdr's `agent.list` stopped carrying a field paddock reads — the
   * failure a protocol number never caught, and the one this exists for.
   *
   * `null` is the healthy answer AND the answer when no panes are open, because
   * you cannot conclude a field is gone from zero rows. See `herdr/shape.ts`.
   */
  schemaWarning: string | null;
}

export const SECTION_ORDER = ["needs-you", "ready-unseen", "working", "idle"] as const;
export type Section = (typeof SECTION_ORDER)[number];

export function sectionFor(agent: Agent): Section {
  if (agent.state === "blocked") return "needs-you";
  // A finish and a block are different urgencies: one wants a decision before
  // work continues, the other is news nobody has read. They shared `needs-you`
  // until now, which let unread news compete with a decision. Once
  // acknowledged, a finish has been dealt with and stops competing with
  // either.
  if (agent.state === "done") return agent.acknowledgedAt === null ? "ready-unseen" : "idle";
  if (agent.state === "working") return "working";
  return "idle";
}

/**
 * THE triage display order (spec §6): section, then most-recently-changed
 * first, then name as a stable tie-break.
 *
 * Exported from the shared contract and used by BOTH sides on purpose. The
 * server sorts its snapshot with it; the client re-sorts after every delta,
 * because merging a delta into a keyed collection preserves each existing
 * entry's original position — so a snapshot-only sort holds for exactly as
 * long as it takes the first delta to arrive, and then decays for the rest of
 * the session. Two copies of this comparison would be free to drift; there is
 * only one.
 */
export function compareAgents(a: Agent, b: Agent): number {
  const sa = SECTION_ORDER.indexOf(sectionFor(a));
  const sb = SECTION_ORDER.indexOf(sectionFor(b));
  if (sa !== sb) return sa - sb;
  if (a.stateSince !== b.stateSince) return b.stateSince - a.stateSince;
  return a.name.localeCompare(b.name);
}
