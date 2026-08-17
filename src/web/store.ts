import { create } from "zustand";
import type { Agent, ServerMessage } from "@shared/types";

export interface ClientState {
  agents: Agent[];
  hostId: string | null;
  connected: boolean;
  lastMessageAt: number | null;
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

export function applyMessage(state: ClientState, msg: ServerMessage): ClientState {
  if (msg.type === "snapshot") {
    return {
      ...state,
      hostId: msg.hostId,
      agents: msg.agents,
      lastMessageAt: msg.serverTime,
    };
  }
  // Liveness only. It counts as a received message for staleness — that is its
  // entire job — and must not touch `agents`, so a quiet link keeps proving
  // itself alive without ever redrawing a row.
  if (msg.type === "heartbeat") {
    return { ...state, lastMessageAt: msg.serverTime };
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
export function isStale(state: ClientState, now: number, thresholdMs = STALE_AFTER_MS): boolean {
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
      });
    }
    open();
  };

  return {
    agents: [],
    hostId: null,
    connected: false,
    lastMessageAt: null,
    connect,
  };
});
