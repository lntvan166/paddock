import { create } from "zustand";
import type { Agent, ClientMessage, ManagedBy, ServerMessage } from "@shared/types";
import { agentIdFromHash } from "@shared/route";
import { deviceKey } from "@web/device-key";

export interface ClientState {
  agents: Agent[];
  hostId: string | null;
  connected: boolean;
  lastMessageAt: number | null;
  /** The build this tab first saw the server serving. */
  build: string | null;
  /** The server is serving a different build than this tab is running. */
  updateAvailable: boolean;
  /**
   * The newest paddock version the server's once-a-day check has seen, or
   * `null` if none is known yet or the running build is already current.
   *
   * Carried on the WS envelope (snapshot + heartbeat) rather than fetched
   * once from `/api/health`: `App` mounts once and never unmounts for the
   * life of the tab, so a single fetch racing the server's own unawaited
   * startup check would read `null` and never learn of a real update for as
   * long as the tab stayed open. Unlike `updateAvailable`, this does NOT
   * latch — it always reflects the server's current answer, so an operator
   * who updates sees the notice clear on the next heartbeat.
   */
  latestKnown: string | null;
  /**
   * The package manager owning the SERVER's install, or null. Decides which
   * upgrade command `ReleaseBanner` names: `paddock update` refuses inside a
   * Homebrew keg, so naming it there would label a control with an action that
   * declines.
   */
  managedBy: ManagedBy | null;
  /**
   * Server clock of the most recent `tree-stale` frame, or `0` if none has
   * arrived yet. The Spaces screen watches this to know when to refetch
   * `/api/spaces` — the frame itself carries no tree, only the fact that one
   * changed.
   */
  treeStaleAt: number;
  /**
   * Whether the server said it can read a session tree at all.
   *
   * Gates the Spaces control in the header. `--demo` has no herdr session, so
   * `GET /api/spaces` 404s honestly there and the control would always error —
   * which `routes.ts` already records as a defect class, from `/ack`'s Dismiss
   * button. A CAPABILITY, never a demo flag and never a device check: nothing
   * in the client knows what `--demo` is.
   *
   * Starts `false`, and a snapshot that omits the field leaves it alone: "this
   * server does not say it has a tree" and "it has none" get the same answer,
   * because the wrong one in that direction is a button that errors.
   */
  spacesAvailable: boolean;
}

/**
 * Track the server's build id, and latch when it changes.
 *
 * `index.html` is served `no-cache`, so a FRESH load always gets the current
 * bundle. That does nothing for a tab already open — it keeps running the
 * JavaScript it loaded, indefinitely, which on a phone can mean days. Twice in
 * this project a bug was hunted in code that had already been fixed, because
 * the tab under test was stale.
 *
 * Three rules, each of which exists to avoid a false alarm:
 *  - the FIRST id seen is adopted, never reported — otherwise every tab
 *    announces an update the moment it connects;
 *  - a null id is ignored entirely, because dev mode serves unhashed assets
 *    and would otherwise show a permanent, un-dismissable prompt;
 *  - once raised the flag stays raised, because the tab really is running
 *    stale code until someone reloads it.
 */
function trackBuild(state: ClientState, build: string | null | undefined): Partial<ClientState> {
  if (build == null) return {};
  if (state.build === null) return { build };
  if (state.build === build) return {};
  return { updateAvailable: true };
}

/**
 * Unlike `trackBuild`, this does not latch and does not ignore `null`: a
 * `null` is a real, current answer ("nothing newer is known", or the
 * operator has since updated), not the absence of one. Only `undefined` —
 * the field genuinely missing from the message — leaves the prior value
 * alone.
 */
function trackLatestKnown(
  state: ClientState, latestKnown: string | null | undefined,
): Partial<ClientState> {
  if (latestKnown === undefined) return {};
  return { latestKnown };
}

/**
 * Same undefined-means-silence rule as `trackLatestKnown`: a frame that omits
 * the field is not asserting "nothing owns this install", and flipping the
 * banner's command between frames would be worse than either answer.
 */
function trackManagedBy(
  state: ClientState, managedBy: ManagedBy | null | undefined,
): Partial<ClientState> {
  if (managedBy === undefined) return {};
  return { managedBy };
}

const STALE_AFTER_MS = 60_000;

export function wsUrlFrom(loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === "https:" ? "wss://" : "ws://";
  return `${scheme}${loc.host}/ws`;
}

export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.5 + rand() * 0.5));
}

/**
 * What this device is showing, as a frame.
 *
 * Pure and exported so the RULE is tested — the socket wiring around it is
 * not, exactly as `wsUrlFrom` is tested and `open()` is not.
 *
 * `hidden` collapses the hash to null. Presence means "this device is SHOWING
 * the agent": a backgrounded PWA with a pane in its hash shows nothing, and
 * treating it as a viewer is how a pocketed phone stays silent about an agent
 * that is waiting for it.
 */
export function viewingMessage(o: {
  deviceKey: string | null; hash: string; hidden: boolean;
}): ClientMessage {
  return {
    type: "viewing",
    deviceKey: o.deviceKey,
    agentId: o.hidden ? null : agentIdFromHash(o.hash),
  };
}

/**
 * The tree-reading capability, from a snapshot that may not mention it.
 *
 * `undefined` is left alone rather than read as `false`, the same distinction
 * `trackManagedBy` draws: a frame that does not say is not a frame that denies.
 * The initial value is already `false`, so a server which never says stays
 * without the control either way.
 */
function trackSpaces(
  state: ClientState, spaces: boolean | undefined,
): Partial<ClientState> {
  if (spaces === undefined) return {};
  return { spacesAvailable: spaces };
}

export function applyMessage(state: ClientState, msg: ServerMessage): ClientState {
  if (msg.type === "snapshot") {
    return {
      ...state,
      ...trackBuild(state, msg.build),
      ...trackLatestKnown(state, msg.latestKnown),
      ...trackManagedBy(state, msg.managedBy),
      ...trackSpaces(state, msg.spaces),
      hostId: msg.hostId,
      agents: msg.agents,
      lastMessageAt: msg.serverTime,
    };
  }
  // Liveness only. It counts as a received message for staleness — that is its
  // entire job — and must not touch `agents`, so a quiet link keeps proving
  // itself alive without ever redrawing a row.
  if (msg.type === "heartbeat") {
    return {
      ...state,
      ...trackBuild(state, msg.build),
      ...trackLatestKnown(state, msg.latestKnown),
      ...trackManagedBy(state, msg.managedBy),
      lastMessageAt: msg.serverTime,
    };
  }
  // BEFORE the delta fall-through below, which reads `msg.upserted`
  // unconditionally: an unhandled variant would throw there rather than being
  // ignored. Bumps a counter the Spaces screen watches; the agent list is
  // returned by identity so nothing re-renders that does not care.
  if (msg.type === "tree-stale") {
    return { ...state, treeStaleAt: msg.serverTime, lastMessageAt: msg.serverTime };
  }
  const byId = new Map(state.agents.map((a) => [a.agentId, a]));
  for (const a of msg.upserted) byId.set(a.agentId, a);
  for (const id of msg.removedIds) byId.delete(id);
  return { ...state, agents: [...byId.values()], lastMessageAt: msg.serverTime };
}

/**
 * Stale means "what you are looking at may no longer be true".
 *
 * A disconnected socket is stale immediately, whatever the timing. Otherwise
 * this is a silence detector: the server sends a heartbeat every 20s (see
 * Hub.startHeartbeat), so a live link refreshes `lastMessageAt` three times
 * inside this window even when no agent has moved for hours.
 */
export function isStale(
  // Only the fields it reads: a wider type would force every caller to
  // supply state this function has no opinion about.
  state: Pick<ClientState, "connected" | "lastMessageAt">,
  now: number,
  thresholdMs = STALE_AFTER_MS,
): boolean {
  if (!state.connected) return true;
  if (state.lastMessageAt === null) return true;
  return now - state.lastMessageAt > thresholdMs;
}

interface Store extends ClientState {
  connect: () => void;
}

/**
 * NOTE: this module must be importable with zero side effects outside a
 * browser (bun test has no DOM). All `document`/`location` access is
 * therefore deferred until `connect()`/`open()` actually runs, and guarded —
 * never touched at module load, so importing @web/store never throws under
 * `bun test`. Reading `globalThis.location` rather than `window.location` is
 * equivalent in a browser (there `window === globalThis`) and lets tests
 * stub `globalThis.location` without a DOM.
 */
export const useStore = create<Store>((set, get) => {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let visibilityListenerAttached = false;
  /**
   * Refreshed on every heartbeat reply (see `ws.onmessage` below), not just
   * resolved once at `ws.onopen`: a subscription created after the socket
   * opened — enabling push from Settings mid-session — must be reflected
   * within one heartbeat, not only on the next page load. `sendViewing`
   * itself stays synchronous and just reads whatever this currently holds.
   */
  let key: string | null = null;

  const sendViewing = () => {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(viewingMessage({
      deviceKey: key,
      hash: globalThis.location?.hash ?? "",
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
    })));
  };

  const open = () => {
    // Re-entrancy guard: a second connect() call (duplicate mount, a
    // double-invoked React StrictMode effect) must not orphan the first
    // socket's handlers and spin up a second live connection + retry timer.
    if (ws !== null) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    ws = new WebSocket(wsUrlFrom(globalThis.location));

    ws.onopen = () => {
      attempt = 0;
      set({ connected: true });
      void deviceKey().then((k) => { key = k; sendViewing(); });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch (err) {
        console.error("paddock: unparseable server message", err);
        return;
      }
      set(applyMessage(get(), msg));
      // The reply to the hub's own 20s heartbeat IS presence's keep-alive, so
      // no timer of its own is needed on either side.
      if (msg.type === "heartbeat") {
        sendViewing();
        // Refresh the cached key for the NEXT heartbeat rather than awaiting
        // it for this one: `onmessage` stays synchronous, so frames cannot be
        // reordered by a `deviceKey()` that resolves late, and a throw here
        // cannot break message handling. `deviceKey()` already caches only a
        // non-null result (see `@web/device-key`) and never rejects — the one
        // path that could is `.catch`-guarded, matching the "must not throw
        // inside onmessage" rule everywhere else in this handler. This is how
        // a push subscription created mid-session (Settings, after the tab
        // already opened) is picked up within one heartbeat: `key` was `null`
        // at `ws.onopen`, so without this it would stay `null` for the life
        // of the tab.
        void deviceKey().then((k) => { key = k; }).catch(() => {});
      }
    };
    ws.onclose = () => {
      set({ connected: false });
      ws = null;
      // A fresh snapshot arrives on reconnect; deltas are never assumed to resume.
      retry = setTimeout(open, backoffMs(attempt++));
    };
    ws.onerror = (err) => console.error("paddock: websocket error", err);
  };

  const connect = () => {
    if (!visibilityListenerAttached && typeof document !== "undefined") {
      visibilityListenerAttached = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && ws === null) {
          // Reconnect suspends while hidden; becoming visible resumes it
          // immediately (no backoff wait) so an unlocked phone shows current
          // data, not a stale screen.
          if (retry) clearTimeout(retry);
          attempt = 0;
          open();
        }
        // Hiding or showing the page changes what this device is viewing —
        // see `viewingMessage` — even when the socket itself is untouched.
        sendViewing();
      });
      // A pane opened or closed within an already-visible tab changes what
      // this device is viewing without touching `visibilitychange` at all.
      addEventListener("hashchange", sendViewing);
    }
    open();
  };

  return {
    agents: [],
    hostId: null,
    connected: false,
    lastMessageAt: null,
    build: null,
    updateAvailable: false,
    latestKnown: null,
    managedBy: null,
    treeStaleAt: 0,
    spacesAvailable: false,
    connect,
  };
});
