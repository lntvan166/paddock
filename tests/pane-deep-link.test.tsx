// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { applyMessage, useStore, type ClientState } from "@web/store";
import { digestOf } from "@shared/screen";
import { prunePanes } from "@web/pane-cache";
import { agent, click, render, settle, stubFetch, typeInto, unmount } from "./support/render";

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
 *
 * The same tree-before-store ordering also happens on a LIVE promotion, and
 * there the right answer is the opposite one: something is already on screen,
 * so it must be kept rather than held over. The two are the same condition and
 * different cases, which is why both are pinned here.
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

test("a deep link to a pane with NO agent opens the shell transcript, with its own keyboard", async () => {
  // The other half: the guard must not have closed the door it was added
  // beside. `harness: null` is still a shell and still opens.
  //
  // §16.3 overturned the old assumption this test used to assert (a shell
  // gets NO controls): `App` now wires `sendPaneText`/`sendPaneKey` into the
  // shell's `PaneTerminal`, so a deep-linked shell must render a reply box
  // and — once the pad preference says to show it — the keypad too. `hidden`
  // is the stored default (`prefs.ts`), so this sets it the same way the
  // shell-terminal keypad tests do, to prove the element is reachable at all
  // rather than merely absent-by-default.
  localStorage.setItem("paddock.term.keypad", "compact");
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
  expect(host.querySelector(".term-reply")).not.toBeNull();
  expect(host.querySelector("[data-keypad]")).not.toBeNull();
  // FLIPPED (§16.4): this used to assert "Back to spaces" unconditionally,
  // which was the bug — a shell hard-coded `#/spaces` regardless of where it
  // was opened from. This deep link is COLD (no prior hash, no hashchange),
  // so it has no recorded origin and must return to the dashboard, exactly
  // like the cold agent pane above. See tests/back-navigation.test.tsx for
  // the case that still lands on `#/spaces` — a pane actually opened from
  // Spaces.
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to agents");
  localStorage.removeItem("paddock.term.keypad");
});

test("a shell opened through App RUNS the command — App -> PaneTerminal -> api.ts -> submit", async () => {
  // The gap the previous round's route-level curl check could not see: a
  // curl against `/api/panes/:id/text` proves the SERVER route works, but
  // says nothing about whether `App.tsx` actually WIRES `sendPaneText` into
  // the `PaneTerminal` it renders. This mounts the real `App`, types into the
  // real reply box, and asserts the stubbed `fetch` sees the real route —
  // the one path nothing else in this suite drives end to end.
  //
  // The body assertion is FLIPPED from `{text: "ls"}`: `pane.send_text` does
  // not submit, so a request without `submit` typed the command onto the
  // prompt line and ran nothing. `submit: true` has to survive every hop —
  // reply box, `App`'s memoised sender, `api.ts` — or a button labelled Send
  // is a button that types.
  useStore.setState({ connect: () => {} });
  location.hash = "#/pane/w9%3Ap1";

  const { fn, calls } = stubFetch({
    "/api/spaces": () => treeWith(null),
    // Checked before the broader "/api/panes/" match below — `stubFetch`
    // matches the first registered key the URL contains, so the more
    // specific route has to come first or every pane request (including the
    // opening `/output` read) would hit the generic stub instead.
    "/text": () => ({ ok: true }),
    "/api/panes/": () => ({ lines: ["operator@dev-box:/srv/project$ ls"], source: "recent_unwrapped" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  const input = host.querySelector<HTMLInputElement>("#term-reply-input");
  expect(input).not.toBeNull();
  await typeInto(input!, "ls");
  await click(host.querySelector('.term-reply button[type="submit"]'));

  const textCall = calls.find((c) => c.url.includes("/text"));
  expect(textCall).toBeDefined();
  expect(textCall!.url).toContain(encodeURIComponent("w9:p1"));
  expect(textCall!.body).toEqual({ text: "ls", submit: true });
});

test("a shell already on screen keeps its transcript through a live promotion", async () => {
  // The other half of the hold, and the case it used to get wrong. The
  // operator is WATCHING a shell and types `claude` into it. `tree-stale` is
  // sent immediately by the hub while the agent delta waits on `coalesceMs`
  // plus the supervisor's `refresh()` round trip, so the tree reliably flips
  // first — and `promoting` then replaced a live transcript with a bare
  // "Opening…" for as long as that took.
  //
  // `PaneTerminal`'s 409 handling exists for exactly this moment and keeps the
  // transcript while marking the pane stalled, so the hold was overriding a
  // better answer that was already written. It now applies only where nothing
  // has been painted, which is the cold link above.
  useStore.setState({ connect: () => {} });
  location.hash = "#/pane/w9%3Ap1";

  let harness: string | null = null;
  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(harness),
    "/api/panes/": () => ({ lines: ["operator@dev-box:/srv/project$ ls"], source: "recent_unwrapped" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  // Painted as a shell first — that is what makes this a promotion rather than
  // a cold link.
  expect(host.textContent).toContain("operator@dev-box");

  harness = "claude";
  await act(async () => {
    useStore.setState((s) => applyMessage(s, { type: "tree-stale", serverTime: Date.now() }));
  });
  await settle();

  // Same pane, same key, same instance: the transcript is still the transcript.
  expect(host.textContent).toContain("operator@dev-box");
  expect(host.textContent).not.toContain("Opening…");
  expect(host.querySelector("section.term")).not.toBeNull();

  // And the promotion still completes: one delta later the agent's own view
  // takes over, with the controls a shell never gets.
  await act(async () => {
    useStore.setState((s) => applyMessage(s, {
      type: "snapshot", hostId: "dev-box", serverTime: Date.now(),
      agents: [agent({ agentId: "w9:p1", name: "docs-cleanup" })],
    }));
  });
  await settle();
  expect(host.querySelector(".term-reply")).not.toBeNull();
});
