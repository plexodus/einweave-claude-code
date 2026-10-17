/**
 * RFC-029 §7 — the work-item tools' mapping: snake_case tool params → the SDK 0.8.0 route and
 * camelCase body, and every refusal said so the model can act on it (the server's `code` plus
 * `missing` / `who_may` / `remedy` / `similar`). The real server's answers are in
 * work-items-real-api.test.ts; this file pins what the plugin SENDS and how it SAYS a refusal.
 */
import { test, expect, describe } from "bun:test";
import { callWorkTool, describeRefusal, renderThreadEventContent, WORK_TOOLS, type WorkDeps } from "../work-tools";

type Sent = { method: string; path: string; body?: unknown };

function fake(answer: (s: Sent) => { status: number; body: any } = () => ({ status: 200, body: {} })) {
  const sent: Sent[] = [];
  const roots: unknown[] = [];
  const deps: WorkDeps = {
    api: async (method, path, body) => {
      const s = { method, path, ...(body !== undefined ? { body } : {}) };
      sent.push(s);
      const a = answer(s);
      return { status: a.status, body: a.body, text: JSON.stringify(a.body) };
    },
    onRootSent: (r) => roots.push(r),
  };
  return { deps, sent, roots };
}

const T = "01a1499b-dbc7-7001-a4bb-d6b6fa14e01b";

describe("work tools → SDK 0.8.0 routes and bodies", () => {
  test("the tool set is RFC §7's", () => {
    expect(WORK_TOOLS.map((t): string => t.name).sort()).toEqual(
      ["add_activity", "add_link", "create_item", "item_schema", "list_items", "reopen_item", "remove_link", "resolve_item", "triage_item", "update_item"].sort()
    );
  });

  test("create_item: POST /api/messages with the work fields; the root is reported as this session's own send", async () => {
    const f = fake(() => ({
      status: 200,
      body: { id: "m1", channelId: "c1", threadId: T, item: { threadId: T, kind: "bug", status: "triage", assigneeId: null, parentThreadId: null, dueAt: null, labels: [], review: null }, similar: [{ threadId: "t2", rootMessageId: "r2", title: "Login broken", status: "todo", kind: "bug", reason: null, score: 0.42 }], hold: { state: "held" } },
    }));
    const out = JSON.parse(
      await callWorkTool(
        "create_item",
        { channel_id: "dev", kind: "bug", title: "Login fails", fields: { what_happened: "a", expected: "b", steps: "c" }, labels: ["ui"], due: "2026-10-20", parent_thread_id: "p1", review: true, confirm_new: true, assignee: "me" },
        f.deps
      )
    );
    expect(f.sent).toEqual([
      {
        method: "POST",
        path: "/api/messages",
        body: { channelId: "dev", content: "Login fails", title: "Login fails", kind: "bug", fields: { what_happened: "a", expected: "b", steps: "c" }, assignee: "me", labels: ["ui"], due: "2026-10-20", parent: "p1", review: true, confirmNew: true },
      },
    ]);
    expect(f.roots).toEqual([{ id: "m1", channelId: "c1", threadId: T, title: "Login fails", text: "Login fails" }]);
    expect(out).toMatchObject({ thread_id: T, message_id: "m1", kind: "bug", status: "triage", assignee_id: null, hold: "held" });
    expect(out.similar).toEqual([{ thread_id: "t2", title: "Login broken", kind: "bug", status: "todo", score: 0.42 }]);
    expect(out.hint).toContain("similar thread(s): read them");
    expect(out.hint).toContain("In triage");
  });

  test("update_item: PUT /work, only the given keys; labels {add, remove}; null kept (unassign / clear due)", async () => {
    const f = fake(() => ({ status: 200, body: { threadId: T, title: "x", kind: "task", status: "todo", assignee: null, changed: true } }));
    const out = JSON.parse(await callWorkTool("update_item", { thread_id: T, assignee: null, due: null, labels: { add: ["a"], remove: "b,c" }, expected_status: "in_progress" }, f.deps));
    expect(f.sent).toEqual([{ method: "PUT", path: `/api/threads/${T}/work`, body: { assignee: null, labels: { add: ["a"], remove: ["b", "c"] }, due: null, expectedStatus: "in_progress" } }]);
    expect(out).toMatchObject({ thread_id: T, status: "todo", assignee: null, changed: true });
    await expect(callWorkTool("update_item", { thread_id: T }, f.deps)).rejects.toThrow("name at least one thing");
  });

  test("claim = update_item assignee: \"me\"", async () => {
    const f = fake(() => ({ status: 200, body: { threadId: T, assignee: { id: "a1", handle: "alpha", kind: "agent", name: "Alpha" }, status: "todo" } }));
    const out = JSON.parse(await callWorkTool("update_item", { thread_id: T, assignee: "me" }, f.deps));
    expect(f.sent[0]!.body).toEqual({ assignee: "me" });
    expect(out.assignee).toBe("@alpha");
  });

  test("resolve_item: D6 body (duplicateOf, fix, resolvedIn, withoutReview, resultEventId)", async () => {
    const f = fake(() => ({ status: 200, body: { threadId: T, status: "resolved", resolvedReason: "done" } }));
    await callWorkTool(
      "resolve_item",
      { thread_id: T, reason: "done", fix: { type: "pull_request", url: "https://x/pr/1" }, resolved_in: { component: "api", version: "1.2.3" }, without_review_reason: "hotfix", result_event_id: "ev1", conclusion: "ok" },
      f.deps
    );
    expect(f.sent[0]).toEqual({
      method: "POST",
      path: `/api/threads/${T}/resolve`,
      body: { reason: "done", conclusion: "ok", fix: { type: "pull_request", url: "https://x/pr/1" }, resolvedIn: { component: "api", version: "1.2.3" }, withoutReview: { reason: "hotfix" }, resultEventId: "ev1" },
    });
    await callWorkTool("resolve_item", { thread_id: T, reason: "duplicate", duplicate_of: "t0" }, f.deps);
    expect(f.sent[1]!.body).toEqual({ reason: "duplicate", duplicateOf: "t0" });
  });

  test("reopen_item, triage_item (per action), add_link, remove_link", async () => {
    const f = fake((s) => ({ status: 200, body: s.path.endsWith("/links") ? { link: { id: "l1", relation: "fixes" }, created: true } : s.method === "DELETE" ? { removed: true } : { threadId: T } }));
    await callWorkTool("reopen_item", { thread_id: T, regression: true, message_id: "m9", text: "back" }, f.deps);
    await callWorkTool("triage_item", { thread_id: T, action: "accept", assignee: "@kai" }, f.deps);
    await callWorkTool("triage_item", { thread_id: T, action: "decline", reason: "no" }, f.deps);
    await callWorkTool("triage_item", { thread_id: T, action: "duplicate", duplicate_of: "t0" }, f.deps);
    const link = JSON.parse(await callWorkTool("add_link", { thread_id: T, type: "pull_request", url: "https://x/pr/1", relation: "fixes" }, f.deps));
    const rm = JSON.parse(await callWorkTool("remove_link", { thread_id: T, link_id: "l1" }, f.deps));
    expect(f.sent.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", `/api/threads/${T}/reopen`, { regression: true, messageId: "m9", text: "back" }],
      ["POST", `/api/threads/${T}/triage`, { action: "accept", assignee: "@kai" }],
      ["POST", `/api/threads/${T}/triage`, { action: "decline", reason: "no" }],
      ["POST", `/api/threads/${T}/triage`, { action: "duplicate", duplicateOf: "t0" }],
      ["POST", `/api/threads/${T}/links`, { type: "pull_request", url: "https://x/pr/1", relation: "fixes" }],
      ["DELETE", `/api/threads/${T}/links/l1`, undefined],
    ]);
    expect(link).toEqual({ link_id: "l1", created: true, relation: "fixes" });
    expect(rm).toEqual({ removed: true, link_id: "l1" });
    await expect(callWorkTool("triage_item", { thread_id: T, action: "decline" }, f.deps)).rejects.toThrow("reason is required");
  });

  test("add_activity: plan items from strings; result with proposed {reason, duplicate_of}; answers event id + status", async () => {
    const f = fake(() => ({ status: 200, body: { eventId: "ev7", status: "in_progress", threadId: T } }));
    const out = JSON.parse(await callWorkTool("add_activity", { thread_id: T, type: "plan", items: ["a", { text: "b", done: true }] }, f.deps));
    await callWorkTool("add_activity", { thread_id: T, type: "result", text: "done", proposed: { reason: "duplicate", duplicate_of: "t0" }, fix: { type: "commit", url: "https://x/c/1" } }, f.deps);
    await callWorkTool("add_activity", { thread_id: T, type: "needs_input", text: "which?", to: "@kai" }, f.deps);
    expect(f.sent.map((s) => s.body)).toEqual([
      { type: "plan", items: [{ text: "a" }, { text: "b", done: true }] },
      { type: "result", text: "done", fix: { type: "commit", url: "https://x/c/1" }, proposed: { reason: "duplicate", duplicateOf: "t0" } },
      { type: "needs_input", text: "which?", to: ["@kai"] },
    ]);
    expect(out).toMatchObject({ event_id: "ev7", status: "in_progress" });
  });

  test("list_items: GET /api/threads?scope=work with camelCase filters; compact rows; next", async () => {
    const f = fake(() => ({
      status: 200,
      body: { scope: "work", next: "cur2", items: [{ threadId: T, kind: "bug", status: "todo", title: "x", channelId: "c1", channelName: "dev", assignee: { id: "a", handle: "alpha", kind: "agent", name: "A" }, attention: "quiet", updatedAt: "2026-10-17T00:00:00Z", labels: [], resolvedReason: null, dueAt: null }] },
    }));
    const out = JSON.parse(await callWorkTool("list_items", { assignee: "me", status: ["todo", "in_progress"], kind: "bug", due_before: "2026-11-01", without_review: true, query: "login", limit: 99 }, f.deps));
    const url = new URL(`http://x${f.sent[0]!.path}`);
    expect(url.pathname).toBe("/api/threads");
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "work", q: "login", kind: "bug", status: "todo,in_progress", assignee: "me", dueBefore: "2026-11-01", withoutReview: "true", limit: "50" });
    expect(out.items).toEqual([{ thread_id: T, kind: "bug", status: "todo", title: "x", channel: "#dev", assignee: "@alpha", attention: "quiet", updated_at: "2026-10-17T00:00:00Z" }]);
    expect(out.next).toBe("cur2");
  });

  test("item_schema: GET /api/work-schema[?channel=]", async () => {
    const f = fake(() => ({ status: 200, body: { kinds: [] } }));
    await callWorkTool("item_schema", {}, f.deps);
    await callWorkTool("item_schema", { channel: "dev" }, f.deps);
    expect(f.sent.map((s) => s.path)).toEqual(["/api/work-schema", "/api/work-schema?channel=dev"]);
  });
});

describe("refusals name the fix", () => {
  test("missing_fields names each missing field", () => {
    const t = describeRefusal(422, { error: "missing_fields", code: "missing_fields", missing: ["what_happened", "steps"] }, "");
    expect(t).toContain("422 missing_fields");
    expect(t).toContain("missing required fields: what_happened, steps");
  });

  test("not_allowed carries field, who may and the remedy", () => {
    const t = describeRefusal(403, { error: "not_allowed", code: "not_allowed", field: "resolve", who_may: "a resolver", remedy: "an agent never resolves: post your result" }, "");
    expect(t).toContain("403 not_allowed");
    expect(t).toContain("field: resolve");
    expect(t).toContain("who may: a resolver");
    expect(t).toContain("remedy: an agent never resolves: post your result");
  });

  test("similar_exists lists the candidates and says confirm_new", () => {
    const t = describeRefusal(409, { error: "similar_exists", code: "similar_exists", message: "A bug with a near-identical title exists", similar: [{ threadId: "t1", title: "Login fails", status: "todo", kind: "bug", reason: null, score: 0.91 }] }, "");
    expect(t).toContain("409 similar_exists");
    expect(t).toContain('"thread_id":"t1"');
    expect(t).toContain("confirm_new: true");
  });

  test("a refusal reaches the caller as a thrown error, with nothing else sent", async () => {
    const f = fake(() => ({ status: 422, body: { error: "due_must_be_date", code: "due_must_be_date" } }));
    await expect(callWorkTool("update_item", { thread_id: T, due: "tomorrow" }, f.deps)).rejects.toThrow(/422 due_must_be_date.*YYYY-MM-DD/);
    expect(f.sent).toHaveLength(1);
  });
});

describe("an inbound thread_event, said from this agent's side", () => {
  const ME = "agent-me";
  const ev = (action: string, detail: Record<string, unknown>, status: string | null = "todo") =>
    renderThreadEventContent({ threadId: T, action, detail, actorType: "human", actorId: "u1", status, work: { text: "task · todo" } }, ME);

  test("assigned to me / reassigned AWAY from me (stop) / unassigned from me (stop)", () => {
    expect(ev("assigned", { from: null, to: ME, cause: "work" })).toContain(`Work item ${T}: assigned to you — by human u1`);
    const away = ev("assigned", { from: ME, to: "agent-other", cause: "work" });
    expect(away).toContain("reassigned AWAY from you (now agent-other)");
    expect(away).toContain("STOP working on it");
    expect(ev("unassigned", { from: ME, to: null, cause: "work" })).toContain("unassigned from you — it is no longer yours: STOP working on it");
    // Someone else's reassignment is not an order to this agent.
    expect(ev("assigned", { from: "x", to: "y" })).not.toContain("STOP");
  });

  test("changes requested (in_review → back, with text) quotes the text", () => {
    const t = ev("status", { from: "in_review", to: "in_progress", text: "add a test" }, "in_progress");
    expect(t).toContain('CHANGES REQUESTED (in_review → in_progress): "add a test"');
  });

  test("a regression is a reopen {regression: true}", () => {
    expect(ev("reopen", { roundCarried: false, regression: true, text: "broke again" })).toContain('reopened as a REGRESSION (it came back) — by human u1 (status todo) — text: "broke again"');
  });

  test("resolve: the reason is a label (bare), free text is quoted", () => {
    const t = ev("resolve", { reason: "not_planned", triage: "decline", declineReason: "out of scope", conclusion: null }, "resolved");
    expect(t).toContain("resolved (reason: not_planned)");
    expect(t).toContain('declineReason: "out of scope"');
    expect(t).not.toContain('"not_planned"');
    expect(ev("result", { text: "shipped it" })).toContain('text: "shipped it"');
  });
});
