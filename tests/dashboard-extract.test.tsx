import "./support/dom";
import { afterEach, expect, test } from "bun:test";
import { Dashboard } from "@web/components/Dashboard";
import { render, settle, unmount } from "./support/render";

afterEach(async () => { await unmount(); });

/**
 * The dashboard, as its own component.
 *
 * It was ~145 lines of JSX inside `App.tsx`'s route dispatch, which is fine
 * while exactly one screen renders at a time and impossible once three do.
 * This is a MOVE, not a rewrite: if any of these change behaviour, the
 * extraction was done wrong.
 */

test("it renders the agent list shell", async () => {
  await render(<Dashboard />);
  await settle();
  expect(document.querySelector(".screen"), "no screen shell").not.toBeNull();
  expect(document.querySelector(".screen-body"), "no scroll container").not.toBeNull();
});

test("it renders its own chrome, header included", async () => {
  await render(<Dashboard />);
  await settle();
  expect(document.querySelector(".screen-chrome"), "chrome did not come across").not.toBeNull();
});

test("it does NOT render a tab bar of its own", async () => {
  // The bar belongs to AppShell now. A second one here would restore exactly
  // the defect that hoisting it removed.
  await render(<Dashboard />);
  await settle();
  expect(document.querySelectorAll(".tab-bar").length).toBe(0);
});

test("no source commentary leaks into the page", async () => {
  // The `//`-in-JSX-child bug shipped once already, from the wrap that made
  // this extraction necessary. `tests/jsx-stray-comments.test.ts` guards the
  // source; this guards the rendered result of the file most likely to hit it.
  await render(<Dashboard />);
  await settle();
  expect(document.body.textContent ?? "").not.toContain("//");
});
