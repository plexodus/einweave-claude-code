/**
 * RFC-035 D8: the reply tool's reply-to arguments (reply-to.ts) and what read rows say about references.
 * The send itself is covered against a real server in reply-to-real-api.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { planReplyTo, referenceFields } from "../reply-to";
import { parseMessageRef } from "../holds";

const M = "01992f6e-0000-7000-8000-0000000000b9";
const T = "01992f6e-0000-7000-8000-000000000f09";
const C = "01992f6e-0000-7000-8000-000000000c01";
const LINKS = { thread: "https://web.example/w/ws1/c/{channelId}/t/{threadId}", message: "https://web.example/w/ws1/c/{channelId}/t/{threadId}/m/{id}" };

describe("reply_to: a message id or a message link", () => {
  test("a bare id, or the segment after /m/ — never another uuid in the link", () => {
    expect(parseMessageRef(M.toUpperCase())).toBe(M);
    expect(parseMessageRef(` https://web.example/w/ws1/c/${C}/t/${T}/m/${M} `)).toBe(M);
    expect(parseMessageRef(`https://web.example/w/ws1/c/${C}/t/${T}/m/${M}?x=1`)).toBe(M);
    // A thread link names no message: refused, not read as its thread id.
    expect(parseMessageRef(`https://web.example/w/ws1/c/${C}/t/${T}`)).toBeNull();
    for (const bad of ["", "the deploy one", 42, null, undefined, `${M}x`]) expect(parseMessageRef(bad)).toBeNull();
  });
});

describe("planReplyTo", () => {
  test("no reply_to: nothing changes; new_thread and silent alone are refused", () => {
    expect(planReplyTo({ thread_id: T, title: "x" })).toEqual({ kind: "none" });
    expect(planReplyTo({ new_thread: true }).kind).toBe("refused");
    expect(planReplyTo({ silent: true }).kind).toBe("refused");
  });

  test("with thread_id: that thread; without: the target's thread; silent rides along", () => {
    expect(planReplyTo({ reply_to: M, thread_id: T, silent: true })).toEqual({ kind: "in_thread", replyTo: M, silent: true });
    expect(planReplyTo({ reply_to: M })).toEqual({ kind: "target_thread", replyTo: M, silent: false });
  });

  test("a title never forks silently: it needs new_thread; new_thread never with thread_id", () => {
    const titled = planReplyTo({ reply_to: M, title: "Follow-up" });
    expect(titled.kind).toBe("refused");
    expect((titled as { why: string }).why).toContain("new_thread");
    expect(planReplyTo({ reply_to: M, title: "Follow-up", new_thread: true })).toEqual({ kind: "new_thread", replyTo: M, silent: false });
    expect(planReplyTo({ reply_to: M, thread_id: T, new_thread: true }).kind).toBe("refused");
  });

  test("an unreadable reply_to is refused before anything is sent", () => {
    expect(planReplyTo({ reply_to: "seq 12" }).kind).toBe("refused");
  });
});

describe("referenceFields (read rows)", () => {
  const ref = { id: M, threadId: T, seq: 3, senderName: null, senderHandle: "kai", senderType: "agent" as const, excerpt: "Ship it?" };

  test("url from the server's template, reply_to named, replied_elsewhere only when there are some", () => {
    const id = "01992f6e-0000-7000-8000-0000000000a1";
    expect(referenceFields({ id, threadId: T, replyTo: ref, repliedElsewhere: 2 }, C, LINKS)).toEqual({
      url: `https://web.example/w/ws1/c/${C}/t/${T}/m/${id}`,
      reply_to: { id: M, sender: "@kai", excerpt: "Ship it?", thread_id: T },
      replied_elsewhere: 2,
    });
    expect(referenceFields({ id, threadId: T, repliedElsewhere: 0 }, C, LINKS)).toEqual({ url: `https://web.example/w/ws1/c/${C}/t/${T}/m/${id}` });
  });

  test("no links (no web app, older server) or a template slot this build does not know: no url, never half a link", () => {
    expect(referenceFields({ id: M, threadId: T }, C, null)).toEqual({});
    expect(referenceFields({ id: M, threadId: T }, C, { thread: LINKS.thread, message: `${LINKS.message}?r={region}` })).toEqual({});
  });
});

test("a title with reply_to AND thread_id is refused in words that fit it (it cannot fork)", () => {
  const r = planReplyTo({ reply_to: "01992f6e-0000-7000-8000-0000000000b9", thread_id: "01992f6e-0000-7000-8000-000000000f09", title: "x" });
  expect(r.kind).toBe("refused");
  expect((r as { why: string }).why).toContain("title only names a new thread");
});
