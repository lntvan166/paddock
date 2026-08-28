import { expect, test } from "bun:test";
import { fileHash, fileIdFromHash, paneHash, agentIdFromHash } from "@shared/route";
import { fileDownloadUrl, fileMetaUrl, fileUrl } from "@web/api";

const ID = "0123456789abcdef0123456789abcdef";

test("a file id round-trips through the hash", () => {
  expect(fileHash(ID)).toBe(`#/file/${ID}`);
  expect(fileIdFromHash(fileHash(ID))).toBe(ID);
});

test("the two screens' hashes do not read as each other", () => {
  // Both prefixes of the pane hash are permanent — every Telegram deep link
  // ever sent used one — so a third route must not shadow them, and they must
  // not shadow it.
  expect(fileIdFromHash(paneHash("w1:p1"))).toBeNull();
  expect(agentIdFromHash(fileHash(ID))).toBeNull();
});

test("anything that is not a file hash is not a file", () => {
  expect(fileIdFromHash("")).toBeNull();
  expect(fileIdFromHash("#/file/")).toBeNull();
  // Shaped like a hash but not one this server issued: 32 hex, nothing else.
  expect(fileIdFromHash("#/file/../../etc/passwd")).toBeNull();
  expect(fileIdFromHash(`#/file/${ID}/extra`)).toBeNull();
});

test("the URLs carry the id and nothing else", () => {
  expect(fileUrl(ID)).toBe(`/api/files/${ID}`);
  expect(fileDownloadUrl(ID)).toBe(`/api/files/${ID}/download`);
  expect(fileMetaUrl(ID)).toBe(`/api/files/${ID}/meta`);
  // The whole reason the id exists: a path in a URL lands in an edge log.
  for (const u of [fileUrl(ID), fileDownloadUrl(ID), fileMetaUrl(ID)]) {
    expect(u.startsWith("/api/files/"), u).toBe(true);
  }
});
