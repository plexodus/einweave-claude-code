/**
 * The pane's data, over a private per-session Unix socket (`delivery/ctl-path.ts` uiSocketPath).
 *
 * WHY. The mod read its thread pages, channel lists and snapshots by calling this plugin's own MCP
 * tools, and Claude Code applies its MODEL-facing tool-output limit (MAX_MCP_OUTPUT_TOKENS, 25k tokens)
 * to those results: a long thread page (88,741 chars, 2026-11-03) came back as an error. The pane is a
 * person looking, not a model reading, so it reads over HTTP from here instead (`$.http.fetch` with
 * `socketPath`), whole. The `ui_*` MCP tools stay as the fallback and keep their size budget.
 *
 * ROUTES (JSON): GET `/state`, `/channels`, `/channel/:id`, `/thread/:id?before_seq=&limit=`,
 * `/search?q=&type=&sort=&cursor=&limit=` (RFC-031; no body);
 * POST `/tool/:name` with a JSON object of arguments: an action a PERSON started in the pane (Take,
 * Release, Connect, a `/einweave` command), run by the same code as the MCP tool of that name and
 * answered with its result. Only the tools the routes allow (server.ts PERSON_TOOLS): the socket is not
 * a way to run any tool. A route that fails answers `{ error }` with a 4xx/5xx; anything else is 404.
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
  /** RFC-031: one search page; a refused query is a value in the answer, not an error. */
  search(p: { query: string; type?: "threads" | "messages"; sort?: "relevance" | "newest"; cursor?: string; limit?: number }): Promise<unknown>;
  /** A person's action: the MCP tool `name`'s result; a tool not allowed is a UiHttpError 403. */
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** This agent's other sessions, read now (the Hand over picker opens on it): `{ sessions: UiSession[] }`. */
  sessions(): Promise<unknown>;
  /** The mod's report of what this window's model is doing (`working` | `needs_you` | `idle`); a bad state is a UiHttpError 400. */
  turn(state: string): Promise<unknown>;
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
/** An action's arguments: a label, a ref, a channel list. Far under this. */
const MAX_BODY = 4096;

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
    if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "GET or POST only" });
    if (req.url.length > MAX_URL) return json(414, { error: "request too long" });
    const url = new URL(req.url);
    const [, head, rest, ...more] = url.pathname.split("/");
    // POST is an action (a tool, a turn report), and only that; a GET carries no body: refuse one rather than read it.
    const post = req.method === "POST";
    if (post !== (head === "tool" || head === "turn")) return json(405, { error: post ? "GET only here" : "POST only" });
    if (!post && (req.body !== null || req.headers.has("transfer-encoding") || Number(req.headers.get("content-length") ?? 0) > 0)) return json(400, { error: "no body expected" });
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
        if (head === "sessions" && rest === undefined) return json(200, await routes.sessions());
        if (head === "channel" && rest !== undefined) return json(200, await routes.channel(id));
        if (head === "tool" && rest !== undefined) {
          const text = await req.text();
          if (text.length > MAX_BODY) return json(413, { error: "arguments too large" });
          let args: unknown;
          try {
            args = text ? JSON.parse(text) : {};
          } catch {
            return json(400, { error: "arguments are not JSON" });
          }
          if (!args || typeof args !== "object" || Array.isArray(args)) return json(400, { error: "arguments must be an object" });
          return json(200, await routes.tool(id, args as Record<string, unknown>));
        }
        if (head === "turn" && rest !== undefined) return json(200, await routes.turn(id));
        if (head === "search" && rest === undefined) {
          const q = url.searchParams;
          const query = q.get("q") ?? "";
          if (!query.trim()) return json(400, { error: "q is required" });
          const type = q.get("type");
          const sort = q.get("sort");
          if (type !== null && type !== "threads" && type !== "messages") return json(400, { error: "bad type" });
          if (sort !== null && sort !== "relevance" && sort !== "newest") return json(400, { error: "bad sort" });
          return json(200, await routes.search({ query, type: type ?? undefined, sort: sort ?? undefined, cursor: q.get("cursor") ?? undefined, limit: intParam(q.get("limit")) }));
        }
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
    server = Bun.serve({ unix: tmp, maxRequestBodySize: MAX_BODY, fetch: uiHandler(o.routes) });
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
