// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { applyMessage, useStore, type ClientState } from "@web/store";
import { render, unmount } from "./support/render";

/**
 * Fix round 1: the original wiring fetched `/api/health` once on App's
 * mount-time effect, with no retry and no refresh — and App never unmounts
 * for the life of the tab. A server that answers that first fetch before its
 * own unawaited startup check resolves would report `latestKnown: null`
 * forever, even once the real check later finds a real update. `latestKnown`
 * now rides the WebSocket snapshot/heartbeat envelope instead (see
 * @web/store's `trackLatestKnown` and hub.ts), which already has working
 * reconnect and a 20s heartbeat.
 *
 * This test proves the field travels the WHOLE path — a message applied
 * through the store's own reducer (`applyMessage`, the exact function
 * `ws.onmessage` calls) reaching the rendered header — rather than handing
 * HostHeader a hardcoded `latestKnown` prop directly (host-header.test.tsx
 * already covers that half; it would pass even if App never read the store
 * at all).
 */

// Captured once, at module load, before any test can override it — the real
// value to restore to once the tree is gone.
const REAL_CONNECT = useStore.getState().connect;

const INITIAL: Partial<ClientState> = {
  agents: [], hostId: null, connected: false, lastMessageAt: null,
  build: null, updateAvailable: false, latestKnown: null,
};

afterEach(async () => {
  // unmount() FIRST, then restore `connect` — restoring it while App is
  // still mounted would flip the `useEffect(() => connect(), [connect])`
  // dependency from the no-op back to the real one and re-run it, opening a
  // genuine WebSocket this test never intended to touch (measured: this is
  // exactly what an earlier version of this test did, and it left an
  // "Unhandled error" — an actual `ws` connection attempt — after the test
  // had already reported passing).
  await unmount();
  useStore.setState({ ...INITIAL, connect: REAL_CONNECT });
});

test("a latestKnown value applied through the store's own message reducer reaches the rendered header", async () => {
  // Neutered, not stubbed with a fake WebSocket: this test's subject is
  // whether App reads `latestKnown` off the store and passes it to
  // HostHeader, not the WebSocket transport itself (hub.test.ts and
  // web-store.test.ts already cover the wire format and the reducer).
  // `connect` is a module-singleton concern across test files, so replacing
  // it here — and restoring it only after unmount, in afterEach — avoids
  // touching the real, shared WebSocket lifecycle at all.
  useStore.setState({ connect: () => {} });

  const host = await render(<App />);

  // The exact call `ws.onmessage` makes in store.ts: apply a real
  // ServerMessage through the real reducer, then let the store push the
  // result into every subscribed component.
  await act(async () => {
    useStore.setState((s) =>
      applyMessage(s, { type: "heartbeat", serverTime: Date.now(), latestKnown: "9.9.9" }),
    );
  });

  expect(host.textContent).toContain("paddock 9.9.9 available — run: paddock update");
});
