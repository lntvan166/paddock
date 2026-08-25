// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { applyMessage, useStore, type ClientState } from "@web/store";
import { digestOf } from "@shared/screen";
import { prunePanes } from "@web/pane-cache";
import { agent, render, settle, stubFetch, unmount } from "./support/render";

/**
 * `#/pane/<id>` opened cold, which is paddock's PRIMARY entry path: a
 * notification about a blocked agent is a link straight into that pane, and
 * `agents` is empty until the websocket snapshot lands.
 *
 * The tree can win that race. It answers from `session.snapshot` over a local
 * socket while the snapshot crosses whatever link the phone is on, so `App`
 * routinely resolves an AGENT pane out of the tree with nothing in the store
 * to render it with. `harness` is the only discriminator between the two
 * cases, and the cost of ignoring it was concrete: `PaneTerminal` mounted,
 * the pane route answered 409, and the operator read
 * "this pane has an agent; use /api/agents/:id/output" — an internal route
 * name — until the snapshot arrived.
 */

const REAL_CONNECT = useStore.getState().connect;
// Captured at module load, restored after every test. A stub left installed
// leaks into every test file that runs after this one — Bun runs them all in
// ONE process, and the files that suffer are the ones furthest from this
// subject: an update check, a lifecycle probe, a compiled-binary fetch. They
// fail with no hint of where the stub came from.
const REAL_FETCH = globalThis.fetch;

const INITIAL: Partial<ClientState> = {
  agents: [], hostId: null, connected: false, lastMessageAt: null,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null,
  treeStaleAt: 0,
};

afterEach(async () => {
  // unmount FIRST, then restore `connect`: restoring it under a mounted App
  // flips the `useEffect(() => connect(), [connect])` dependency and opens a
  // real WebSocket the test never asked for.
  await unmount();
  useStore.setState({ ...INITIAL, connect: REAL_CONNECT });
  globalThis.fetch = REAL_FETCH;
  location.hash = "";
  prunePanes(new Set());
});

const treeWith = (harness: string | null) => ({
  readAt: 1_700_000_000_000,
  spaces: [{
    spaceId: "w9", label: "docs-cleanup", tabCount: 1, paneCount: 1,
    tabs: [{
      tabId: "w9:t1", label: null, panes: [{
        paneId: "w9:p1", harness, name: harness === null ? null : "docs-cleanup",
        title: "bash", cwd: "/srv/project", state: harness === null ? null : "working",
      }],
    }],
  }],
});

test("a deep link to an AGENT pane never opens as a shell, even before the snapshot", async () => {
  useStore.setState({ connect: () => {} });
  location.hash = "#/pane/w9%3Ap1";

  const { fn, calls } = stubFetch({
    "/api/spaces": () => treeWith("claude"),
    "/output": () => ({ lines: ["out"], source: "visible", digest: digestOf(["out"]) }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  // Held, not opened and not bounced. The pane exists — dropping the operator
  // on a dashboard that cannot list it would be the other wrong answer.
  expect(host.textContent).toContain("Opening…");
  expect(host.querySelector("section.term")).toBeNull();
  // And the route that would have produced the internal message was never
  // called at all, so there is nothing to leak even for an instant.
  expect(calls.some((c) => c.url.includes("/api/panes/"))).toBe(false);
  expect(host.textContent).not.toContain("/api/agents/:id/output");

  // One delta later the store has the agent, and the agent's own view opens
  // with the controls a shell never gets.
  await act(async () => {
    useStore.setState((s) => applyMessage(s, {
      type: "snapshot", hostId: "dev-box", serverTime: Date.now(),
      agents: [agent({ agentId: "w9:p1", name: "docs-cleanup" })],
    }));
  });
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-reply")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to agents");
});

test("a deep link to a pane with NO agent opens the shell transcript", async () => {
  // The other half: the guard must not have closed the door it was added
  // beside. `harness: null` is still a shell and still opens.
  useStore.setState({ connect: () => {} });
  location.hash = "#/pane/w9%3Ap1";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(null),
    "/api/panes/": () => ({ lines: ["operator@dev-box:/srv/project$ ls"], source: "recent_unwrapped" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.textContent).toContain("operator@dev-box");
  expect(host.querySelector(".term-reply")).toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to spaces");
});
