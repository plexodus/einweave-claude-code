/**
 * The model's "your question was seen" line (✓✓, first `seen` only).
 *
 * RFC-039 D4: a session's id and name reach only its agent and the agent's managers, so a receipt
 * from an agent this one does not manage carries `contextId`/`contextLabel` null. The line names
 * the AGENT; a session label, when the server sends one, is someone else's text and is quoted as
 * data. A raw id is never the name ("seen by null" was the pre-D4 fallback).
 */
export interface SeenReceipt {
  messageId: string;
  agentId: string;
  contextId?: string | null;
  contextLabel?: string | null;
  at?: string | null;
}

export function seenLine(
  type: string,
  r: SeenReceipt,
  agentName: string | null
): { content: string; meta: Record<string, string> } {
  const who = agentName ? JSON.stringify(agentName) : "an agent";
  const session = r.contextLabel ? ` (session ${JSON.stringify(r.contextLabel)})` : "";
  return {
    content: `✓✓ Your ${type} (${r.messageId}) was seen by ${who}${session} at ${r.at ?? "now"}.`,
    meta: {
      type: "receipt",
      message_id: r.messageId,
      seen_by_agent: r.agentId,
      ...(r.contextId ? { seen_by_context: r.contextId } : {}),
      ...(r.contextLabel ? { seen_by_label: r.contextLabel } : {}),
    },
  };
}

/**
 * Agent id → name, from the directory (`GET /api/agents`). One fetch fills every name; a miss
 * refetches at most once per `missTtlMs` (a new agent appears; a failed fetch is not cached).
 */
export function agentNames(fetchAgents: () => Promise<{ id: string; name: string }[] | null>, missTtlMs = 60_000) {
  const names = new Map<string, string>();
  let inflight: Promise<void> | null = null;
  let lastFetch = 0;
  return async function nameOf(id: string): Promise<string | null> {
    const hit = names.get(id);
    if (hit) return hit;
    if (!inflight && Date.now() - lastFetch >= missTtlMs) {
      inflight = (async () => {
        const list = await fetchAgents().catch(() => null);
        if (!list) return;
        lastFetch = Date.now();
        for (const a of list) if (a?.id && a?.name) names.set(a.id, a.name);
      })().finally(() => (inflight = null));
    }
    if (inflight) await inflight;
    return names.get(id) ?? null;
  };
}
