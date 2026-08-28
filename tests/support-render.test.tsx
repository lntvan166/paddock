// FIRST: React reads `document` at import time. See terminal-render.test.tsx.
import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { render, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The harness itself, because a leak here is attributed to innocent files.
 *
 * Bun runs every test file in ONE process. `render()` keeps its root in a
 * module-level binding, so a second call REPLACES it — and if the first tree is
 * not unmounted, it stays mounted, its effects keep running, and its timers
 * keep calling `setState` outside any `act()`. React then warns, naming a
 * component the currently-printing file has never heard of.
 *
 * Measured: `create-sheet.test.tsx` emits ZERO act() warnings alone and was
 * credited with 28 in a full run.
 */

/**
 * Real elapsed time, inside `act`.
 *
 * `settle()` awaits a ZERO-ms macrotask, which is the right tool for observing
 * a promise chain and the wrong one for observing a timer: a 5ms interval has
 * not fired when it returns. Asserting that a tree is alive needs the clock to
 * actually move.
 */
async function elapse(ms: number): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** Ticks forever until unmounted — a stand-in for the polling every pane does. */
function Ticker({ onTick }: { onTick: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => { onTick(); setN((v) => v + 1); }, 5);
    return () => clearInterval(id);
  }, [onTick]);
  return <span data-testid="tick">{n}</span>;
}

test("rendering again does not leave the previous tree mounted", async () => {
  let ticks = 0;
  await render(<Ticker onTick={() => { ticks++; }} />);
  await elapse(30);
  expect(ticks, "the first tree is alive while it is the current one").toBeGreaterThan(0);

  // A second render, the way the NEXT test file's first render looks.
  await render(<span>second</span>);
  const after = ticks;
  await elapse(30);

  expect(ticks, "the abandoned tree must have stopped ticking").toBe(after);
});

test("only one host is left in the document", async () => {
  await render(<span>first</span>);
  await render(<span>second</span>);

  // A host left behind is the visible half of the same leak: the tree under it
  // is still mounted, and `document.body` grows one node per test file.
  expect(document.body.children.length).toBe(1);
});
