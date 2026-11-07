/**
 * RFC-027 — link/adapter.ts, the seam between the SDK `Session` and the host:
 * entries → channel notifications, pending until the model has them.
 */
import { describe, test, expect, vi } from "bun:test";
import { Pending, type Entry, type Inbound } from "../vendor/einweave-agent-sdk/index.js";
import { channelAdapter, render, type AdapterDeps, type Rendered } from "../link/adapter";
import { deliveredEntryId } from "../delivery/tags";

const ME = { grant: "01992f6e-0000-7000-8000-00000000aaaa", agent: "agent-me" };

function msg(id: string, over: Partial<Inbound> = {}): Inbound {
  return {
    id,
    channelId: "01992f6e-0000-7000-8000-000000000c01",
    threadId: "01992f6e-0000-7000-8000-000000000f01",
    content: `body ${id}`,
    type: "question",
    createdAt: "2026-10-11T10:00:00Z",
    agentId: "agent-kai",
    agentName: "Kai",
    senderHandle: "kai",
    senderContextId: "01992f6e-0000-7000-8000-00000000bbbb",
    metadata: JSON.stringify({}),
    deliveryReasons: ["broadcast" as never],
    addressed: false,
    ...over,
  } as Inbound;
}
const asEntry = (m: Inbound): Entry => ({ kind: "message", id: m.id, redelivery: false, message: m });

/** The host's rendering of a channel notification (measured shape, delivery/tags.ts). */
function hostTag(r: Rendered): string {
  const attrs = Object.entries(r.meta).map(([k, v]) => `${k}="${v}"`).join(" ");
  return `<channel source="plugin:einweave:einweave" ${attrs}>\n${r.content}\n</channel>`;
}

function harness(over: Partial<AdapterDeps> = {}) {
  const notified: Rendered[] = [];
  const dismissed: string[] = [];
  const pushed: string[] = [];
  const failed: string[] = [];
  const unheld: string[] = [];
  const deps: AdapterDeps = {
    notify: async (r) => void notified.push(r),
    ready: async () => {},
    myGrant: () => ME.grant,
    myAgentId: () => ME.agent,
    isOwnSend: () => false,
    dismiss: (id) => void dismissed.push(id),
    pushed: (e) => void pushed.push(e.id),
    unhold: (id) => void unheld.push(id),
    failed: (e) => void failed.push(e.id),
    ...over,
  };
  return { adapter: channelAdapter(deps), notified, dismissed, pushed, failed, unheld };
}

describe("link/adapter — what reaches the model", () => {
  test("a message's tag leads with channel_id then message_id, so the hook can confirm it", () => {
    const r = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a1")));
    expect(Object.keys(r.meta).slice(0, 2)).toEqual(["channel_id", "message_id"]);
    expect(deliveredEntryId(hostTag(r))).toBe(r.meta.message_id);
    expect(r.meta).toMatchObject({ sender: "Kai", sender_handle: "kai", type: "question", sender_context_id: "01992f6e-0000-7000-8000-00000000bbbb" });
  });

  test("RFC-035 D8: a reply leads with what it answers and names it in reply_to; a plain message has neither", () => {
    const target = { id: "01992f6e-0000-7000-8000-0000000000b9", threadId: "01992f6e-0000-7000-8000-000000000f09", seq: 4, senderName: "Jörgen", senderHandle: "jorgen", senderType: "human" as const, excerpt: "Can you check the deploy?" };
    const r = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a2", { replyTo: target, content: "Done." })));
    expect(r.content).toBe('↪ Jörgen: "Can you check the deploy?"\nDone.');
    expect(r.meta.reply_to).toBe(target.id);
    // The hook's tag rule still holds with the extra attribute.
    expect(Object.keys(r.meta).slice(0, 2)).toEqual(["channel_id", "message_id"]);
    expect(deliveredEntryId(hostTag(r))).toBe(r.meta.message_id);
    // An erased person and a gone target still read as a sentence.
    const gone = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a3", { replyTo: { ...target, senderName: null, senderHandle: null, excerpt: null }, content: "x" })));
    expect(gone.content).toBe("↪ someone: (message unavailable)\nx");
    const quoted = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a5", { replyTo: { ...target, excerpt: 'say "yes" now' }, content: "y" })));
    expect(quoted.content.split("\n")[0]).toBe('↪ Jörgen: "say \\"yes\\" now"');
    const plain = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000a4")));
    expect(plain.content).toBe("body 01992f6e-0000-7000-8000-0000000000a4");
    expect("reply_to" in plain.meta).toBe(false);
  });

  test("thread events and action requests carry their entry id as message_id (after channel_id when there is one)", () => {
    const te: Entry = {
      kind: "thread_event",
      id: "01992f6e-0000-7000-8000-0000000000e1",
      redelivery: false,
      event: {
        id: "01992f6e-0000-7000-8000-0000000000e1",
        threadId: "01992f6e-0000-7000-8000-0000000000f1",
        channelId: "01992f6e-0000-7000-8000-0000000000c1",
        action: "assigned",
        detail: { from: null, to: "01992f6e-0000-7000-8000-0000000000aa", cause: "work" },
        actorId: "01992f6e-0000-7000-8000-0000000000bb",
        actorType: "human",
        occurredAt: "2026-10-11T10:00:00Z",
        status: "todo",
        work: { text: "task · todo\nassignee: @alpha" },
        names: { "01992f6e-0000-7000-8000-0000000000aa": "@alpha", "01992f6e-0000-7000-8000-0000000000bb": "@jorgen" },
      },
    };
    const ar: Entry = { kind: "action_request", id: "01992f6e-0000-7000-8000-0000000000a1", redelivery: false, action: { id: "01992f6e-0000-7000-8000-0000000000a1", action: "restart", params: { force: true } } };
    const rt = render(te);
    expect(Object.keys(rt.meta).slice(0, 2)).toEqual(["channel_id", "message_id"]);
    expect(rt.meta).toMatchObject({ type: "thread_event", action: "assigned", status: "todo", thread_id: "01992f6e-0000-7000-8000-0000000000f1" });
    // The item NOW, as the server rendered it (G11), under the event line.
    expect(rt.content).toContain("Work item 01992f6e-0000-7000-8000-0000000000f1: assigned to @alpha — by human @jorgen (status todo)");
    expect(rt.content).toContain("task · todo\nassignee: @alpha");
    expect(Object.keys(render(ar).meta)[0]).toBe("message_id");
    for (const e of [te, ar]) expect(deliveredEntryId(hostTag(render(e)))).toBe(e.id);
    expect(render(ar).content).toBe('Action requested: restart {"force":true}');
  });

  test("a pushed thread_event is said from THIS session's agent (the live self): assigned to you", async () => {
    const h = harness();
    const te: Entry = {
      kind: "thread_event",
      id: "01992f6e-0000-7000-8000-0000000000e2",
      redelivery: false,
      event: {
        id: "01992f6e-0000-7000-8000-0000000000e2",
        threadId: "01992f6e-0000-7000-8000-0000000000f2",
        channelId: "01992f6e-0000-7000-8000-0000000000c1",
        action: "assigned",
        detail: { from: null, to: ME.agent, cause: "work" },
        actorId: "01992f6e-0000-7000-8000-0000000000bb",
        actorType: "human",
        occurredAt: "2026-10-11T10:00:00Z",
        status: "todo",
        work: null,
        names: { "01992f6e-0000-7000-8000-0000000000bb": "@jorgen" },
      },
    };
    await h.adapter.push!(te);
    expect(h.notified[0]!.content).toContain("Work item 01992f6e-0000-7000-8000-0000000000f2: assigned to you — by human @jorgen");
  });

  test("own send coming back (by grant, or by sent id) → dismissed, never surfaced", async () => {
    const h = harness({ isOwnSend: (id) => id === "sent-by-tool" });
    await h.adapter.push!(asEntry(msg("a1", { senderContextId: ME.grant })));
    await h.adapter.push!(asEntry(msg("sent-by-tool")));
    expect(h.notified).toEqual([]);
    expect(h.dismissed).toEqual(["a1", "sent-by-tool"]);
  });

  test("the agent's other session: a broadcast is dismissed, an addressed one is surfaced", async () => {
    const h = harness();
    await h.adapter.push!(asEntry(msg("b1", { agentId: ME.agent })));
    await h.adapter.push!(asEntry(msg("b2", { agentId: ME.agent, deliveryReasons: ["target" as never], addressed: true })));
    expect(h.dismissed).toEqual(["b1"]);
    expect(h.pushed).toEqual(["b2"]);
  });

  test("RFC-035: the server's `addressed` decides, not this build's vocab -- an unknown reason it addressed is surfaced, a known one it did not is dismissed", async () => {
    const h = harness();
    await h.adapter.push!(asEntry(msg("r1", { agentId: ME.agent, deliveryReasons: ["reply" as never], addressed: true })));
    await h.adapter.push!(asEntry(msg("r2", { agentId: ME.agent, deliveryReasons: ["target" as never], addressed: false })));
    expect(h.pushed).toEqual(["r1"]);
    expect(h.dismissed).toEqual(["r2"]);
  });

  test("RFC-028: a sibling session's contribution to a thread this session holds is surfaced, naming the holder; the old per-message target is gone", async () => {
    const h = harness();
    // A pre-0.31 server stamped contextId; it means nothing now -- the hold is the target.
    await h.adapter.push!(asEntry(msg("e1", { metadata: JSON.stringify({ contextId: "other-grant", contextAgentId: ME.agent }) })));
    await h.adapter.push!(asEntry(msg("e2", { agentId: ME.agent, deliveryReasons: ["thread" as never], addressed: true, metadata: JSON.stringify({ contribution: { holder: { id: ME.grant, label: "my window #aaaa" } } }) })));
    expect(h.dismissed).toEqual([]);
    expect(h.pushed).toEqual(["e1", "e2"]);
    expect(h.notified[0]!.meta.context_id).toBeUndefined();
    expect(h.notified[1]!.meta).toMatchObject({ contribution_holder_id: ME.grant, contribution_holder: "my window #aaaa" });
    expect(Object.keys(h.notified[1]!.meta).slice(0, 2)).toEqual(["channel_id", "message_id"]);
  });

  test("nothing is pushed before the host is ready", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const h = harness({ ready: () => gate });
    const p = h.adapter.push!(asEntry(msg("c1")));
    await Bun.sleep(5);
    expect(h.notified).toEqual([]);
    open();
    await p;
    expect(h.pushed).toEqual(["c1"]);
  });

  test("a notification that fails is reported, the push rejects, and the entry is released from pending (unacked)", async () => {
    const h = harness({ notify: async () => Promise.reject(new Error("transport closed")) });
    await expect(h.adapter.push!(asEntry(msg("d1")))).rejects.toThrow("transport closed");
    expect(h.failed).toEqual(["d1"]);
    expect(h.unheld).toEqual(["d1"]);
    expect(h.pushed).toEqual([]);
    expect(h.dismissed).toEqual([]);
  });

  test("after a failed push, a redelivery is pushed again (the SDK skips anything it still holds as pending)", async () => {
    const pending = new Pending();
    let failNext = true;
    const h = harness({
      notify: async () => {
        if (failNext) throw new Error("transport closed");
      },
      unhold: (id) => pending.remove([id]),
    });
    const entry = asEntry(msg("d2"));
    // What Session.deliver does: skip a held id, otherwise hold it and push.
    const deliver = async () => {
      if (pending.has(entry.id)) return "skipped";
      pending.add({ id: entry.id, kind: "message", pushedAt: null, redelivery: false } as never);
      try {
        await h.adapter.push!(entry);
        pending.markPushed(entry.id, 1);
        return "pushed";
      } catch {
        return "failed";
      }
    };
    expect(await deliver()).toBe("failed");
    failNext = false;
    expect(await deliver()).toBe("pushed");
    expect(h.pushed).toEqual(["d2"]);
  });
});

// RFC-035 follow-ups: "you" in the ↪ line; one ↳ line per referenced message (D5).
describe("link/adapter — references and 'you'", () => {
  const target = { id: "01992f6e-0000-7000-8000-0000000000b9", threadId: "01992f6e-0000-7000-8000-000000000f09", seq: 4, senderName: "Me", senderHandle: "me", senderType: "agent" as const, excerpt: "my own question" };
  test("a reply to this agent's own message reads 'you'", () => {
    const r = render(asEntry(msg("01992f6e-0000-7000-8000-0000000000c1", { replyTo: target, content: "answer" })), ME.agent, { selfHandle: "me" });
    expect(r.content.split("\n")[0]).toBe('↪ you: "my own question"');
  });

  const R = "01992f6e-0000-7000-8000-0000000000d1";
  const G = "01992f6e-0000-7000-8000-0000000000d2";
  const withRefs = (over: Partial<Inbound> = {}) =>
    msg("01992f6e-0000-7000-8000-0000000000c2", {
      content: "see these",
      doc: [["p", 0, "see ", ["ref", { m: R, bare: true }, "https://x"], " and ", ["ref", { m: G }, "that"]]] as never,
      docV: 1,
      ...over,
    });
  const preview = { id: R, threadId: "01992f6e-0000-7000-8000-000000000f0a", seq: 2, channelId: "c1", senderName: "Kai", senderHandle: "kai", senderType: "agent" as const, excerpt: "the plan" };

  test("each referenced message gets a line: who and what (with ids), or that it cannot be seen", () => {
    const r = render(asEntry(withRefs()), ME.agent, { refs: new Map([[R, preview]]) });
    expect(r.content.split("\n")).toEqual([
      "see these",
      `↳ links to Kai: "the plan" (message ${R}, thread ${preview.threadId})`,
      `↳ links to a message you cannot see (${G})`,
    ]);
  });

  test("not looked up, or the lookup failed: no lines — never a false 'cannot see'", () => {
    expect(render(asEntry(withRefs()), ME.agent, {}).content).toBe("see these");
    expect(render(asEntry(withRefs()), ME.agent, { refs: null }).content).toBe("see these");
  });

  test("the push looks the references up first, with this agent's handle", async () => {
    const loadRefs = vi.fn().mockResolvedValue(new Map([[R, { ...preview, senderHandle: "me" }]]));
    const h = harness({ loadRefs, myHandle: () => "me" } as Partial<AdapterDeps>);
    await h.adapter.push!(asEntry(withRefs()));
    expect(loadRefs).toHaveBeenCalledWith([R, G]);
    expect(h.notified[0]!.content).toContain(`↳ links to you: "the plan"`);
  });
});
