/**
 * Client for the running Herdr app's own command socket.
 *
 * Space and tab names live in the app's layout document, which paddock never
 * writes. The only safe rename is to ask the running app to do it. Wire
 * format (docs/probes/2026-11-09-herdr-core.md, step 5c): one newline-terminated
 * JSON line per connection, `{"do":"space.rename","args":{"id","name"}}`,
 * answered by `{"ok":true}` or `{"error":"<text>"}`. A second line on the same
 * connection is not answered, so every call opens its own connection.
 *
 * Ids are RAW app ids. A paddock core id (`hc.` prefix) is accepted and
 * stripped here, so callers may pass either.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCoreId, rawCoreId } from "@shared/origin";

export const OPEN_HERDR_TO_RENAME = "Open Herdr to rename app spaces";

/** The operation cannot be done right now; the message says what to do. */
export class Unsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unsupported";
  }
}

export interface AppSocket {
  available(): Promise<boolean>;
  renameSpace(id: string, name: string): Promise<void>;
  renameTab(id: string, name: string): Promise<void>;
}

export function defaultAppSocketPath(): string {
  return join(process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"), "herdr-app.sock");
}

const TIMEOUT_MS = 3000;

/** Send one line, resolve with the one line that comes back. */
function request(path: string, msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => { reject(new Error("herdr app did not answer")); });
      sock.then((s) => s.end(), () => {});
    }, TIMEOUT_MS);
    const sock = Bun.connect({
      unix: path,
      socket: {
        open(s) { s.write(JSON.stringify(msg) + "\n"); },
        data(s, chunk) {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          // Settle first: ending the socket fires `close` synchronously.
          finish(() => {
            try { resolve(JSON.parse(line)); }
            catch { reject(new Error(`herdr app sent an unreadable reply: ${line.slice(0, 80)}`)); }
          });
          s.end();
        },
        close() {
          finish(() => { reject(new Error("herdr app closed the connection without answering")); });
        },
        error(_s, e) { finish(() => { reject(e); }); },
      },
    });
    sock.catch((e) => finish(() => { reject(e); }));
  });
}

export function createAppSocket(path: string = defaultAppSocketPath()): AppSocket {
  async function available(): Promise<boolean> {
    // A stale socket file survives a crashed app, so existence is not enough:
    // the app must accept a connection.
    if (!existsSync(path)) return false;
    try {
      const s = await Bun.connect({ unix: path, socket: { data() {}, error() {} } });
      s.end();
      return true;
    } catch {
      // Refused or vanished: the app is not running. That is the answer, not a failure.
      return false;
    }
  }

  async function call(verb: string, id: string, name: string): Promise<void> {
    if (!(await available())) throw new Unsupported(OPEN_HERDR_TO_RENAME);
    const raw = isCoreId(id) ? rawCoreId(id) : id;
    const reply = await request(path, { do: verb, args: { id: raw, name } });
    if (reply && typeof reply.error === "string") throw new Error(reply.error);
    if (!reply || reply.ok !== true) throw new Error(`herdr app gave an unexpected reply to ${verb}`);
  }

  return {
    available,
    renameSpace: (id, name) => call("space.rename", id, name),
    renameTab: (id, name) => call("tab.rename", id, name),
  };
}
