// FIRST: React reads `document` at import time — see tests/terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentTerminal } from "@web/components/AgentTerminal";
import { digestOf } from "@shared/screen";
import { rememberHistory } from "@web/pane-cache";
import { agent, click, render, settle, stubFetch, typeInto, unmount } from "./support/render";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmount();
  globalThis.fetch = realFetch;
});

const screenOf = (lines: string[]) => ({ lines, source: "visible", digest: digestOf(lines) });
const ESC = String.fromCharCode(27);

/**
 * What "Show earlier" REVEALS, as opposed to the control that reveals it.
 *
 * Both tests here are operator reports from a phone, and both are about the
 * same moment: reading earlier output in order to decide how to answer, which
 * is the only reason the feature exists. Reported as "the content of earlier
 * is bad UI" — it jumped, and it changed colour.
 */

/** A screen wide enough for `scrollOffset`'s 12-line match window to work. */
const screenA = Array.from({ length: 30 }, (_, i) => `screen line ${i}`);
/** The same screen scrolled by five, so a send settles exactly five lines. */
const screenB = [...screenA.slice(5), ...Array.from({ length: 5 }, (_, i) => `fresh ${i}`)];

test("revealed history stays put while new output settles above the live screen", async () => {
  // THE BUG: the revealed window was anchored to the END of `settled`, which
  // grows on every poll — so each newly settled line pushed one line off the
  // TOP of what was on screen. Reading earlier output while an agent worked
  // meant the text slid out from under your finger, one line at a time, with
  // the scroll position held. Reported as "it jumps, I lose my place".
  const settled = Array.from({ length: 400 }, (_, i) => `old ${i}`);
  rememberHistory("r1:p1", { settled, gaps: 0, last: screenA });

  const { fn } = stubFetch({
    "/output": () => screenOf(screenA),
    "/text": () => ({ ok: true, lines: screenB, source: "visible" }),
  });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "r1:p1" })} onBack={() => {}} />,
  );
  await settle();

  await click(host.querySelector(".term-earlier"));
  await settle();

  const pane = host.querySelector(".term-pane") as HTMLElement;
  const firstRevealed = (pane.textContent ?? "").trimStart().split("\n")[0];
  expect(firstRevealed, "a page of history is on screen").toBe("old 200");

  // Answer the agent. Its reply carries a screen scrolled by five, so five
  // lines settle into history — the exact event that used to shift the view.
  await typeInto(host.querySelector(".term-reply-field") as HTMLTextAreaElement, "go ahead");
  await click(host.querySelector('button[aria-label="Send"]'));
  await settle();

  const after = (pane.textContent ?? "").trimStart().split("\n")[0];
  expect(after, "the line the operator was reading is still the first one").toBe("old 200");
  // And the newly settled lines joined the transcript rather than displacing it.
  expect(pane.textContent).toContain("screen line 0");
});

test("revealing history does not recolour the live screen", async () => {
  // THE BUG: `parseAnsi` carries SGR state across lines, which is right for one
  // screen and wrong across this boundary — the revealed block is an arbitrary
  // slice of history, so a colour left open in it bled into the live output.
  // Measured: the identical live line rendered #cd3131 with history revealed
  // and unstyled without it. The live screen's colours must not depend on how
  // much history the operator has asked for.
  rememberHistory("r2:p1", {
    settled: [`${ESC}[31mred, and never closed`],
    gaps: 0,
    last: screenA,
  });

  const { fn } = stubFetch({ "/output": () => screenOf(["a live line"]) });
  globalThis.fetch = fn as typeof fetch;

  const host = await render(
    <AgentTerminal agent={agent({ agentId: "r2:p1" })} onBack={() => {}} />,
  );
  await settle();

  const colourOf = () =>
    [...host.querySelectorAll(".term-pane span")]
      .filter((n) => (n.textContent ?? "").includes("a live line"))
      .map((n) => (n as HTMLElement).style.color);

  const before = colourOf();
  expect(before.length, "the live line is on screen").toBeGreaterThan(0);

  await click(host.querySelector(".term-earlier"));
  await settle();

  expect(host.textContent, "history really was revealed").toContain("red, and never closed");
  expect(colourOf(), "same line, same colour").toEqual(before);
});
