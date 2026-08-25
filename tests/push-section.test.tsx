import "./support/dom";
import { expect, test } from "bun:test";
import { click, render, settle } from "./support/render";
import { PushSection } from "@web/components/settings/PushSection";

/**
 * Fake the four capability/install combinations WITHOUT touching a user agent.
 *
 * That is not a workaround for CLAUDE.md's rule against device detection — it
 * is the mechanism the rule points at. `window.PushManager` is undefined in a
 * Safari tab and defined inside an installed PWA, so iOS hands us the signal
 * for free and every case below is a capability or an install state.
 */
function capabilities(o: {
  push: boolean; standalone: boolean; permission?: NotificationPermission;
  onRequest?: () => NotificationPermission;
}) {
  const w = globalThis.window as unknown as Record<string, unknown>;
  const restore: (() => void)[] = [];
  const set = (key: string, value: unknown) => {
    const had = Object.getOwnPropertyDescriptor(w, key);
    Object.defineProperty(w, key, { value, configurable: true, writable: true });
    restore.push(() => {
      if (had) Object.defineProperty(w, key, had);
      else delete w[key];
    });
  };
  set("PushManager", o.push ? function PushManager() { /* capability marker */ } : undefined);
  set("Notification", {
    permission: o.permission ?? "default",
    requestPermission: () => Promise.resolve(o.onRequest?.() ?? "granted"),
  });
  set("matchMedia", (q: string) => ({
    matches: o.standalone && q.includes("standalone"),
    media: q, addEventListener() {}, removeEventListener() {},
  }));

  // happy-dom ships no `navigator.serviceWorker`, and the component checks for
  // it — correctly, since it registers one. Faked on `navigator` rather than
  // `window` because that is where the real API lives.
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const hadSw = Object.getOwnPropertyDescriptor(nav, "serviceWorker");
  if (o.push) {
    Object.defineProperty(nav, "serviceWorker", {
      configurable: true, writable: true,
      value: {
        getRegistration: () => Promise.resolve({
          pushManager: { getSubscription: () => Promise.resolve(null) },
        }),
        register: () => Promise.resolve({
          pushManager: { getSubscription: () => Promise.resolve(null) },
        }),
      },
    });
  } else {
    delete nav.serviceWorker;
  }
  restore.push(() => {
    if (hadSw) Object.defineProperty(nav, "serviceWorker", hadSw);
    else delete nav.serviceWorker;
  });

  return () => { for (const r of restore.reverse()) r(); };
}

const props = {
  enabled: false,
  devices: 0,
  vapidPublicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  error: null as string | null,
  onChanged: () => {},
};

test("a browser with PushManager gets the enable control", async () => {
  const undo = capabilities({ push: true, standalone: true });
  try {
    const node = await render(<PushSection {...props} />);
    expect(node.textContent).toContain("Enable");
    expect(node.textContent).not.toContain("Home Screen");
  } finally { undo(); }
});

// The iOS case, reached by CAPABILITY rather than by sniffing a user agent:
// window.PushManager is undefined in a Safari tab and defined in an installed
// PWA, so the right guidance falls out of feature detection.
test("no PushManager and not installed asks for Home Screen first", async () => {
  const undo = capabilities({ push: false, standalone: false });
  try {
    const node = await render(<PushSection {...props} />);
    expect(node.textContent).toContain("Home Screen");
  } finally { undo(); }
});

test("no PushManager while installed says the browser cannot do it", async () => {
  const undo = capabilities({ push: false, standalone: true });
  try {
    const node = await render(<PushSection {...props} />);
    expect(node.textContent?.toLowerCase()).toContain("does not support");
    expect(node.textContent).not.toContain("Home Screen");
  } finally { undo(); }
});

test("a denied permission points at browser settings, since asking again does nothing", async () => {
  const undo = capabilities({ push: true, standalone: true, permission: "denied" });
  try {
    const node = await render(<PushSection {...props} />);
    expect(node.textContent?.toLowerCase()).toContain("browser settings");
  } finally { undo(); }
});

test("permission is requested only from a tap, never on render", async () => {
  // iOS enforces it, and a prompt on page load is the one guaranteed way to be
  // denied permanently.
  let asked = 0;
  const undo = capabilities({
    push: true, standalone: true,
    onRequest: () => { asked += 1; return "denied"; },
  });
  try {
    const node = await render(<PushSection {...props} />);
    await settle();
    expect(asked).toBe(0);
    const button = node.querySelector("button");
    expect(button).not.toBeNull();
    await click(button!);
    await settle();
    expect(asked).toBe(1);
  } finally { undo(); }
});

test("a push.json error is shown rather than swallowed", async () => {
  const undo = capabilities({ push: true, standalone: true });
  try {
    const node = await render(
      <PushSection {...props} error="push.json is not valid JSON, so push is off" />,
    );
    expect(node.textContent).toContain("push.json");
  } finally { undo(); }
});

test("the device count is shown so the operator knows how many phones buzz", async () => {
  const undo = capabilities({ push: true, standalone: true });
  try {
    const node = await render(<PushSection {...props} devices={3} />);
    expect(node.textContent).toContain("3");
  } finally { undo(); }
});

test("a server with no keypair says push is off rather than offering a button", async () => {
  // The demo bundle, and any paddock whose push.json could not be read. An
  // enable button here could only ever fail.
  const undo = capabilities({ push: true, standalone: true });
  try {
    const node = await render(<PushSection {...props} vapidPublicKey={null} />);
    expect(node.querySelector("button")).toBeNull();
    expect(node.textContent?.toLowerCase()).toContain("not configured");
  } finally { undo(); }
});
