import type { JournalAdapter } from "@server/journal/types";

export const claudeAdapter: JournalAdapter = {
  name: "claude",
  verifiedAgainst: "unverified",
  async locate() { return null; },
  parse() { return []; },
};
