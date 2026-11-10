import "./support/dom";

import { afterEach, expect, test } from "bun:test";
import { AgentRow } from "@web/components/AgentRow";
import { SpaceRow } from "@web/components/SpaceRow";
import { installDemoBackend } from "@web/demo/backend";
import type { Agent, Space } from "@shared/types";
import { render, unmount } from "./support/render";

/**
 * The hosted demo is where people look at paddock without running it, so the
 * app half of the product has to be visible there: an app agent carrying the
 * "app" mark, and an app space. Rendered with the real row components from
 * the demo's own data, not asserted on a fixture.
 */

afterEach(async () => { await unmount(); });

async function snapshotAgents(): Promise<Agent[]> {
  return new Promise((resolve) => {
    const Ctor = (globalThis as unknown as { WebSocket: new () => {
      onmessage: ((e: { data: string }) => void) | null; close(): void;
    } }).WebSocket;
    const socket = new Ctor();
    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; agents?: Agent[] };
      if (msg.type === "snapshot" && msg.agents) { socket.close(); resolve(msg.agents); }
    };
  });
}

test("the browser demo shows an app agent with the app mark and an app space", async () => {
  const savedFetch = globalThis.fetch;
  const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  try {
    installDemoBackend();
    const agents = await snapshotAgents();
    const app = agents.filter((a) => a.origin === "core");
    expect(app.map((a) => a.name).sort()).toEqual(["changelog-sync", "release-notes"]);
    expect(app.find((a) => a.name === "release-notes")?.state).toBe("blocked");

    const row = await render(<AgentRow agent={app[0]!} now={Date.now()} />);
    expect(row.querySelector(".origin-mark")?.textContent).toBe("app");
    await unmount();

    const tree = (await (await fetch("/api/spaces")).json()) as { spaces: Space[] };
    const space = tree.spaces.find((s) => s.origin === "core")!;
    expect(space.label).toBe("docs-site");
    const spaceRow = await render(<SpaceRow space={space} onChanged={() => {}} />);
    expect(spaceRow.querySelector(".origin-mark")?.textContent).toBe("app");
  } finally {
    globalThis.fetch = savedFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  }
});
