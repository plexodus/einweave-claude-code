/**
 * The per-session control socket between this plugin's hooks and its MCP server
 * (RFC-027 D7): `<state>/ctl/c<claude-pid>.sock`, 0600. One NDJSON request and one
 * response per connection. Not the feed socket — that one stays read-only (#228).
 *
 * Four operations, nothing else:
 * - `prompt` (UserPromptSubmit): `id` is the entry the prompt delivered, if any
 *   (`tags.ts`). The server confirms it ONLY if this process holds it pending,
 *   then answers with the missed notice, if any. Sent on every prompt, so its
 *   arrival also proves the hooks run.
 * - `stop` (Stop): the turn ended.
 * - `pending`: metadata of what this process holds pending (`status`, debugging).
 * - `session` (SessionStart): `id` is the conversation id Claude Code now runs. `/clear`
 *   and an interactive `/resume` change it WITHOUT restarting this server, which keeps
 *   the id it was spawned with; the server re-keys if it differs (RFC-028 B4). `source` is
 *   the hook's (startup | resume | clear | compact): only a `clear` declares that the new
 *   conversation replaces the old one (RFC-028 §11). An unknown source is dropped, never a
 *   refusal: a newer Claude Code adding one must not cost the re-key. The answer's `context`
 *   is the note the hook gives the conversation (after `/clear`, after a compaction), or null;
 *   it may take a few seconds (the new session's first `authenticated`).
 *
 * Time is the server's clock at receipt, never the caller's.
 */
export type CtlRequest =
  | { op: "prompt"; id: string | null }
  | { op: "stop" }
  | { op: "pending" }
  | { op: "session"; id: string; source?: SessionSource };

export type CtlResponse =
  | { ok: true; op: "prompt"; confirmed: boolean; context: string | null }
  | { ok: true; op: "stop" }
  | { ok: true; op: "pending"; entries: unknown[] }
  | { ok: true; op: "session"; rekeyed: boolean; context: string | null }
  | { ok: false; error: string };

/** SessionStart's `source` values this build knows. */
export const SESSION_SOURCES = ["startup", "resume", "clear", "compact"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/** A request line is tiny; anything longer is not ours. */
export const MAX_REQUEST_BYTES = 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCtlRequest(line: string): CtlRequest | null {
  if (line.length > MAX_REQUEST_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.op) {
    case "prompt":
      if (o.id === null || o.id === undefined) return { op: "prompt", id: null };
      return typeof o.id === "string" && ID.test(o.id) ? { op: "prompt", id: o.id } : null;
    case "stop":
      return { op: "stop" };
    case "pending":
      return { op: "pending" };
    case "session": {
      if (typeof o.id !== "string" || !ID.test(o.id)) return null;
      const source = (SESSION_SOURCES as readonly unknown[]).includes(o.source) ? (o.source as SessionSource) : undefined;
      return source ? { op: "session", id: o.id, source } : { op: "session", id: o.id };
    }
    default:
      return null;
  }
}
