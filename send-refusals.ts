// RFC-034: a send the server refuses before storing it answers `{error, code, message}`
// (422 message_too_complex, 503 parser_busy, 429 parser_throttled, 500 parser_error).
// The `message` says the message was NOT sent and what to do, so the model sees it verbatim.
// One rule for every tool: apiFetch runs each response through `handleRefusal`.

const REFUSAL_CODES = new Set(["message_too_complex", "parser_busy", "parser_throttled", "parser_error"]);

/** Longest Retry-After honoured for the single parser_busy retry. */
export const BUSY_RETRY_CAP_MS = 5000;

export interface Refusal {
  code: string;
  message: string;
}

async function readRefusal(res: Response): Promise<Refusal | null> {
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

/**
 * Passes `res` through, retries once (`retry`) on parser_busy (refused before insert, so a
 * resend cannot duplicate), or throws an error that leads with the server's message.
 * `busyRetried` is true on the response to that retry: a second busy is reported, not retried.
 */
export async function handleRefusal(
  res: Response,
  path: string,
  retry: () => Promise<Response>,
  busyRetried = false,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Response> {
  const refusal = await readRefusal(res);
  if (!refusal) return res;
  if (refusal.code === "parser_busy" && res.status === 503 && !busyRetried) {
    const s = Number(res.headers.get("retry-after"));
    await sleep(Math.min(Number.isFinite(s) && s > 0 ? s * 1000 : 1000, BUSY_RETRY_CAP_MS));
    return retry();
  }
  throw new Error(`${refusal.message} (einweave ${res.status} ${refusal.code}, ${path})`);
}
