/**
 * Web app links for people (RFC-035 D1). The SERVER owns the link grammar: `GET /api/me/workspace`
 * (`api.me.workspace()`) hands out `links`, RFC 6570 level-1 URI templates for a thread and a message.
 * A client only fills the slots — never builds a path itself — so the grammar, a route or a per-tenant
 * domain can change without a client release (the same rule as `Inbound.addressed`: the server states
 * it). Ids only, never names, never `seq`. Whether the reader may open the link is the server's call
 * when they do.
 */
/** `GET /api/me/workspace` → `links`: slots `{channelId}`, `{threadId}`, and `{id}` (the message). */
export interface WorkspaceLinks {
    thread: string;
    message: string;
}
/**
 * RFC 6570 level 1 (simple string expansion): each `{name}` → its value, percent-encoded as a whole
 * (a value is a segment, never a path). A slot with no value throws — a half-filled link is worse
 * than none, and a slot this build does not know means the server's grammar outgrew it.
 */
export declare function expandLink(template: string, values: Readonly<Record<string, string>>): string;
/** A thread, opened in the web app. */
export declare function threadUrl(links: WorkspaceLinks, t: {
    channelId: string;
    threadId: string;
}): string;
/** One message, opened in its thread. */
export declare function messageUrl(links: WorkspaceLinks, m: {
    channelId: string;
    threadId: string;
    id: string;
}): string;
