// FIRST: React reads `document` at import time — see tests/pane-deep-link.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { App } from "@web/components/App";
import { useStore, type ClientState } from "@web/store";
import { prunePanes } from "@web/pane-cache";
import { agent, render, settle, stubFetch, unmount } from "./support/render";

const REAL_CONNECT = useStore.getState().connect;
const REAL_FETCH = globalThis.fetch;
const INITIAL: Partial<ClientState> = {
  agents: [], hostId: null, connected: false, lastMessageAt: null,
  build: null, updateAvailable: false, latestKnown: null, managedBy: null, treeStaleAt: 0,
};

afterEach(async () => {
  await unmount();
  useStore.setState({ ...INITIAL, connect: REAL_CONNECT });
  globalThis.fetch = REAL_FETCH;
  location.hash = "";
  prunePanes(new Set());
});

const opened = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith("/opened"));

test("opening an agent posts /opened once, not on re-renders, deltas or a reconnect", async () => {
  const core = agent({ agentId: "core:t1", name: "api-refactor", origin: "core", turn: 4, seen: 1 });
  useStore.setState({ connect: () => {}, agents: [core], hostId: "dev-box" });
  location.hash = "#/pane/core%3At1";
  const { fn, calls } = stubFetch({
    "/api/spaces": () => ({ readAt: 1, spaces: [] }),
    "/output": () => ({ ok: true, lines: [], source: "visible", digest: "x" }),
    "/opened": () => ({ ok: true }),
  });
  globalThis.fetch = fn as never;

  await render(<App />);
  await settle();
  expect(opened(calls)).toHaveLength(1);
  expect(opened(calls)[0]!.url).toBe("/api/agents/core%3At1/opened");

  // A delta (turn and seen move), a reconnect flag flip, a poll: none navigate.
  await act(async () => {
    useStore.setState({ agents: [{ ...core, turn: 5 }], connected: false });
  });
  await act(async () => { useStore.setState({ connected: true, lastMessageAt: 10 }); });
  await settle();
  expect(opened(calls)).toHaveLength(1);
});

test("a refused /opened is logged and shows no error toast", async () => {
  const core = agent({ agentId: "core:t1", name: "api-refactor", origin: "core", turn: 4, seen: 1 });
  useStore.setState({ connect: () => {}, agents: [core], hostId: "dev-box" });
  location.hash = "#/pane/core%3At1";
  const base = stubFetch({
    "/api/spaces": () => ({ readAt: 1, spaces: [] }),
    "/output": () => ({ ok: true, lines: [], source: "visible", digest: "x" }),
  });
  globalThis.fetch = (async (u: string, i?: RequestInit) =>
    String(u).endsWith("/opened")
      ? new Response(JSON.stringify({ ok: false, detail: "this is the demo" }), { status: 409 })
      : base.fn(u, i)) as never;
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const root = await render(<App />);
    await settle();
    expect(warned.some((w) => w.includes("this is the demo"))).toBe(true);
    expect(root.textContent).not.toContain("this is the demo");
  } finally {
    console.warn = realWarn;
  }
});
