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

export async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // `act` flushes effects. Without it the component mounts but its effects —
  // which is where every defect these tests exist to catch actually lived —
  // have not run yet.
  await act(async () => { root!.render(node); });
  return host;
}

export async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** Let queued promises and effects settle, optionally advancing fake time. */
export async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    hostId: "dev-box", agentId: "w1:p1", name: "api-refactor",
    task: "Extract auth middleware", state: "working", workspaceId: "w1",
    workspaceLabel: "api work", cwd: "/srv/project",
    stateSince: 0, updatedAt: 0, acknowledgedAt: null, ...over,
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
