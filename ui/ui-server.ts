/**
 * The pane's data, over a private per-session Unix socket (`delivery/ctl-path.ts` uiSocketPath).
 *
 * WHY. The mod read its thread pages, channel lists and snapshots by calling this plugin's own MCP
 * tools, and Claude Code applies its MODEL-facing tool-output limit (MAX_MCP_OUTPUT_TOKENS, 25k tokens)
 * to those results: a long thread page (88,741 chars, 2026-11-03) came back as an error. The pane is a
 * person looking, not a model reading, so it reads over HTTP from here instead (`$.http.fetch` with
 * `socketPath`), whole. The `ui_*` MCP tools stay as the fallback and keep their size budget.
 *
 * ROUTES (GET only, JSON): `/state`, `/channels`, `/channel/:id`, `/thread/:id?before_seq=&limit=`.
 * A route that fails answers `{ error }` with a 4xx/5xx; anything else is 404; a body is refused.
 *
 * SAFETY is the control socket's, copied rather than reinvented (delivery/ctl-server.ts): the socket is
 * 0600 in a directory verified 0700 and ours (private-dir.ts) before anything is bound; it binds at a
 * private temp name and is `rename`d onto the public path (atomic, replacing an older socket with no
 * unlink window, never visible with a wider mode); and `stop()` removes the public path only if it is
 * still the file WE created. Measured on Bun 1.4: `Bun.serve({ unix })` unlinks only the path it bound
 * (the temp name, already renamed away), so unlike a hand-rolled check it never touches the public one.
 * Whether to serve at all is the control socket's decision (delivery/ctl-manager.ts opens this only after
 * it holds the ctl socket), so this binds over whatever is there.
 */
import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import { ensurePrivateDir } from "../delivery/private-dir";

/** A route's refusal, with the status to answer. Any other throw is a 500. */
export class UiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What each route returns: the plain view object, serialised here. */
export interface UiRoutes {
  state(): Promise<unknown>;
  channels(): Promise<unknown>;
  channel(id: string): Promise<unknown>;
  thread(id: string, page: { beforeSeq?: number; limit?: number }): Promise<unknown>;
}

export interface UiServerOptions {
  path: string;
  routes: UiRoutes;
  log: (line: string) => void;
}

export interface UiServer {
  path: string;
  /** Is the public path still the socket this server created? "replaced": another process bound it since. */
  ownership(): "ours" | "replaced" | "gone";
  stop(): void;
}

export type UiOpen = { server: UiServer; failure?: undefined } | { server: null; failure: string };

/** A request line longer than this is not ours (ids are UUIDs). */
const MAX_URL = 2048;
const MAX_ID = 256;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A non-negative safe integer from a query value, else undefined. */
function intParam(v: string | null): number | undefined {
  if (v === null || !/^\d{1,16}$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function uiHandler(routes: UiRoutes): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "GET") return json(405, { error: "GET only" });
    if (req.url.length > MAX_URL) return json(414, { error: "request too long" });
    // A GET carries no body here: refuse one rather than read it.
    if (req.body !== null || req.headers.has("transfer-encoding") || Number(req.headers.get("content-length") ?? 0) > 0) return json(400, { error: "no body expected" });
    const url = new URL(req.url);
    const [, head, rest, ...more] = url.pathname.split("/");
    let id = "";
    if (rest !== undefined) {
      try {
        id = decodeURIComponent(rest);
      } catch {
        return json(400, { error: "bad id" });
      }
      if (!id || id.length > MAX_ID) return json(400, { error: "bad id" });
    }
    try {
      if (more.length === 0) {
        if (head === "state" && rest === undefined) return json(200, await routes.state());
        if (head === "channels" && rest === undefined) return json(200, await routes.channels());
        if (head === "channel" && rest !== undefined) return json(200, await routes.channel(id));
        if (head === "thread" && rest !== undefined) {
          return json(200, await routes.thread(id, { beforeSeq: intParam(url.searchParams.get("before_seq")), limit: intParam(url.searchParams.get("limit")) }));
        }
      }
    } catch (err) {
      const status = err instanceof UiHttpError ? err.status : 500;
      return json(status, { error: err instanceof Error ? err.message : String(err) });
    }
    return json(404, { error: "not found" });
  };
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Never throws: a socket that cannot open is a failure the caller logs, and the mod reads over MCP. */
export function openUiServer(o: UiServerOptions): UiOpen {
  let server: Server<undefined> | undefined;
  let mine: { ino: number; dev: number } | null = null;
  const tmp = `${o.path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 6)}`;
  try {
    const safe = ensurePrivateDir(dirname(o.path));
    if (!safe.ok) {
      o.log(`einweave ui: data socket not started — ${safe.reason}; the pane reads over MCP`);
      return { server: null, failure: safe.reason };
    }
    server = Bun.serve({ unix: tmp, maxRequestBodySize: 1024, fetch: uiHandler(o.routes) });
    chmodSync(tmp, 0o600);
    const st = lstatSync(tmp);
    mine = { ino: st.ino, dev: st.dev };
    renameSync(tmp, o.path);
  } catch (err) {
    try {
      void server?.stop(true);
    } catch {}
    try {
      unlinkSync(tmp);
    } catch {}
    const detail = err instanceof Error ? err.message : String(err);
    o.log(`einweave ui: data socket not started (the pane reads over MCP): ${detail}`);
    return { server: null, failure: detail };
  }
  const ownership = (): "ours" | "replaced" | "gone" => {
    const cur = lstatOrNull(o.path);
    if (!cur) return "gone";
    return mine && cur.ino === mine.ino && cur.dev === mine.dev ? "ours" : "replaced";
  };
  return {
    server: {
      path: o.path,
      ownership,
      stop() {
        // Bun unlinks only the temp name, which the rename already moved away.
        try {
          void server!.stop(true);
        } catch {}
        if (ownership() === "ours") {
          try {
            unlinkSync(o.path);
          } catch {}
        }
      },
    },
  };
}
