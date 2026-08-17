import { formatElapsed } from "@web/components/elapsed";

/** Staleness is shown, never hidden. Old data presented confidently is worse. */
export function ConnectionBanner({
  connected, lastMessageAt, now,
}: {
  connected: boolean;
  lastMessageAt: number | null;
  now: number;
}) {
  const age = lastMessageAt === null ? null : formatElapsed(now - lastMessageAt);
  return (
    <div
      role="status"
      className="px-3 py-2 text-[11px]"
      style={{ background: "var(--surface)", borderBottom: "1px solid var(--warn)", color: "var(--warn)" }}
    >
      {connected ? "Waiting for updates" : "Reconnecting"}
      {age === null ? " · no data yet" : ` · last updated ${age} ago`}
    </div>
  );
}
