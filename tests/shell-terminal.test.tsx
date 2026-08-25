// FIRST: React reads `document` at import time, so the DOM must exist before
// any component below is imported — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { PaneTerminal, SHELL_MIN_REFRESH_MS } from "@web/components/PaneTerminal";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { prunePanes, rememberScreen } from "@web/pane-cache";
import { RequestFailed } from "@web/api";
import { agent, render, settle, stubFetch, unmount } from "./support/render";

const realFetch = globalThis.fetch;

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  // The screen cache is keyed by pane id and lives for the page. Left behind,
  // a shell's lines would seed the next test that happens to use the same id.
  prunePanes(new Set());
});

const load = async () => ({
  lines: ["operator@dev-box:/srv/project$ ls", "README.md"],
  source: "recent_unwrapped" as const,
});

test("a shell pane renders its transcript", async () => {
  const el = await render(
    <PaneTerminal paneId="w3:p1" title="bash" onBack={() => {}} load={load} />,
  );
  await settle();
  expect(el.textContent).toContain("README.md");
});

test("a shell has no keypad and no prompt options — there is no agent to answer", async () => {
  // Not a vacuous assertion: `AgentTerminal` stamps `data-keypad` on the pad
  // and `data-prompt-option` on every option button, and the test below mounts
  // one to prove both selectors match something when an agent IS present.
  const el = await render(
    <PaneTerminal paneId="w3:p1" title="bash" onBack={() => {}} load={load} />,
  );
  await settle();
  expect(el.querySelector("[data-keypad]")).toBeNull();
  expect(el.querySelector("[data-prompt-option]")).toBeNull();
});

test("the same two selectors DO match once the pane has an agent", async () => {
  // The other half of the assertion above. A shell and an agent are one pane
  // at two moments; what separates the two renderings is exactly these
  // controls, so a test that only ever proves them absent proves nothing.
  localStorage.setItem("paddock.term.keypad", "compact");
  const { fn } = stubFetch({
    "/output": () => ({ lines: ["menu"], source: "visible", digest: digestOf(["menu"]) }),
    "/prompt": () => ({
      question: "Do you want to proceed?",
      options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }],
      selected: null, raw: "",
    }),
  });
  globalThis.fetch = fn as typeof fetch;

  const el = await render(
    <AgentTerminal agent={agent({ agentId: "w3:p9", state: "blocked" })} onBack={() => {}} />,
  );
  await settle();

  expect(el.querySelector("[data-keypad]")).not.toBeNull();
  expect(el.querySelectorAll("[data-prompt-option]")).toHaveLength(2);
  localStorage.removeItem("paddock.term.keypad");
});

test("a failed read is shown, never an empty screen", async () => {
  const el = await render(
    <PaneTerminal
      paneId="w3:p1" title="bash" onBack={() => {}}
      load={async () => { throw new Error("unknown pane"); }}
    />,
  );
  await settle();
  expect(el.textContent).toContain("unknown pane");
});

test("the transcript, the wrap toggle and Refresh are the pane's own, not the agent's", async () => {
  // The seam the split falls on: everything here works with no agent behind
  // it, which is why it could move out of `AgentTerminal` rather than being
  // copied.
  const el = await render(
    <PaneTerminal paneId="w3:p2" title="bash" onBack={() => {}} load={load} />,
  );
  await settle();

  expect(el.querySelectorAll(".term-pane")).toHaveLength(1);
  expect(el.querySelectorAll(".term-wrap-toggle")).toHaveLength(1);
  expect(el.querySelector('[aria-label="Refresh"]')).not.toBeNull();
  // ...and none of the agent's controls came with them.
  expect(el.querySelectorAll(".term-reply")).toHaveLength(0);
  expect(el.querySelectorAll(".term-keys-toggle")).toHaveLength(0);
  expect(el.querySelector(".term-title .term-state")).toBeNull();
});

test("the back control says where back goes, because for a shell it is not the agent list", async () => {
  const el = await render(
    <PaneTerminal
      paneId="w3:p3" title="bash" onBack={() => {}} load={load}
      backLabel="Back to spaces"
    />,
  );
  await settle();
  expect(el.querySelector(".term-back")?.getAttribute("aria-label")).toBe("Back to spaces");
});

/** Let real timers run, inside `act`, so a poll landing is not an unwrapped update. */
const waitMs = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

test("a shell is not polled on the agent's cadence", async () => {
  // A shell poll cannot be validated against the store — a shell pane is
  // deliberately not in it — so `POST /api/panes/:id/output` pays a
  // `session.snapshot` (~17-19 ms) before every ~2 ms read. Roughly ten times
  // the herdr work of an agent poll, and the design refuses both ways out
  // (weaker validation, a cached tree). So the RATE is matched instead of the
  // interval: `SHELL_MIN_REFRESH_MS` raises the floor, and the ceiling and the
  // doubling above it are untouched.
  localStorage.setItem("paddock.rate", "live");
  let shellReads = 0;
  let agentReads = 0;

  await render(
    <PaneTerminal
      paneId="w3:p4" title="bash" onBack={() => {}}
      load={async () => { shellReads++; return { lines: ["idle shell"], source: "recent_unwrapped" }; }}
      minIntervalMs={SHELL_MIN_REFRESH_MS}
    />,
  );
  await settle();
  await waitMs(400);
  // The opening read, and nothing since: 400 ms is well inside the shell floor.
  expect(shellReads).toBe(1);
  await unmount();

  // The same component with no floor raised polls on the Live preset, which is
  // what makes the assertion above about the FLOOR rather than about the test
  // being too quick to observe anything.
  await render(
    <PaneTerminal
      paneId="w3:p5" title="bash" onBack={() => {}}
      load={async () => { agentReads++; return { lines: ["idle shell"], source: "visible" }; }}
    />,
  );
  await settle();
  await waitMs(400);
  expect(agentReads).toBeGreaterThan(1);

  localStorage.removeItem("paddock.rate");
});

test("a 409 is a promotion in flight, not a failure: the transcript stays and the banner does not", async () => {
  // The pane route answers 409 for a pane that HAS an agent, which is exactly
  // what a shell becomes the moment someone types `claude` into it — and also
  // what a cold deep link hits when the tree beats the websocket snapshot.
  // `App` swaps in `AgentTerminal` a beat later; until it does, the screen on
  // display is still true. Raising the banner here would put an internal route
  // name in front of the operator for the duration of the promotion.
  rememberScreen("w3:p6", { lines: ["the shell as it was"], digest: null });

  const el = await render(
    <PaneTerminal
      paneId="w3:p6" title="bash" onBack={() => {}}
      load={async () => {
        throw new RequestFailed(409, "this pane has an agent; use /api/agents/:id/output");
      }}
    />,
  );
  await settle();

  expect(el.querySelector(".term-pane")?.textContent).toContain("the shell as it was");
  expect(el.querySelector(".term-error")).toBeNull();
  expect(el.textContent).not.toContain("/api/agents/:id/output");
  // Not swallowed either: the pane says it has stopped updating.
  expect(el.querySelector(".term-stalled")?.textContent).toBe("not updating");
});

test("any OTHER refusal is still an error, so the guard is about 409 and not about refusals", async () => {
  const el = await render(
    <PaneTerminal
      paneId="w3:p7" title="bash" onBack={() => {}}
      load={async () => { throw new RequestFailed(404, "unknown pane"); }}
    />,
  );
  await settle();
  expect(el.querySelector(".term-error")?.textContent).toContain("unknown pane");
});

test("a successful read clears the error banner even when it brings no new screen", async () => {
  // Once the banner was up, a pane whose digest still matched returned early
  // without reaching `apply`, so nothing ever called `setError(null)` — a
  // quiet pane kept claiming "Could not load output" while every read
  // underneath it was succeeding. A successful revalidation is proof of
  // exactly the opposite.
  // Pinned, not assumed: Bun runs every test file in one process, so another
  // file's stored preset would otherwise decide how long this test waits.
  localStorage.setItem("paddock.rate", "live");
  rememberScreen("w3:p8", { lines: ["still here"], digest: "d1" });
  let call = 0;

  const el = await render(
    <PaneTerminal
      paneId="w3:p8" title="bash" onBack={() => {}}
      load={async () => {
        call++;
        if (call === 1) throw new Error("herdr unreachable");
        return { unchanged: true as const };
      }}
    />,
  );
  await settle();
  expect(el.querySelector(".term-error")?.textContent).toContain("herdr unreachable");

  // The poll lands on the 250ms Live floor and answers "nothing changed".
  await waitMs(400);
  expect(call).toBeGreaterThan(1);
  expect(el.querySelector(".term-error")).toBeNull();
  expect(el.querySelector(".term-pane")?.textContent).toContain("still here");
  localStorage.removeItem("paddock.rate");
});
