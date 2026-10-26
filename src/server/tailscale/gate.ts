// Identity gate for the tailnet listener. `tailscale serve` is the only peer
// that connects to that listener (loopback), and it sets this header from the
// authenticated tailnet identity, overwriting any client-supplied value.
// Runs before every route; an empty allowedLogin admits nobody.

export const LOGIN_HEADER = "tailscale-user-login";

const PREFIX = "tailnet: ";

function refuse(reason: string): Response {
  return Response.json({ ok: false, detail: `${PREFIX}${reason}` }, { status: 403 });
}

/** null admits the request; otherwise the 403 to send. */
export function tailnetRefusal(req: Request, allowedLogin: string): Response | null {
  const login = (req.headers.get(LOGIN_HEADER) ?? "").trim();
  if (login === "") return refuse("no Tailscale identity on this request");
  const allowed = allowedLogin.trim().toLowerCase();
  if (allowed === "" || login.toLowerCase() !== allowed) {
    return refuse(`Tailscale user ${login} is not allowed here`);
  }
  return null;
}

export function isTailnetRefusal(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.startsWith(PREFIX);
}
