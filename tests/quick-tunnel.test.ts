import { expect, test } from "bun:test";
import { isQuickTunnelUrl } from "@shared/quick-tunnel";

test("a quick-tunnel host is recognised", () => {
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com")).toBe(true);
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com/")).toBe(true);
  expect(isQuickTunnelUrl("https://quiet-harbor-8f31.trycloudflare.com/a1b2c3")).toBe(true);
});

test("a real deployment is not one, and neither is nothing", () => {
  expect(isQuickTunnelUrl("https://paddock.example.com")).toBe(false);
  expect(isQuickTunnelUrl(null)).toBe(false);
  expect(isQuickTunnelUrl("")).toBe(false);
  expect(isQuickTunnelUrl("not a url")).toBe(false);
});

test("a lookalike suffix is somebody else's domain", () => {
  // The whole reason there is one regex: this case is easy to get wrong twice.
  expect(isQuickTunnelUrl("https://a.trycloudflare.com.example.net")).toBe(false);
  expect(isQuickTunnelUrl("https://trycloudflare.com.example.net")).toBe(false);
});

test("the check is on the host, not the string", () => {
  // A path or query mentioning the suffix proves nothing about where it points.
  expect(isQuickTunnelUrl("https://paddock.example.com/?x=quiet.trycloudflare.com")).toBe(false);
});
