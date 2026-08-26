// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { Spaces } from "@web/components/Spaces";
import { applyMessage, useStore, type ClientState } from "@web/store";
import { prunePanes } from "@web/pane-cache";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";
import type { SpaceTree } from "@shared/types";

/**
 * §16.4: back goes to wherever the pane was actually opened from, not to a
 * literal that is right for one branch and wrong for the other.
 *
 * The mechanism under test is the real `hashchange` — `location.hash =`
 * followed by `settle()`, not a state update reaching into the component —
 * because the thing being pinned here is "the app noticed the ACTUAL prior
 * hash", not "the app remembers a value someone handed it directly".
 */

const REAL_CONNECT = useStore.getState().connect;
const REAL_FETCH = globalThis.fetch;

const INITIAL: Partial<ClientState> = {
  agents: [], hostId: null, connected: false, lastMessageAt: null,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null,
  treeStaleAt: 0,
};

afterEach(async () => {
  // unmount FIRST, then restore `connect` — see tests/pane-deep-link.test.tsx
  // for why the order matters.
  await unmount();
  useStore.setState({ ...INITIAL, connect: REAL_CONNECT });
  globalThis.fetch = REAL_FETCH;
  location.hash = "";
  prunePanes(new Set());
});

const treeWith = (harness: string | null): SpaceTree => ({
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

test("an agent pane opened from #/spaces returns to #/spaces", async () => {
  useStore.setState({
    connect: () => {},
    agents: [agent({ agentId: "w9:p1", name: "docs-cleanup" })],
  });
  location.hash = "#/spaces";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith("claude"),
    "/output": () => ({ lines: ["out"], source: "visible" }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  expect(host.querySelector(".spaces-head")).not.toBeNull();

  // The navigation this whole mechanism has to notice: a REAL hash change,
  // away from `#/spaces`, into the pane.
  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to spaces");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/spaces");
});

test("a shell pane opened from #/spaces returns to #/spaces", async () => {
  useStore.setState({ connect: () => {} });
  location.hash = "#/spaces";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(null),
    "/api/panes/": () => ({ lines: ["operator@dev-box:/srv/project$ ls"], source: "recent_unwrapped" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  expect(host.querySelector(".spaces-head")).not.toBeNull();

  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to spaces");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/spaces");
});

test("an agent pane opened cold (no recorded origin) returns to the dashboard", async () => {
  useStore.setState({
    connect: () => {},
    agents: [agent({ agentId: "w9:p1", name: "docs-cleanup" })],
  });
  // Set BEFORE render/mount: no `hashchange` listener exists yet to observe
  // this, which is exactly what makes it cold rather than "came from ''".
  location.hash = "#/pane/w9%3Ap1";

  const { fn } = stubFetch({
    "/output": () => ({ lines: ["out"], source: "visible" }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to agents");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("");
});

test("a shell pane opened cold (no recorded origin) returns to the dashboard, never to Spaces", async () => {
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
  // This is the corrected half of §16.4: the old shell branch hard-coded
  // `#/spaces` here regardless of origin. A cold link has none, so it must
  // land where a cold agent link does.
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to agents");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("");
});

test("the Spaces screen's own back control uses the shared term-back treatment", async () => {
  const tree = treeWith("claude");
  const host = await render(<Spaces onBack={() => {}} load={async () => tree} />);
  await settle();

  const back = host.querySelector(".spaces-head button");
  expect(back).not.toBeNull();
  expect(back?.classList.contains("term-back")).toBe(true);
  expect(back?.getAttribute("aria-label")).toBe("Back to agents");
});

test("an agent pane opened from a SPACE returns to that space, not the list", async () => {
  // The defect this closes: the origin was a boolean (`fromSpaces`), so it
  // could say "came from Spaces" but not WHICH space — every pane opened from
  // a space screen returned to the plural list.
  useStore.setState({
    connect: () => {},
    agents: [agent({ agentId: "w9:p1", name: "docs-cleanup", workspaceId: "w9", workspaceLabel: "docs-cleanup" })],
  });
  location.hash = "#/space/w9";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith("claude"),
    "/output": () => ({ lines: ["out"], source: "visible" }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  expect(host.querySelector(".space-screen-head")).not.toBeNull();

  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  // Labelled by the space's own name, never its herdr coordinate.
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to docs-cleanup");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/space/w9");
});

test("a shell pane opened from a space returns there, labelled generically", async () => {
  // A shell is deliberately absent from `agents` (§3), so the store has no
  // `workspaceLabel` for it and `useTreePane` returns a `TreePane` that
  // carries none either. The destination is still exact; only the WORD is
  // generic, because the alternative is printing `w9` — a herdr coordinate,
  // which `docs/gotchas.md` bans on screen as "correct and useless".
  useStore.setState({ connect: () => {} });
  location.hash = "#/space/w9";

  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(null),
    "/output": () => ({ lines: ["out"], source: "visible" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();

  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to this space");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/space/w9");
});

test("a shell opened from a space survives a live promotion: the origin ref outlives the pane's own unmount/remount", async () => {
  // This branch raised the stakes on `paneOriginRef`: the ref now carries a
  // SPACE ID, not a boolean, and a promotion unmounts `PaneTerminal` and
  // mounts `AgentTerminal` under the same pane id — a real remount, not a
  // re-render, so anything holding the origin has to be a ref on `App`
  // itself, which never unmounts, rather than component state that would
  // reset with the pane. The existing promotion test
  // (tests/pane-deep-link.test.tsx) sets `location.hash` BEFORE render, so
  // its origin is null and the back target is the dashboard both before and
  // after — it cannot observe the ref surviving. This one opens from a real
  // space via a real `hashchange`, so there is a non-null origin to lose.
  useStore.setState({ connect: () => {} });
  location.hash = "#/space/w9";

  let harness: string | null = null;
  const { fn } = stubFetch({
    "/api/spaces": () => treeWith(harness),
    "/api/panes/": () => ({ lines: ["operator@dev-box:/srv/project$ ls"], source: "recent_unwrapped" }),
    "/output": () => ({ lines: ["out"], source: "visible" }),
    "/prompt": () => ({ question: null, options: null, selected: null, raw: "" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(<App />);
  await settle();
  expect(host.querySelector(".space-screen-head")).not.toBeNull();

  // The real navigation `paneOriginRef` has to notice: away from
  // `#/space/w9`, into the shell.
  await act(async () => { location.hash = "#/pane/w9%3Ap1"; });
  await settle();

  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to this space");

  // Promote it: the tree flips to a harness first (the hub sends
  // `tree-stale` immediately), then the store gets the agent one delta
  // later — the same two-step order `pane-deep-link.test.tsx` drives.
  harness = "claude";
  await act(async () => {
    useStore.setState((s) => applyMessage(s, { type: "tree-stale", serverTime: Date.now() }));
  });
  await settle();

  await act(async () => {
    useStore.setState((s) => applyMessage(s, {
      type: "snapshot", hostId: "dev-box", serverTime: Date.now(),
      agents: [agent({ agentId: "w9:p1", name: "docs-cleanup", workspaceId: "w9", workspaceLabel: "docs-cleanup" })],
    }));
  });
  await settle();

  // Still the same destination — the ref must have survived the shell's own
  // unmount and the agent view's mount under the same pane id — but the
  // label has upgraded now that `agents` carries a `workspaceLabel`.
  expect(host.querySelector("section.term")).not.toBeNull();
  expect(host.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to docs-cleanup");

  await click(host.querySelector(".term-back"));
  expect(location.hash).toBe("#/space/w9");
});
