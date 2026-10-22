/**
 * RFC-029 §7 — the work-item tools' mapping: snake_case tool params → the SDK 0.8.0 route and
 * camelCase body, and every refusal said so the model can act on it (the server's `code` plus
 * `missing` / `who_may` / `remedy` / `similar`). The real server's answers are in
 * work-items-real-api.test.ts; this file pins what the plugin SENDS and how it SAYS a refusal.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callWorkTool, labelOf, describeRefusal, renderThreadEventContent, WORK_TOOLS, type WorkDeps } from "../work-tools";

type Sent = { method: string; path: string; body?: unknown };

function fake(answer: (s: Sent) => { status: number; body: any } = () => ({ status: 200, body: {} }), self = "agent-me") {
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
    self: () => self,
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
      body: { id: "m1", channelId: "c1", threadId: T, item: { threadId: T, kind: "bug", status: "triage", assignee: null, parentThreadId: null, dueAt: null, labels: [], review: null }, similar: [{ threadId: "t2", rootMessageId: "r2", title: "Login broken", status: "todo", kind: "bug", reason: null, score: 0.42 }], hold: { state: "held" } },
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
        body: { channelId: "dev", content: "", title: "Login fails", kind: "bug", fields: { what_happened: "a", expected: "b", steps: "c" }, assignee: "me", labels: ["ui"], due: "2026-10-20", parent: "p1", review: true, confirmNew: true },
      },
    ]);
    expect(f.roots).toEqual([{ id: "m1", channelId: "c1", threadId: T, title: "Login fails", text: "" }]);
    expect(out).toMatchObject({ thread_id: T, message_id: "m1", kind: "bug", status: "triage", assignee: null, hold: "held" });
    expect(out).not.toHaveProperty("assignee_id");
    expect(out.similar).toEqual([{ thread_id: "t2", title: "Login broken", kind: "bug", status: "todo", score: 0.42 }]);
    expect(out.hint).toContain("similar thread(s): read them");
    expect(out.hint).toContain("In triage");
  });

  test("create_item without body: a work kind's root is EMPTY (RFC §2); a discussion/question's root is its title; a body is sent as written", async () => {
    const f = fake(() => ({ status: 200, body: { id: "m1", threadId: T } }));
    for (const kind of ["task", "bug", "feature", "request", "discussion", "question"]) await callWorkTool("create_item", { channel_id: "dev", kind, title: "Ship it" }, f.deps);
    await callWorkTool("create_item", { channel_id: "dev", kind: "task", title: "Ship it", body: "details here" }, f.deps);
    expect(f.sent.map((s) => (s.body as any).content)).toEqual(["", "", "", "", "Ship it", "Ship it", "details here"]);
  });

  test("create_item's answer names the assignee with the SDK's principalLabel (S15) — \"you\" for this agent, else @handle — never a raw id", async () => {
    const answer = (assignee: unknown) => () => ({ status: 200, body: { id: "m1", threadId: T, item: { threadId: T, kind: "task", status: "todo", assignee } } });
    const me = JSON.parse(await callWorkTool("create_item", { channel_id: "dev", kind: "task", title: "x", assignee: "me" }, fake(answer({ id: "agent-me", name: "Me", handle: "me", kind: "agent" })).deps));
    expect(me.assignee).toBe("you");
    expect(me.hint).toContain("Assigned:");
    const kai = JSON.parse(await callWorkTool("create_item", { channel_id: "dev", kind: "task", title: "x", assignee: "0199-kai-id" }, fake(answer({ id: "0199-kai-id", name: "Kai", handle: "kai", kind: "agent" })).deps));
    expect(kai.assignee).toBe("@kai");
    expect(JSON.stringify(kai)).not.toContain("0199-kai-id");
    const none = JSON.parse(await callWorkTool("create_item", { channel_id: "dev", kind: "task", title: "x" }, fake(answer(null)).deps));
    expect(none.assignee).toBeNull();
    expect(none.hint ?? "").not.toContain("Assigned:");
  });

  test("labelOf = the SDK's principalLabel: you / @handle / name / a removed agent|person — never the id; no self yet is never \"you\"", () => {
    expect(labelOf({ id: "a1", name: "Alpha", handle: "alpha", kind: "agent" }, "a1")).toBe("you");
    expect(labelOf({ id: "k1", name: "Kai", handle: "kai", kind: "agent" }, "a1")).toBe("@kai");
    expect(labelOf({ id: "k1", name: "Kai", handle: null, kind: "agent" }, "a1")).toBe("Kai");
    expect(labelOf({ id: "k1", name: null, handle: null, kind: "agent" }, "a1")).toBe("a removed agent");
    expect(labelOf({ id: "u1", name: null, handle: null, kind: "human" }, "a1")).toBe("a removed person");
    expect(labelOf({ id: "", name: null, handle: "kai", kind: "agent" }, "")).toBe("@kai");
    expect(labelOf(null, "a1")).toBeNull();
  });

  test("work answers name every principal — assignee, created_by, latest activity's by, without_review's by — never an id", async () => {
    const id = (n: string) => `0199aaaa-0000-7000-8000-00000000${n}`;
    const f = fake(() => ({
      status: 200,
      body: {
        threadId: T,
        assignee: { id: id("beef"), name: null, handle: null, kind: "agent" },
        createdBy: { id: id("f00d"), name: "Jörgen", handle: "jorgen", kind: "human" },
        latestActivity: { action: "progress", by: { id: "agent-me", name: "Me", handle: "me", kind: "agent" } },
        withoutReview: { by: { id: id("d00d"), name: "Ops", handle: null, kind: "human" }, reason: "hotfix" },
      },
    }));
    const out = await callWorkTool("update_item", { thread_id: T, title: "x" }, f.deps);
    expect(JSON.parse(out)).toMatchObject({ assignee: "a removed agent", created_by: "@jorgen", latest_activity: "progress by you", without_review: { by: "Ops", reason: "hotfix" } });
    expect(out).not.toMatch(/0199aaaa/);
  });

  test("every work write's answer is said from this agent's side (self → you): resolve, reopen, triage, add_activity", async () => {
    const f = fake(() => ({ status: 200, body: { threadId: T, eventId: "ev1", status: "in_progress", assignee: { id: "agent-me", name: "Me", handle: "me", kind: "agent" } } }));
    expect(JSON.parse(await callWorkTool("add_activity", { thread_id: T, type: "progress", text: "x" }, f.deps)).item.assignee).toBe("you");
    expect(JSON.parse(await callWorkTool("resolve_item", { thread_id: T, reason: "done" }, f.deps)).assignee).toBe("you");
    expect(JSON.parse(await callWorkTool("reopen_item", { thread_id: T }, f.deps)).assignee).toBe("you");
    expect(JSON.parse(await callWorkTool("triage_item", { thread_id: T, action: "accept" }, f.deps)).assignee).toBe("you");
    const list = fake(() => ({ status: 200, body: { items: [{ threadId: T, assignee: { id: "agent-me", name: "Me", handle: "me", kind: "agent" } }] } }));
    expect(JSON.parse(await callWorkTool("list_items", { assignee: "me" }, list.deps)).items[0].assignee).toBe("you");
  });

  test("add_link names who added it (added_by)", async () => {
    const f = fake(() => ({ status: 200, body: { link: { id: "l2", relation: "related", addedBy: { id: "agent-me", name: "Me", handle: "me", kind: "agent" } }, created: true } }));
    expect(JSON.parse(await callWorkTool("add_link", { thread_id: T, type: "url", url: "https://x" }, f.deps))).toEqual({ link_id: "l2", created: true, relation: "related", added_by: "you" });
  });

  test("create_item confirm_new: only a literal true is sent as confirmNew", async () => {
    const f = fake(() => ({ status: 200, body: { id: "m1", threadId: T } }));
    await callWorkTool("create_item", { channel_id: "dev", kind: "bug", title: "x", confirm_new: false }, f.deps);
    await callWorkTool("create_item", { channel_id: "dev", kind: "bug", title: "x", confirm_new: "true" }, f.deps);
    for (const s of f.sent) expect(s.body).not.toHaveProperty("confirmNew");
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

  test("resolve_item: resolved_in needs component AND version — refused here, nothing sent", async () => {
    const f = fake(() => ({ status: 200, body: { threadId: T } }));
    for (const ri of [{ component: "api" }, { version: "1.2.3" }, { component: "api", version: " " }, {}, "api@1.2.3"]) {
      await expect(callWorkTool("resolve_item", { thread_id: T, reason: "done", conclusion: "ok", resolved_in: ri }, f.deps)).rejects.toThrow("resolved_in needs both component and version");
    }
    expect(f.sent).toEqual([]);
  });

  test("update_item's description: a conversation takes only kind/title/labels; discussion ⇄ question via kind", () => {
    const d = WORK_TOOLS.find((t) => t.name === "update_item")!.description;
    expect(d).toContain("A conversation (discussion, question) takes only kind, title and labels");
    expect(d).toContain("switch discussion ⇄ question with kind");
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
      body: { scope: "work", next: "cur2", items: [{ threadId: T, kind: "bug", status: "todo", title: "x", channelId: "c1", channelName: "dev", assignee: { id: "a", handle: "alpha", kind: "agent", name: "A" }, attention: "quiet", updatedAt: "2026-10-17T00:00:00Z", labels: [], resolvedReason: null, dueAt: null, unreadCount: 0 }, { threadId: "t2", kind: "task", status: "todo", title: "y", channelId: "c1", channelName: "dev", assignee: null, attention: "quiet", updatedAt: "2026-10-17T00:00:00Z", labels: [], resolvedReason: null, dueAt: null, unreadCount: 3 }] },
    }));
    const out = JSON.parse(await callWorkTool("list_items", { assignee: "me", status: ["todo", "in_progress"], kind: "bug", due_before: "2026-11-01", without_review: true, query: "login", limit: 99 }, f.deps));
    const url = new URL(`http://x${f.sent[0]!.path}`);
    expect(url.pathname).toBe("/api/threads");
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "work", q: "login", kind: "bug", status: "todo,in_progress", assignee: "me", dueBefore: "2026-11-01", withoutReview: "true", limit: "50" });
    // #301 unread: shown when there is any, omitted at 0 (the common case).
    expect(out.items).toEqual([
      { thread_id: T, kind: "bug", status: "todo", title: "x", channel: "#dev", assignee: "@alpha", attention: "quiet", updated_at: "2026-10-17T00:00:00Z" },
      { thread_id: "t2", kind: "task", status: "todo", title: "y", channel: "#dev", assignee: null, attention: "quiet", unread: 3, updated_at: "2026-10-17T00:00:00Z" },
    ]);
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

  test("similar_exists lists the candidates and says confirm_new; regression only for a bug resolved done, an open one is replied into", () => {
    const t = describeRefusal(409, { error: "similar_exists", code: "similar_exists", message: "A bug with a near-identical title exists", similar: [{ threadId: "t1", title: "Login fails", status: "todo", kind: "bug", reason: null, score: 0.91 }] }, "");
    expect(t).toContain("409 similar_exists");
    expect(t).toContain('"thread_id":"t1"');
    expect(t).toContain("confirm_new: true");
    expect(t).toContain("an open one: reply into it; a bug resolved done: reopen_item with regression: true");
  });

  test("einweave, never Bridge: refusals, every work tool's text, the work skill", () => {
    expect(describeRefusal(500, null, "boom")).toBe("einweave API error 500: boom");
    expect(describeRefusal(403, { code: "x" }, "")).toStartWith("einweave refused (403 x)");
    expect(JSON.stringify(WORK_TOOLS)).not.toContain("Bridge");
    expect(readFileSync(join(import.meta.dir, "..", "skills", "work", "SKILL.md"), "utf8")).not.toContain("Bridge");
    expect(JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8")).description).toStartWith("einweave channel for Claude Code");
    const row = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8").split("\n").find((l) => l.startsWith("| `read_deliveries` |"));
    expect(row).toContain("Everything einweave still owes this session");
  });

  test("who_can_see's errors say einweave (its source, between its case and the next)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const start = src.indexOf('case "who_can_see": {');
    const end = src.indexOf('case "list_channels": {', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end).replaceAll("requireBridge", ""); // the gate's name is code, not text
    expect(block).toContain("einweave API error");
    expect(block).not.toContain("Bridge");
  });

  test("a 404 says einweave refused", async () => {
    const f = fake(() => ({ status: 404, body: null }));
    await expect(callWorkTool("update_item", { thread_id: T, title: "x" }, f.deps)).rejects.toThrow(/^einweave refused \(404 not_found\)/);
  });

  test("a refusal reaches the caller as a thrown error, with nothing else sent", async () => {
    const f = fake(() => ({ status: 422, body: { error: "due_must_be_date", code: "due_must_be_date" } }));
    await expect(callWorkTool("update_item", { thread_id: T, due: "tomorrow" }, f.deps)).rejects.toThrow(/422 due_must_be_date.*YYYY-MM-DD/);
    expect(f.sent).toHaveLength(1);
  });
});

describe("the work skill's rules", () => {
  const skill = readFileSync(join(import.meta.dir, "..", "skills", "work", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  test("rule 5: an agent requester may withdraw (not_planned) while there is no result", () => {
    expect(skill).toContain('One exception: an item you filed (you are its requester) may be withdrawn by you — `resolve_item(reason: "not_planned")` — while it never had a result.');
  });
  test("rule 2: a regression only for a bug resolved done; an open candidate is replied into", () => {
    expect(skill).toContain("a bug resolved `done` came back — reopen it with `reopen_item(regression: true)`; an open one is still being worked — reply into it instead");
  });
});

describe("an inbound thread_event, said from this agent's side", () => {
  const ME = "agent-me";
  const ev = (action: string, detail: Record<string, unknown>, status: string | null = "todo") =>
    renderThreadEventContent({ threadId: T, action, detail, actorType: "human", actorId: "u1", status, work: { text: "task · todo" }, names: { u1: "@jorgen", "agent-other": "@other" } }, ME);

  test("assigned to me / reassigned AWAY from me (stop) / unassigned from me (stop)", () => {
    expect(ev("assigned", { from: null, to: ME, cause: "work" })).toContain(`Work item ${T}: assigned to you — by human @jorgen`);
    const away = ev("assigned", { from: ME, to: "agent-other", cause: "work" });
    expect(away).toContain("reassigned AWAY from you (now @other)");
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
    expect(ev("reopen", { roundCarried: false, regression: true, text: "broke again" })).toContain('reopened as a REGRESSION (it came back) — by human @jorgen (status todo) — text: "broke again"');
  });

  test("principals are NAMED from the payload's names (S13); this agent is \"you\"; an unnamed principal is \"someone\"", () => {
    const names = { u1: "@jorgen", k1: "@kai", h1: "a removed agent" };
    const say = (action: string, detail: Record<string, unknown>, actorId: string | null = "u1") =>
      renderThreadEventContent({ threadId: T, action, detail, actorType: "human", actorId, status: "todo", work: null, names }, ME);
    expect(say("assigned", { from: null, to: ME })).toContain("assigned to you — by human @jorgen");
    expect(say("assigned", { from: ME, to: "k1" })).toContain("reassigned AWAY from you (now @kai)");
    expect(say("assigned", { from: null, to: "k1" })).toContain("assigned to @kai — by human @jorgen");
    expect(say("unassigned", { from: "k1", to: null })).toContain("unassigned (was @kai)");
    expect(say("needs_input", { to: [ME, "k1"], text: "which db?" })).toContain('NEEDS INPUT from you, @kai — by human @jorgen (status todo) — text: "which db?"');
    expect(say("stuck", { holder: "h1", session: "s1" }, null)).toContain("stuck (status todo) — holder: a removed agent; session: s1");
    expect(say("input_answered", { by: "u1" })).toContain("by: @jorgen");
    expect(say("reopen", { assignee: ME })).toContain("assignee: you");
    expect(say("progress", { text: "k1" }, ME)).toContain('by you (status todo) — text: "k1"'); // free text is never renamed
    // Not in names: a principal is "someone"; an unnamed actor gets no "by" part (never invent a person).
    expect(say("assigned", { from: null, to: "zz" }, "yy")).toContain(`Work item ${T}: assigned to someone (status todo)`);
    expect(say("assigned", { from: null, to: "zz" }, "yy")).not.toContain(" by ");
    expect(say("unassigned", { from: "zz", to: null })).toContain("unassigned (was someone)");
    expect(say("needs_input", { to: ["zz"] })).toContain("NEEDS INPUT from someone");
    expect(say("stuck", { holder: "zz" }, null)).toContain("holder: someone");
  });

  test("an event with NO names prints no principal id anywhere (actor, assignee, detail)", () => {
    const U = (n: number) => `0199aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const cases: [string, Record<string, unknown>][] = [
      ["assigned", { from: U(1), to: U(2), cause: "work" }],
      ["unassigned", { from: U(1), to: null }],
      ["needs_input", { to: [U(3), U(4)], text: "?" }],
      ["input_answered", { by: U(5) }],
      ["reopen", { assignee: U(6) }],
      ["stuck", { holder: U(7), session: "s" }],
      ["triage", { assignee: U(8) }],
      ["kind", { from: "task", to: "bug", doers: [U(9)] }],
    ];
    for (const [action, detail] of cases) {
      const t = renderThreadEventContent({ threadId: T, action, detail, actorType: "agent", actorId: U(10), status: "todo", work: null }, "self-id");
      expect(t.replaceAll(T, ""), action).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(t, action).not.toContain(" by ");
    }
    // A system event has no actor to name.
    expect(renderThreadEventContent({ threadId: T, action: "stuck", detail: {}, actorType: "system", actorId: null, status: "todo", work: null }, null)).not.toContain(" by ");
  });

  test("with no self yet (not authenticated), nothing is \"you\" — a null from is not this agent", () => {
    const t = renderThreadEventContent({ threadId: T, action: "assigned", detail: { from: null, to: "k1" }, actorType: "human", actorId: "u1", status: "todo", work: null, names: { k1: "@kai" } }, null);
    expect(t).toContain("assigned to @kai");
    expect(t).not.toContain("AWAY");
    expect(t).not.toContain("STOP");
  });

  test("resolve: the reason is a label (bare), free text is quoted", () => {
    const t = ev("resolve", { reason: "not_planned", triage: "decline", declineReason: "out of scope", conclusion: null }, "resolved");
    expect(t).toContain("resolved (reason: not_planned)");
    expect(t).toContain('declineReason: "out of scope"');
    expect(t).not.toContain('"not_planned"');
    expect(ev("result", { text: "shipped it" })).toContain('text: "shipped it"');
  });
});
