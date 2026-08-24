import { expect, test } from "bun:test";
import { fanOut, Notifier } from "@server/notify/notifier";
import type { Delta } from "@server/state/store";
import type { Agent } from "@shared/types";

const agent = (state: Agent["state"]): Agent => ({
  hostId: "dev-box",
  agentId: "w1:p1",
  name: "docs-cleanup",
  task: "Rewrite the quickstart",
  state,
  workspaceId: "w1",
  workspaceLabel: null,
  cwd: "/path/to/project",
  harness: "claude",
  stateSince: 0,
  updatedAt: 0,
  acknowledgedAt: null,
  hasJournal: false,
});

// The regression this guards: wiring the notifier by REPLACING
// `onDelta: (d) => hub.queue(d)` rather than adding to it, which silently
// stops every browser updating while notifications appear to work. `fanOut`
// is the single function both `index.ts` and this test call, so a change that
// drops either destination from `fanOut` itself fails here.
test("a delta reaches BOTH the hub and the notifier", async () => {
  let queued = 0;
  const hubStub = { queue: (_d: Delta) => { queued++; } };
  const seen: string[] = [];
  const notifier = new Notifier({
    settings: {
      current: () => ({
        telegram: { token: "1:A", chatId: "5" },
        notify: { enabled: true, triggers: ["blocked"], settleMs: { blocked: 0, done: 0 },
                  mutedUntil: null, cooldownMs: 0 },
        publicUrl: null,
      }),
    } as never,
    send: async (t: string) => { seen.push(t); return { ok: true, detail: null }; },
  });

  const onDelta = fanOut(hubStub, notifier);
  onDelta({ upserted: [agent("working")], removedIds: [] });
  onDelta({ upserted: [agent("blocked")], removedIds: [] });
  await Bun.sleep(1);

  expect(queued).toBe(2);
  expect(seen).toHaveLength(1);
});
