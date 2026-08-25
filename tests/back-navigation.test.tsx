// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { Spaces } from "@web/components/Spaces";
import { useStore, type ClientState } from "@web/store";
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
