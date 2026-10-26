import { describe, expect, test } from "bun:test";
import { LOGIN_HEADER, isTailnetRefusal, tailnetRefusal } from "../src/server/tailscale/gate";

const ALLOWED = "operator@github";
const req = (path: string, login?: string) =>
  new Request(`http://127.0.0.1:8789${path}`, {
    headers: login === undefined ? {} : { [LOGIN_HEADER]: login },
  });

describe("tailnet identity gate", () => {
  test("admits the allowed login", () => {
    expect(tailnetRefusal(req("/", ALLOWED), ALLOWED)).toBeNull();
  });

  test("login match ignores case", () => {
    expect(tailnetRefusal(req("/", "Operator@GitHub"), ALLOWED)).toBeNull();
    expect(tailnetRefusal(req("/", "operator@github"), "Operator@GitHub")).toBeNull();
  });

  test("refuses another login with 403 and names it", async () => {
    const res = tailnetRefusal(req("/", "intruder@github"), ALLOWED);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      ok: false,
      detail: "tailnet: Tailscale user intruder@github is not allowed here",
    });
  });

  test("refuses a missing header", async () => {
    const res = tailnetRefusal(req("/"), ALLOWED);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({
      ok: false,
      detail: "tailnet: no Tailscale identity on this request",
    });
  });

  test("refuses an empty header", async () => {
    const res = tailnetRefusal(req("/", "  "), ALLOWED);
    expect(res?.status).toBe(403);
    expect((await res?.json()).detail).toBe("tailnet: no Tailscale identity on this request");
  });

  test("refuses for every path", () => {
    for (const p of ["/", "/sw.js", "/ws", "/mcp", "/api/agents/x/key"]) {
      expect(tailnetRefusal(req(p), ALLOWED)?.status).toBe(403);
    }
  });

  test("an empty allowedLogin admits nobody", () => {
    expect(tailnetRefusal(req("/", ""), "")).not.toBeNull();
    expect(tailnetRefusal(req("/", "operator@github"), "")).not.toBeNull();
    expect(tailnetRefusal(req("/", "operator@github"), "   ")).not.toBeNull();
  });

  test("isTailnetRefusal recognises the body", () => {
    expect(isTailnetRefusal({ ok: false, detail: "tailnet: x" })).toBe(true);
    expect(isTailnetRefusal({ ok: false, detail: "other" })).toBe(false);
    expect(isTailnetRefusal(null)).toBe(false);
    expect(isTailnetRefusal("tailnet: x")).toBe(false);
  });
});
