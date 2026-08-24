import { createRoot } from "react-dom/client";
import { App } from "@web/components/App";
import "@web/styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");

/**
 * The demo backend must be installed BEFORE the app mounts.
 *
 * `App` opens its WebSocket in a mount effect, so a backend installed
 * afterwards would be replacing globals the store has already captured — the
 * list would sit empty forever with no error to explain it.
 *
 * Wrapped in a function rather than awaited at module scope: the build target
 * (es2020, safari14) has no top-level await, and Vite refuses to emit it.
 */
async function boot(): Promise<void> {
  if (import.meta.env.VITE_PADDOCK_DEMO) {
    // Dynamic so the demo never reaches the bundle an operator runs: the
    // condition is a build-time constant, so this import is tree-shaken away
    // entirely in a normal build.
    const { installDemoBackend } = await import("@web/demo/backend");
    installDemoBackend();
    // The phone frame, for the same reason and by the same mechanism: a demo
    // opened on a laptop is a phone-first interface stretched across a desktop
    // window. Below the frame's breakpoint — a real phone reading the README
    // link — this changes nothing.
    const { installDemoFrame } = await import("@web/demo/frame");
    installDemoFrame();
  }
  createRoot(el!).render(<App />);
}

void boot();
