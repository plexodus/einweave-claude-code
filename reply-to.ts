/**
 * RFC-035 D8: the `reply` tool's reply-to arguments, checked before anything is sent.
 *
 * - `reply_to` + `thread_id`: a reply in that thread, answering the target (maybe from another thread).
 * - `reply_to` alone: the reply goes in the TARGET's thread (resolved by the caller via `/location`).
 * - `reply_to` + `new_thread`: a new thread in the target's channel that answers it.
 * A habitual `title` must never fork a conversation silently, so `title` with `reply_to` needs `new_thread`.
 */
import { parseMessageRef } from "./holds";
import { messageUrl, type ReplyRef, type WorkspaceLinks } from "./vendor/einweave-agent-sdk/core/index.js";
import type { MessageRefPreview } from "./vendor/einweave-agent-sdk/index.js";
import { refIdsOf, replySender } from "./link/adapter";

export type ReplyToPlan =
  | { kind: "none" }
  | { kind: "in_thread"; replyTo: string; silent: boolean } // thread_id given
  | { kind: "target_thread"; replyTo: string; silent: boolean } // resolve the target's thread
  | { kind: "new_thread"; replyTo: string; silent: boolean }
  | { kind: "refused"; why: string };

export function planReplyTo(args: Record<string, unknown>): ReplyToPlan {
  const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
  const newThread = args.new_thread === true;
  const silent = args.silent === true;
  const threadId = has("thread_id");
  if (!has("reply_to")) {
    if (newThread) return { kind: "refused", why: "new_thread applies with reply_to (a new thread that answers a message). To start a plain thread, omit thread_id." };
    if (silent) return { kind: "refused", why: "silent applies with reply_to: it stops the reply from notifying the author of the message it answers." };
    return { kind: "none" };
  }
  const replyTo = parseMessageRef(args.reply_to);
  if (!replyTo) return { kind: "refused", why: "reply_to takes a message id or a message link (its url)." };
  if (newThread) {
    if (threadId) return { kind: "refused", why: "pass thread_id OR new_thread, not both: new_thread starts a thread, thread_id replies in one." };
    return { kind: "new_thread", replyTo, silent };
  }
  if (has("title")) {
    return {
      kind: "refused",
      why: threadId
        ? "title only names a new thread: drop it to reply in thread_id, or pass new_thread: true instead of thread_id."
        : "title with reply_to would start a new thread: pass new_thread: true as well to do that, or drop title to answer in the message's thread.",
    };
  }
  return threadId ? { kind: "in_thread", replyTo, silent } : { kind: "target_thread", replyTo, silent };
}

/**
 * RFC-035 D8: what a read row says about references -- its own `url` (from the server's link template;
 * absent when the workspace has no web app), the message it answers, and how many replies to it went
 * to OTHER threads (`replied_elsewhere`, thread reads only; absent when none).
 */
export function referenceFields(
  m: { id: string; threadId?: string | null; replyTo?: ReplyRef | null; repliedElsewhere?: number; doc?: unknown },
  channelId: string | null,
  links: WorkspaceLinks | null,
  refs?: ReadonlyMap<string, MessageRefPreview> | null,
  selfHandle?: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (links && channelId && m.threadId) {
    try {
      out.url = messageUrl(links, { channelId, threadId: m.threadId, id: m.id });
    } catch {
      // A template slot this build does not know: no link beats a half-filled one.
    }
  }
  if (m.replyTo) {
    out.reply_to = { id: m.replyTo.id, sender: replySender(m.replyTo, selfHandle), excerpt: m.replyTo.excerpt, thread_id: m.replyTo.threadId };
  }
  // RFC-035 D5: the messages its text links to (when they were looked up): who and what, or that this
  // agent may not see it. A failed lookup adds nothing — never a false "cannot see".
  const ids = refs ? refIdsOf(m.doc) : [];
  if (ids.length > 0) {
    out.links_to = ids.map((id) => {
      const r = refs!.get(id);
      return r
        ? { id, sender: replySender(r, selfHandle), excerpt: r.excerpt, thread_id: r.threadId, channel_id: r.channelId }
        : { id, unavailable: true };
    });
  }
  if (typeof m.repliedElsewhere === "number" && m.repliedElsewhere > 0) out.replied_elsewhere = m.repliedElsewhere;
  return out;
}
