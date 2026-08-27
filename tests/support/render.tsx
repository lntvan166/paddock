import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Agent } from "@shared/types";

/**
 * Minimal render helpers. No testing-library: these tests query the DOM
 * directly, and one more dependency to learn is not worth the sugar for a
 * suite this size.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

/**
 * Let queued promises and effects settle.
 *
 * A MACROTASK, not just a microtask, so a `Response` and the `.json()` after it
 * have both resolved when this returns. That makes a mount deterministic to
 * observe, and it means a caller usually needs ONE settle rather than two
 * hopeful ones.
 *
 * This is for observing async work the test did not itself trigger. It is NOT
 * what wraps an event — see `click` and `typeInto`, which have to wrap the
 * DISPATCH, not the settling after it.
 */
export async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

export async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // `act` flushes effects. Without it the component mounts but its effects —
  // which is where every defect these tests exist to catch actually lived —
  // have not run yet.
  await act(async () => { root!.render(node); });
  // Then let the mount's async work finish, so a caller reaches for `settle()`
  // only when it is driving something itself rather than to observe a mount.
  await settle();
  return host;
}

export async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project", harness: "claude",
    stateSince: 0, stateSinceExact: true, updatedAt: 0, acknowledgedAt: null, hasJournal: false, ...over,
  };
}

/** Text of every element matching a selector, whitespace-collapsed. */
export function textsOf(el: HTMLElement, selector: string): string[] {
  return [...el.querySelectorAll(selector)].map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim());
}

/**
 * A fetch stub that records calls and answers by URL fragment.
 *
 * Returns real `Response` objects rather than plain values, so the code under
 * test exercises the same `res.ok` / `res.json()` path it does in a browser —
 * a stub that resolves parsed objects would skip exactly the branch that once
 * resolved a non-2xx body as if it were a screen.
 */
export function stubFetch(routes: Record<string, () => unknown>) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    let body: unknown = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { /* not JSON */ }
    calls.push({ url, body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const payload = key ? routes[key]!() : { ok: false, detail: `no stub for ${url}` };
    return new Response(JSON.stringify(payload), {
      status: key ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

/**
 * Click, inside `act`.
 *
 * The wrapping is the whole point, and it has to be around the DISPATCH. A
 * bare `node.click()` runs React's handler synchronously outside `act`, so the
 * `setState` inside that handler is an unwrapped update and React warns — the
 * suite carried 58 of those, which is the volume at which a real warning goes
 * unread. Settling AFTER the click does not help: by then the unwrapped update
 * has already been scheduled. That mistake cost three wrong hypotheses, all of
 * them about mount, before a stack trace showed `executeDispatch` as the
 * caller.
 *
 * Throws on a missing element rather than no-opping the way `?.click()` does.
 * A selector that stops matching should fail its test, not quietly assert
 * against an untouched component.
 */
export async function click(node: Element | null | undefined): Promise<void> {
  if (!node) throw new Error("click(): no element — the selector matched nothing");
  await act(async () => {
    (node as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Dispatch an arbitrary event inside `act`, for the cases `click` does not cover. */
export async function fire(node: Element, event: Event): Promise<void> {
  await act(async () => {
    node.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Type into a controlled input the way a person does, so React's `onChange`
 * actually fires.
 *
 * Two separate things make the obvious `node.value = x` a no-op here, and
 * both fail SILENTLY — the test then asserts against the component's
 * original state, which reads as coverage while providing none.
 *
 * 1. React installs its own `value` accessor on each input instance (its
 *    "value tracker") to tell a real edit from a re-render. Assigning through
 *    that accessor updates the tracker too, so React concludes the value did
 *    not change. Writing through the PROTOTYPE's native setter leaves the
 *    tracker stale, which is what a real keystroke does.
 *
 * 2. React's change plugin decides at import time whether the environment
 *    supports the `input` event, and under happy-dom it decides NO — so it
 *    falls back to its polyfill path, which reads the value on
 *    `keyup`/`keydown`/`selectionchange` against the element it last saw
 *    `focusin` on, and ignores `input` entirely. Measured: `input` alone
 *    never fires `onChange`; `focusin` then `keyup` does. `select` elements
 *    take a different branch, which is why the existing theme test can get
 *    away with a bare `change` event.
 *
 * All three events are dispatched so this keeps working if that decision ever
 * flips the other way.
 *
 * Async and `act`-wrapped for the reason given on `click`: the dispatch is what
 * has to be inside `act`, because that is when the controlled input's
 * `onChange` runs.
 */
export async function typeInto(node: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("no native value setter on HTMLInputElement.prototype");
  await act(async () => {
    node.dispatchEvent(new Event("focusin", { bubbles: true }));
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("keyup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Pick an option in a `<select>`, the way React sees it.
 *
 * A sibling of `typeInto`, and simpler for the reason that function's own note
 * records: a `select` takes a different branch in React's event plumbing and
 * responds to a bare `change`, where a text input needs `focusin` and `keyup`.
 *
 * The native value setter is used rather than `node.value = …` for the same
 * reason `typeInto` uses it — React tracks the last value it wrote on the DOM
 * node, and assigning through the instance property leaves that tracker in
 * step, so the subsequent event is discarded as "no change".
 *
 * Async and `act`-wrapped because the DISPATCH is what has to be inside `act`:
 * that is when the controlled element's `onChange` runs.
 */
export async function selectOption(node: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) throw new Error("no native value setter on HTMLSelectElement.prototype");
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Open a Radix menu or popover the way a finger does.
 *
 * Radix triggers on `pointerdown`, not `click` — deliberately, because it
 * removes the ~300ms tap delay on touch. `click()` alone therefore does
 * nothing to one, which looks exactly like a broken component in a test.
 *
 * happy-dom has no `PointerEvent`, so a `MouseEvent` is dispatched under the
 * pointer type name: Radix reads `event.button` and `event.ctrlKey` off it,
 * both of which a MouseEvent carries.
 */
export async function pointerOpen(node: Element | null | undefined): Promise<void> {
  if (!node) throw new Error("pointerOpen(): no element — the selector matched nothing");
  await act(async () => {
    node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    node.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    (node as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
