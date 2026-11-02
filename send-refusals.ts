// RFC-034: a send the server refuses before storing it answers `{error, code, message}`
// (422 message_too_complex, 503 parser_busy, 429 parser_throttled, 500 parser_error).
// The `message` says the message was NOT sent and what to do, so the model sees it verbatim.
// Only the two message routes emit these, so only message sends (`reply`, `create_item`)
// go through `sendMessage`; no other request is retried or re-worded.

const REFUSAL_CODES = new Set(["message_too_complex", "parser_busy", "parser_throttled", "parser_error"]);

/** Longest Retry-After honoured for the single parser_busy retry. */
const BUSY_RETRY_CAP_MS = 5000;

async function readRefusal(res: Response): Promise<{ code: string; message: string } | null> {
  if (res.ok) return null;
  try {
    const body = (await res.clone().json()) as { error?: unknown; code?: unknown; message?: unknown };
    const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "";
    if (!REFUSAL_CODES.has(code) || typeof body.message !== "string" || !body.message) return null;
    return { code, message: body.message };
  } catch {
    return null;
  }
}

/** Is `res` an RFC-034 refusal? (apiFetch lets a 429 one through, so the sender can say what the server said.) */
export async function isSendRefusal(res: Response): Promise<boolean> {
  return (await readRefusal(res)) !== null;
}

/**
 * Sends a message through `attempt` (ONE request, no retry of its own) and returns the
 * response. The body carries a `clientMsgId` (minted here when absent) so the server
 * dedupes a repeat per (channel, sender): the single retry on 503 parser_busy — Retry-After
 * honoured, default 1 s, capped at 5 s — re-sends the SAME body and cannot double-post.
 * Any refusal is thrown as an error that leads with the server's message; every other
 * response (2xx, or an error with its own handling) is returned with its body unread.
 */
export async function sendMessage(
  attempt: (body: Record<string, unknown>) => Promise<Response>,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Response> {
  const sent = typeof body.clientMsgId === "string" && body.clientMsgId ? body : { ...body, clientMsgId: crypto.randomUUID() };
  let res = await attempt(sent);
  let refusal = await readRefusal(res);
  if (refusal?.code === "parser_busy" && res.status === 503) {
    const s = Number(res.headers.get("retry-after"));
    await sleep(Math.min(Number.isFinite(s) && s > 0 ? s * 1000 : 1000, BUSY_RETRY_CAP_MS));
    res = await attempt(sent);
    refusal = await readRefusal(res);
  }
  if (refusal) throw new Error(`${refusal.message} (einweave ${res.status} ${refusal.code})`);
  return res;
}
