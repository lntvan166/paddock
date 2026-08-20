import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRoots, containedRealpath, isSessionId, MAX_TAIL_BYTES, tailChunk,
} from "@server/journal/files";

const UUID = "f4971cd4-d53b-430a-8fc6-a0d4572103ae";

test("only a canonical uuid is a session id", () => {
  expect(isSessionId(UUID)).toBe(true);
  expect(isSessionId("../../etc/passwd")).toBe(false);
  expect(isSessionId(`${UUID}/../..`)).toBe(false);
  expect(isSessionId("")).toBe(false);
  expect(isSessionId(`${UUID}.jsonl`)).toBe(false);
});

test("claudeRoots defaults to the home projects dir", () => {
  expect(claudeRoots({}, "/srv/operator")).toEqual(["/srv/operator/.claude/projects"]);
});

test("claudeRoots takes several config dirs, comma-separated and in order", () => {
  // One machine can hold several Claude homes — a per-profile CLAUDE_CONFIG_DIR
  // is the case that forces a list rather than a string.
  expect(claudeRoots({ CLAUDE_CONFIG_DIR: "/a, /b" }, "/srv/operator"))
    .toEqual(["/a/projects", "/b/projects"]);
});

test("containedRealpath accepts a file inside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  await mkdir(join(root, "proj"));
  const file = join(root, "proj", `${UUID}.jsonl`);
  await writeFile(file, "{}\n");
  expect(await containedRealpath(root, file)).toBe(file);
});

test("containedRealpath refuses a path that escapes via ..", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  expect(await containedRealpath(root, join(root, "..", "escape.jsonl"))).toBeNull();
});

test("containedRealpath refuses a symlink pointing outside the root", async () => {
  // The check is on the RESOLVED path, not the requested one: a symlink inside
  // the root is the way a string that looks contained stops being contained.
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const outside = await mkdtemp(join(tmpdir(), "paddock-out-"));
  const target = join(outside, "secrets.jsonl");
  await writeFile(target, "{}\n");
  const link = join(root, `${UUID}.jsonl`);
  await symlink(target, link);
  expect(await containedRealpath(root, link)).toBeNull();
});

test("containedRealpath returns null for a file that does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  expect(await containedRealpath(root, join(root, `${UUID}.jsonl`))).toBeNull();
});

test("tailChunk reads from the END and reports where it started", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const file = join(root, "big.jsonl");
  const body = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
  await writeFile(file, body);
  const { text, startByte } = await tailChunk(file, body.length, 40);
  expect(text.endsWith("line-99")).toBe(true);
  expect(startByte).toBe(body.length - 40);
  expect(text.length).toBe(40);
});

test("tailChunk never reads before the start of the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-j-"));
  const file = join(root, "small.jsonl");
  await writeFile(file, "abc");
  const { text, startByte } = await tailChunk(file, 3, 999);
  expect(text).toBe("abc");
  expect(startByte).toBe(0);
});

test("the tail cap is bounded, so one request cannot read a whole huge log", () => {
  // Measured: a real session is 1.5 MB / 729 records, ~2 KB per record. This
  // cap is ~250 records' worth per request, well above one page of history.
  expect(MAX_TAIL_BYTES).toBe(512_000);
});
