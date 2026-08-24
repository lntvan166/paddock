import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const files = readdirSync("tests").filter((f) => f.endsWith(".test.tsx"));

test("no test fires a DOM event outside act(), because the warning it causes is invisible", async () => {
  // This suite carried 58 "An update to X inside a test was not wrapped in
  // act(...)" warnings. Every one came from a bare `node.click()`: React runs
  // the handler synchronously, so the setState inside it lands outside act.
  //
  // The reason this needs a guard rather than a fix-and-move-on: nothing fails.
  // The tests pass, the assertions hold, and the warnings scroll past — three
  // wrong hypotheses went by before a stack trace found the cause. One more
  // bare click re-opens the whole thing.
  //
  // `await click(node)` from support/render is the fix. A line that mentions
  // `act(` is allowed too, for the one test that deliberately dispatches twice
  // inside a single act to keep React from re-rendering in between.
  //
  // The allowance is `act(` ONLY. It was `act(` or `click(` at first, which
  // allowed everything: `btn.click()` contains the substring `click(`. The
  // guard passed on a deliberately reintroduced bare click, which is why it
  // gets tested against a violation rather than trusted for being green.
  const offenders: string[] = [];
  for (const f of files) {
    const lines = (await Bun.file(`tests/${f}`).text()).split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(".click()")) return;
      if (line.includes("act(")) return;
      offenders.push(`tests/${f}:${i + 1}`);
    });
  }
  expect(offenders, "use `await click(node)` from support/render").toEqual([]);
});

test("typeInto is always awaited, for the same reason", async () => {
  // `typeInto` is async because the dispatch has to happen inside act. Calling
  // it without await is not a type error — the returned promise is simply
  // dropped — so tsc will not catch this one either.
  const offenders: string[] = [];
  for (const f of files) {
    const lines = (await Bun.file(`tests/${f}`).text()).split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("typeInto(")) return;
      if (line.includes("await typeInto(")) return;
      offenders.push(`tests/${f}:${i + 1}`);
    });
  }
  expect(offenders, "`typeInto` returns a promise — await it").toEqual([]);
});
