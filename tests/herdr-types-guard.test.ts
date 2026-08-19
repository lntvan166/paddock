import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_PROTOCOL } from "@shared/herdr-api";
import { downgradeRefusal, parseCommittedProtocol } from "../scripts/protocol-guard";

// Read against the REAL generated file, not a fixture: the only job this parser
// has is matching the shape scripts/gen-herdr-types.ts emits, and a fixture
// would keep passing after that shape changed.
test("the committed protocol is read out of the generated file", () => {
  const src = readFileSync("src/shared/herdr-api.d.ts", "utf8");
  expect(parseCommittedProtocol(src)).toBe(HERDR_PROTOCOL);
});

test("a source with no protocol constant parses as nothing committed", () => {
  expect(parseCommittedProtocol("export type Nope = string;\n")).toBeNull();
});

test("regenerating against an older herdr is refused, naming both protocols", () => {
  const refusal = downgradeRefusal(16, 19, false);
  expect(refusal).toContain("16");
  expect(refusal).toContain("19");
  expect(refusal).toContain("older");
});

// Without this the guard is a wall rather than a gate: pinning to an older
// herdr on purpose has to stay possible, and the operator has to be told how.
test("the refusal names the override that bypasses it", () => {
  expect(downgradeRefusal(16, 19, false)).toContain("HERDR_ALLOW_DOWNGRADE");
});

test("an unchanged protocol regenerates", () => {
  expect(downgradeRefusal(19, 19, false)).toBeNull();
});

test("a newer herdr regenerates — that is the upgrade path", () => {
  expect(downgradeRefusal(20, 19, false)).toBeNull();
});

test("an explicit override allows the downgrade", () => {
  expect(downgradeRefusal(16, 19, true)).toBeNull();
});

test("the first generation has nothing to compare against and proceeds", () => {
  expect(downgradeRefusal(19, null, false)).toBeNull();
});

// The pure guard above is worthless if gen-herdr-types.ts does not consult it,
// so this drives the real script with a stub herdr pinned to an older protocol.
// It asserts the file is UNTOUCHED, which is the actual damage being prevented —
// a refusal that still wrote the downgrade would pass a message-only test.
const STUB_SCHEMA = {
  protocol: 16,
  schemas: {
    subscription_event: { $defs: { AgentStatus: { enum: ["idle", "working"] } } },
    success_response: {
      $defs: { ReadSource: { enum: ["screen"] }, ReadFormat: { enum: ["text"] } },
    },
  },
};

test("gen-herdr-types refuses an older herdr and leaves the contract untouched", () => {
  const work = mkdtempSync(join(tmpdir(), "paddock-guard."));
  const stub = join(work, "herdr");
  writeFileSync(stub, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(STUB_SCHEMA)}\nJSON\n`);
  chmodSync(stub, 0o755);

  const out = join(work, "herdr-api.d.ts");
  const before = readFileSync("src/shared/herdr-api.d.ts", "utf8");
  writeFileSync(out, before);

  const r = Bun.spawnSync(["bun", "run", "scripts/gen-herdr-types.ts"], {
    env: { ...process.env, HERDR_BIN: stub, HERDR_TYPES_OUT: out },
  });

  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("older");
  expect(readFileSync(out, "utf8")).toBe(before);
});
