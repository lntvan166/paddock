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
import { agent, click, render, settle, stubFetch, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;

/** Every pref this file writes, cleared in `afterEach` rather than at the end
 *  of a test body: a body that stops early — which is what a FAILING assertion
 *  does — leaks the pref into every file Bun runs after this one, and the
 *  failures land furthest from the cause. Same list-and-loop shape as
 *  `tests/terminal-render.test.tsx`. */
const PREF_KEYS = ["paddock.term.keypad", "paddock.rate"];

afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
  // The screen cache is keyed by pane id and lives for the page. Left behind,
  // a shell's lines would seed the next test that happens to use the same id.
  prunePanes(new Set());
  for (const k of PREF_KEYS) localStorage.removeItem(k);
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
});

// §16.3: the shell case was promised plain text input and never got a route
// until now. These cover the client half — the injected senders, not the
// network — the same way `load` above needs no network to test.

test("a shell with senders renders a reply box and a keypad", async () => {
  // `hidden` is the stored default (prefs.ts), so the pad itself would not
  // be on screen without this — same setup the agent-side keypad test above
  // uses to prove the same selector matches something real.
  localStorage.setItem("paddock.term.keypad", "compact");
  const el = await render(
    <PaneTerminal
      paneId="w3:p10" title="bash" onBack={() => {}} load={load}
      sendText={async () => ({ ok: true })}
      sendKey={async () => ({ ok: true })}
    />,
  );
  await settle();
  expect(el.querySelector(".term-reply")).not.toBeNull();
  expect(el.querySelector("[data-keypad]")).not.toBeNull();
});

test("sending calls the injected sender with the text verbatim", async () => {
  const calls: string[] = [];
  const el = await render(
    <PaneTerminal
      paneId="w3:p11" title="bash" onBack={() => {}} load={load}
      sendText={async (text) => { calls.push(text); return { ok: true }; }}
    />,
  );
  await settle();

  const input = el.querySelector<HTMLInputElement>("#term-reply-input");
  // Leading AND trailing spaces, plus a doubled interior one: a value with no
  // surrounding whitespace cannot tell "sent verbatim" apart from "sent
  // trimmed", since both would look identical on the wire. This one only
  // passes if nothing between the input and the sender trims or collapses it.
  await typeInto(input!, "  echo  hi  ");
  await click(el.querySelector('.term-reply button[type="submit"]'));

  expect(calls).toEqual(["  echo  hi  "]);
});

test("a send failure is surfaced, never swallowed", async () => {
  const el = await render(
    <PaneTerminal
      paneId="w3:p12" title="bash" onBack={() => {}} load={load}
      sendText={async () => ({ ok: false, detail: "herdr socket unreachable" })}
    />,
  );
  await settle();

  const input = el.querySelector<HTMLInputElement>("#term-reply-input");
  await typeInto(input!, "ls");
  await click(el.querySelector('.term-reply button[type="submit"]'));

  expect(el.textContent).toContain("herdr socket unreachable");
});

test("a shell's keypad and reply box never grow prompt options — there is no prompt to parse", async () => {
  // The invariant from the top of this file, re-asserted with senders wired
  // up: giving the shell a keyboard must not accidentally give it the
  // agent's option-button UI too.
  localStorage.setItem("paddock.term.keypad", "full");
  const el = await render(
    <PaneTerminal
      paneId="w3:p13" title="bash" onBack={() => {}} load={load}
      sendText={async () => ({ ok: true })}
      sendKey={async () => ({ ok: true })}
    />,
  );
  await settle();
  expect(el.querySelector("[data-prompt-option]")).toBeNull();
});

test("Send RUNS the command, in the default configuration — no stored prefs at all", async () => {
  // The test the shipped defect walked past. Every other send test here asserts
  // that the injected sender was CALLED, which `pane.send_text` satisfies while
  // leaving the command sitting unexecuted on the prompt line — and the two
  // tests that show a keypad set `paddock.term.keypad` first, so the only Enter
  // in the app was reachable in the test and not on a first run.
  //
  // So: nothing is stored, deliberately — ASSERTED, not arranged. Every pref
  // this file writes is cleared in `afterEach`, and if some other file ever
  // leaks one into this process, this line is where that shows up rather than
  // quietly turning the shipped default into somebody's stored choice.
  // `DEFAULTS.keypad` is `hidden` (`prefs.ts`), which makes Send the ONLY way
  // an operator opening a shell for the first time can run anything.
  expect(localStorage.getItem("paddock.term.keypad")).toBeNull();
  const calls: Array<{ text: string; submit: boolean }> = [];
  const el = await render(
    <PaneTerminal
      paneId="w3:p14" title="bash" onBack={() => {}} load={load}
      sendText={async (text, submit) => { calls.push({ text, submit }); return { ok: true }; }}
      sendKey={async () => ({ ok: true })}
    />,
  );
  await settle();

  // The premise, asserted rather than assumed: there is no keypad on screen, so
  // no Enter key, so Send is the whole of the operator's keyboard.
  expect(el.querySelector("[data-keypad]")).toBeNull();

  const input = el.querySelector<HTMLInputElement>("#term-reply-input");
  await typeInto(input!, "ls");
  await click(el.querySelector('.term-reply button[type="submit"]'));

  expect(calls).toEqual([{ text: "ls", submit: true }]);
});

test("a half-landed send reads as half-landed, never as sent", async () => {
  // The route answers 502 `typed, but not run: …` when the text landed and the
  // key did not. Reported as the operator sees it, because retyping a command
  // that is already on the prompt line runs it twice.
  const el = await render(
    <PaneTerminal
      paneId="w3:p15" title="bash" onBack={() => {}} load={load}
      sendText={async () => { throw new RequestFailed(502, "typed, but not run: pane_not_found"); }}
    />,
  );
  await settle();

  const input = el.querySelector<HTMLInputElement>("#term-reply-input");
  await typeInto(input!, "ls");
  await click(el.querySelector('.term-reply button[type="submit"]'));

  expect(el.querySelector(".term-note")?.textContent).toContain("typed, but not run");
  // And the text stays in the box only as long as it is not misleading: the
  // command is already on the prompt line, so the box is NOT cleared.
  expect(input!.value).toBe("ls");
});

test("a 409 on the WRITE path is a promotion, not an internal route name (§16.3 read path, mirrored)", async () => {
  // The rule this file states at the read path — never put an internal route
  // name in front of the operator — applied where it was broken: a promotion
  // landing mid-type made the reply box print
  // "this pane has an agent; use /api/agents/:id/text".
  const el = await render(
    <PaneTerminal
      paneId="w3:p16" title="bash" onBack={() => {}} load={load}
      sendText={async () => {
        throw new RequestFailed(409, "this pane has an agent; use /api/agents/:id/text");
      }}
    />,
  );
  await settle();

  const input = el.querySelector<HTMLInputElement>("#term-reply-input");
  await typeInto(input!, "claude");
  await click(el.querySelector('.term-reply button[type="submit"]'));

  expect(el.textContent).not.toContain("/api/agents/:id/text");
  expect(el.textContent).toContain("this pane is now an agent");
  // Treated as the read path treats it: the pane has stopped updating as a
  // shell, and says so.
  expect(el.querySelector(".term-stalled")?.textContent).toBe("not updating");
});
