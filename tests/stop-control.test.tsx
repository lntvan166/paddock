// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { digestOf } from "@shared/screen";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { agent, click, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  localStorage.removeItem("paddock.term.keypad");
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });

let stopOutcome = "stopped";

async function mount(state: "working" | "blocked" | "idle" | "done") {
  const { fn, calls } = stubFetch({
    "/output": () => screenOf(["$ running"]),
    "/commands": () => ({ ok: true, commands: [] }),
    "/prompt": () => ({ ok: true, options: null, question: null, selected: null }),
    "/key": () => ({ ok: true, lines: ["^C"] }),
    "/interrupt": () => ({ ok: true, key: "esc", outcome: stopOutcome, lines: ["stopped"], source: "visible" }),
  });
  globalThis.fetch = fn as typeof fetch;
  const host = await render(<AgentTerminal agent={agent({ state })} onBack={() => {}} />);
  await settle();
  return { host, calls };
}

test("a working agent can be stopped without opening the pad", async () => {
  // `^C` already existed, but only inside the key pad's FULL layout, and the
  // pad defaults to hidden — so interrupting was: tap Keys, tap Keys again to
  // reach full, then find it, and only if you know the toggle cycles.
  const { host } = await mount("working");

  const stop = host.querySelector(".term-stop");
  expect(stop).not.toBeNull();
  expect(stop?.textContent).toContain("Stop");
});

test("it asks the server to interrupt, which picks the key, and sends no key of its own", async () => {
  // Ctrl+C, what Stop used to send, clears Claude Code's input and a second
  // one QUITS it; the interrupt sends Esc to a program that reports status.
  stopOutcome = "stopped";
  const { host, calls } = await mount("working");

  await click(host.querySelector(".term-stop"));
  await settle();

  expect(calls.some((c) => c.url.includes("/interrupt"))).toBe(true);
  expect(calls.some((c) => c.url.includes("/key"))).toBe(false);
  expect(host.querySelector(".term-note.warn")).toBeNull();
});

test("an agent still working after the stop key says so, rather than looking stopped", async () => {
  stopOutcome = "still_working";
  const { host } = await mount("working");
  await click(host.querySelector(".term-stop"));
  await settle();
  expect(host.textContent).toContain("Still working after the stop key.");
  stopOutcome = "stopped";
});

test("an agent that is not working is not offered a stop", async () => {
  // An interrupt beside Send on an idle agent is an accident waiting to happen,
  // and there is nothing to interrupt. The agent's state already says which.
  for (const state of ["idle", "done", "blocked"] as const) {
    const { host } = await mount(state);
    expect(host.querySelector(".term-stop"), state).toBeNull();
    await unmount();
  }
});
