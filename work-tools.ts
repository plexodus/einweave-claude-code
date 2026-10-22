/**
 * RFC-029 §7 — the work-item tools: create_item, update_item, resolve_item, reopen_item,
 * triage_item, add_activity, add_link, remove_link, list_items, item_schema.
 *
 * Each tool is one SDK 0.8.0 call (`api.threads.{create, work, resolve, reopen, triage,
 * activity, links}`, `api.work.{list, schema}`), made through the host's `apiFetch` (one
 * DPoP proof per request) — same routes, same camelCase bodies. Tool params are snake_case;
 * the HTTP bodies are camelCase (`duplicate_of` ↔ `duplicateOf`).
 *
 * The server is the judge of every rule (authority per field, review policy, triage, CAS):
 * nothing here second-guesses it. A refusal comes back as its machine-readable `code` plus
 * what the server says to do about it (`missing`, `who_may`, `remedy`, `similar`, …), so the
 * model can act on it rather than retry blindly.
 */

import { principalLabel } from "./vendor/einweave-agent-sdk/core/index.js";

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; text: string }>;

export interface WorkDeps {
  api: ApiCall;
  /** This session's agent id ("" before it authenticates): an answer names it "you", never by id. */
  self?: () => string;
  /** A root this session posted (create_item): its echo must be dismissed, and the feed shown it. */
  onRootSent?: (r: { id: string; channelId: string; threadId: string; title: string; text: string }) => void;
}

type Args = Record<string, unknown>;

const enc = encodeURIComponent;
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function need(args: Args, key: string, what?: string): string {
  const v = args[key];
  if (!isStr(v)) throw new Error(`${key} is required${what ? ` — ${what}` : ""}.`);
  return v.trim();
}

/** Only the keys that were given (an absent param never reaches the body as `undefined`). */
function given(pairs: [string, unknown][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of pairs) if (v !== undefined) out[k] = v;
  return out;
}

/** `fix` is `{type, url, title?}` (RFC §7); passed as given — the server judges it (http(s) only). */
function fixOf(v: unknown): unknown {
  return v === null ? undefined : v;
}

function proposedOf(v: unknown): unknown {
  if (!v || typeof v !== "object") return v ?? undefined;
  const p = v as Record<string, unknown>;
  return given([
    ["reason", p.reason],
    ["duplicateOf", p.duplicate_of],
  ]);
}

const CONVERSATION_KINDS: ReadonlySet<string> = new Set(["discussion", "question"]);

const listOf = (v: unknown): string[] | undefined =>
  v === undefined || v === null
    ? undefined
    : Array.isArray(v)
      ? v.map(String)
      : String(v)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

/**
 * A work principal (S15: `{id, name|null, handle|null, kind}` — an assignee, `createdBy`, a link's
 * `addedBy`, an activity's `by`) as an answer names it: the SDK's `principalLabel`, the server's ONE
 * rule — this agent "you", else `@handle`, else the name, else "a removed agent/person"; never the
 * id. null when there is no principal. Shared by every work answer and reply's assign-as-you-reply.
 */
export function labelOf(p: unknown, self: string | null | undefined): string | null {
  if (!p || typeof p !== "object") return null;
  const o = p as { id?: unknown; handle?: unknown; name?: unknown; kind?: unknown };
  return principalLabel(
    { id: typeof o.id === "string" ? o.id : "", handle: isStr(o.handle) ? o.handle : null, name: isStr(o.name) ? o.name : null, kind: o.kind === "human" ? "human" : "agent" },
    self || null
  );
}

/**
 * A refusal, said so the model can act on it: the HTTP status, the server's `code`, and every
 * detail the server sent beside it (`missing`, `field`, `who_may`, `remedy`, `similar`, …).
 */
export function describeRefusal(status: number, body: any, text: string): string {
  if (!body || typeof body !== "object") return `einweave API error ${status}: ${text}`;
  const code = String(body.code ?? body.error ?? "error");
  const { error: _e, code: _c, message, ...rest } = body;
  const parts: string[] = [`einweave refused (${status} ${code})`];
  if (isStr(message)) parts.push(message);
  if (code === "missing_fields" && Array.isArray(rest.missing)) {
    parts.push(`missing required fields: ${rest.missing.join(", ")} — pass them in \`fields\` (item_schema lists each kind's required fields)`);
    delete rest.missing;
  }
  if (code === "not_allowed") {
    if (rest.field) parts.push(`field: ${rest.field}`);
    if (rest.who_may) parts.push(`who may: ${rest.who_may}`);
    if (rest.remedy) parts.push(`remedy: ${rest.remedy}`);
    delete rest.field;
    delete rest.who_may;
    delete rest.remedy;
  }
  if (code === "similar_exists" && Array.isArray(rest.similar)) {
    const list = rest.similar.map(similarRow);
    parts.push(
      `similar: ${JSON.stringify(list)} — if one of these is the same failure, continue it instead of filing a new bug (an open one: reply into it; a bug resolved done: reopen_item with regression: true); only if none is, call create_item again with confirm_new: true`
    );
    delete rest.similar;
  }
  if (code === "due_must_be_date") parts.push("due is a calendar date, YYYY-MM-DD");
  if (code === "join_required") parts.push("this agent is not a member of that channel: call join_channel(channel_id) and try again");
  if (Object.keys(rest).length > 0) parts.push(JSON.stringify(rest));
  return parts.join(" — ");
}

function similarRow(s: any) {
  return given([
    ["thread_id", s.threadId],
    ["title", s.title],
    ["kind", s.kind],
    ["status", s.status],
    ["reason", s.reason ?? undefined],
    ["score", s.score],
  ]);
}

async function call(deps: WorkDeps, method: string, path: string, body?: unknown): Promise<any> {
  const r = await deps.api(method, path, body);
  if (r.status === 404) throw new Error(`einweave refused (404 not_found) — not found, or not readable by this agent (${path.replace(/\?.*$/, "")})`);
  if (r.status < 200 || r.status >= 300) throw new Error(describeRefusal(r.status, r.body, r.text));
  return r.body;
}

/** A work write's answer (`WorkItemFrame`), compact: principals named, nothing the model has no use for. */
export function itemView(f: any, self: string | null = null): Record<string, unknown> {
  if (!f || typeof f !== "object") return {};
  const who = (p: unknown) => labelOf(p, self);
  const la = f.latestActivity;
  return given([
    ["thread_id", f.threadId],
    ["title", f.title],
    ["kind", f.kind],
    ["status", f.status],
    ["resolved_reason", f.resolvedReason ?? undefined],
    ["conclusion", f.conclusion ?? undefined],
    ["assignee", f.assignee === undefined ? undefined : who(f.assignee)],
    ["created_by", f.createdBy ? who(f.createdBy) : undefined],
    ["assignee_joined", f.assigneeJoined],
    ["due", f.dueAt ?? undefined],
    ["labels", Array.isArray(f.labels) && f.labels.length > 0 ? f.labels : undefined],
    ["parent", f.parent ? { thread_id: f.parent.id, title: f.parent.title, status: f.parent.status } : undefined],
    ["children", f.children && f.children.n > 0 ? f.children : undefined],
    ["links", typeof f.links === "number" && f.links > 0 ? f.links : undefined],
    ["latest_activity", la ? `${la.action}${la.by ? ` by ${who(la.by)}` : ""}${la.text ? `: ${la.text}` : ""}` : undefined],
    ["liveness", f.liveness?.text ?? undefined],
    ["without_review", f.withoutReview ? { by: who(f.withoutReview.by), reason: f.withoutReview.reason } : undefined],
    ["changed", f.changed],
  ]);
}

const json = (o: unknown) => JSON.stringify(o, null, 2);

const ASSIGNEE_DOC = "A handle (@name), a principal id, or \"me\".";

export const WORK_TOOLS = [
  {
    name: "create_item",
    description:
      "Start a thread that is a work item (task, bug, feature, request) — or a discussion/question. Call item_schema once per session first: each work kind has required `fields` " +
      "(a 422 missing_fields names the absent ones). The result carries `similar` threads (warn only): READ them — if one is the same work, continue it instead. " +
      "A bug whose title is near-identical to an open (or done) bug is refused once (409 similar_exists) until you pass confirm_new: true. " +
      "An agent's root item naming no assignee, itself or an agent it manages starts in TRIAGE (a channel owner accepts it), as does anything in an intake channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Channel ID or name." },
        kind: { type: "string", enum: ["task", "bug", "feature", "request", "discussion", "question"], description: "The thread's kind." },
        title: { type: "string", description: "The item's title — how it is listed and searched." },
        fields: { type: "object", description: "The kind's fields (item_schema), its required ones included, e.g. a bug's what_happened, expected, steps." },
        body: { type: "string", description: "The root message text. Omitted: a work kind's root is empty (its fields are the item, shown live in its header); a discussion's or question's root is the title." },
        assignee: { type: "string", description: `Who does it. ${ASSIGNEE_DOC}` },
        labels: { type: "array", items: { type: "string" }, description: "Label names (item_schema lists the workspace's)." },
        due: { type: "string", description: "A calendar date, YYYY-MM-DD (422 due_must_be_date otherwise)." },
        parent_thread_id: { type: "string", description: "Make it a sub-item of this item (same channel)." },
        review: { type: "boolean", description: "Override the channel's review policy for this item (false needs an assignee)." },
        confirm_new: { type: "boolean", description: "File the bug although a near-identical one exists (only after a 409 similar_exists, having read the candidates)." },
      },
      required: ["channel_id", "kind", "title"],
    },
  },
  {
    name: "update_item",
    description:
      "Edit a work item: kind, status (open side only: todo, in_progress, needs_input, in_review — resolving is resolve_item), assignee, fields (merge patch; null removes a key), labels {add, remove}, due, title, review. " +
      "A conversation (discussion, question) takes only kind, title and labels — switch discussion ⇄ question with kind. " +
      "All-or-nothing; each field has its own authority — a 403 not_allowed names the first refused field and who may. " +
      "CLAIMING work is update_item(thread_id, assignee: \"me\"): it makes this agent the assignee. That is not `take`, which only moves the thread's hold between this agent's sessions.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The item's thread_id." },
        kind: { type: "string", enum: ["task", "bug", "feature", "request", "discussion", "question"] },
        status: { type: "string", enum: ["todo", "in_progress", "needs_input", "in_review"], description: "An open-side status." },
        text: { type: "string", description: "Why (required when sending an in_review item back: changes requested)." },
        assignee: { type: ["string", "null"], description: `${ASSIGNEE_DOC} null unassigns.` },
        fields: { type: "object", description: "Merge patch of the kind's fields; a key set to null is removed." },
        labels: { type: "object", properties: { add: { type: "array", items: { type: "string" } }, remove: { type: "array", items: { type: "string" } } } },
        due: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear." },
        title: { type: "string" },
        review: { type: ["boolean", "null"], description: "null follows the channel's review policy again." },
        expected_status: { type: "string", description: "Only apply if the item is still in this status (409 status_changed otherwise)." },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "resolve_item",
    description:
      "Resolve (close) a thread with a reason. A work item is resolved by a resolver — a PERSON member the review policy allows; an agent never resolves its own work: it ends with add_activity type: result (proposed {reason}) and a person decides. " +
      "The requester may withdraw (reason not_planned) while the item never had a result. A 403 names the remedy. Pass the item's latest result id (read_thread: work.latest_result_id) as result_event_id.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        reason: { type: "string", enum: ["done", "not_planned", "duplicate", "outdated", "cannot_reproduce"] },
        duplicate_of: { type: "string", description: "With reason duplicate: the original's thread_id." },
        fix: { type: "object", description: "{type, url, title?} — the fix (pull_request, commit, …); url http(s) only.", properties: { type: { type: "string" }, url: { type: "string" }, title: { type: "string" } } },
        resolved_in: { type: "object", description: "{component, version} the fix shipped in — both, or leave it out.", properties: { component: { type: "string" }, version: { type: "string" } } },
        conclusion: { type: "string", description: "What was concluded (a done item needs a fix or a conclusion)." },
        without_review_reason: { type: "string", description: "A person channel owner resolving without review: why." },
        result_event_id: { type: ["string", "null"], description: "The result being approved (work.latest_result_id from read_thread); null = you saw none (409 result_changed if one exists)." },
        expected_status: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "reopen_item",
    description: "Reopen a resolved thread (a work item goes back to todo). regression: true on a bug resolved done reports it came back — pass the reply that reports it (message_id) or text. 409 not_resolved on an open thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        regression: { type: "boolean" },
        message_id: { type: "string", description: "The reply in this thread that reports the regression." },
        text: { type: "string", description: "Why it is reopened." },
        expected_status: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "triage_item",
    description:
      "Settle an item in triage (channel owners): accept (optionally naming the assignee), decline (with a reason), or duplicate (of another item). 409 not_in_triage otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        action: { type: "string", enum: ["accept", "decline", "duplicate"] },
        assignee: { type: "string", description: `accept: ${ASSIGNEE_DOC}` },
        reason: { type: "string", description: "decline: why." },
        duplicate_of: { type: "string", description: "duplicate: the original's thread_id." },
        expected_status: { type: "string" },
      },
      required: ["thread_id", "action"],
    },
  },
  {
    name: "add_activity",
    description:
      "Report on work you are the assignee of — structured, never as a prose reply: plan (items) when you START; progress (text) at least every ~15 minutes on long work (silence reads as stuck); " +
      "needs_input (text, to?) when blocked on someone; result (text, fix?, conclusion?, proposed {reason}) to END your work (a person resolves it, or the review policy does); failed (text) when you cannot do it. " +
      "Returns the event id and the item's status after the implied move.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        type: { type: "string", enum: ["plan", "progress", "needs_input", "result", "failed"] },
        items: { type: "array", description: "plan: the steps — strings, or {text, done?}.", items: { type: ["string", "object"] } },
        text: { type: "string", description: "progress / needs_input / result / failed: what happened." },
        to: { type: "array", items: { type: "string" }, description: "needs_input: who must answer (1-5 handles/ids who can read the item; default the requester)." },
        fix: { type: "object", description: "result: {type, url, title?} (pull_request, commit, branch, …); url http(s) only.", properties: { type: { type: "string" }, url: { type: "string" }, title: { type: "string" } } },
        conclusion: { type: "string", description: "result: what was concluded (when there is no fix)." },
        proposed: { type: "object", description: "result: {reason, duplicate_of?} — the resolution you propose.", properties: { reason: { type: "string" }, duplicate_of: { type: "string" } } },
        expected_status: { type: "string" },
      },
      required: ["thread_id", "type"],
    },
  },
  {
    name: "add_link",
    description: "Attach a link to a work item (pull_request, commit, branch, issue, build, deploy, release, url); re-adding a url updates it. relation fixes marks it the fix.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        type: { type: "string", enum: ["pull_request", "commit", "branch", "issue", "build", "deploy", "release", "url"] },
        url: { type: "string", description: "http(s) only." },
        title: { type: "string" },
        relation: { type: "string", enum: ["related", "fixes"] },
      },
      required: ["thread_id", "type", "url"],
    },
  },
  {
    name: "remove_link",
    description: "Remove a link from a work item (its adder, or who governs the item).",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string" }, link_id: { type: "string" } },
      required: ["thread_id", "link_id"],
    },
  },
  {
    name: "list_items",
    description:
      "List work items across the channels this agent reads — open ones by default. assignee: me lists your work. query searches titles. parent lists an item's sub-items. " +
      "Page with cursor: next. Rows are compact; read_thread(thread_id) shows an item in full.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "task | bug | feature | request (comma list)." },
        status: { type: "string", description: "Comma list (default: the open side: triage, todo, in_progress, needs_input, in_review); resolved for closed ones." },
        assignee: { type: "string", description: "me | none | a handle | an id." },
        channel: { type: "string", description: "One channel (id or name)." },
        parent: { type: "string", description: "A parent item's thread_id." },
        label: { type: "string" },
        severity: { type: "string", description: "Bugs: comma list." },
        due_before: { type: "string", description: "YYYY-MM-DD." },
        resolved_in: { type: "string", description: "component[@version]." },
        without_review: { type: "boolean" },
        attention: { type: "string", description: "not_picked_up | quiet | stuck (comma list)." },
        query: { type: "string", description: "Search titles." },
        sort: { type: "string", enum: ["updated", "created", "due", "severity"] },
        updated_after: { type: "string", description: "ISO timestamp." },
        limit: { type: "number", minimum: 1, maximum: 50 },
        cursor: { type: "string", description: "The `next` of the previous page." },
      },
    },
  },
  {
    name: "item_schema",
    description:
      "The work vocabulary — call it ONCE per session before filing or editing items: kinds with their category, fields, required fields and intake template; statuses; resolve reasons; link types; review policies; the workspace's labels. With channel: that channel's settings (review policy, intake, default kind).",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel ID or name." } },
    },
  },
] as const;

export const WORK_TOOL_NAMES: ReadonlySet<string> = new Set(WORK_TOOLS.map((t) => t.name));

/** The text a work tool answers. Throws a refusal the model can act on. */
export async function callWorkTool(name: string, args: Args, deps: WorkDeps): Promise<string> {
  switch (name) {
    case "create_item": {
      const channelId = need(args, "channel_id", "the channel's id or name");
      const kind = need(args, "kind");
      const title = need(args, "title");
      // RFC §2: the root is only what its author wrote — empty for a work kind; a conversation
      // (discussion, question) is nothing but its posts, so its root defaults to the title.
      const text = isStr(args.body) ? String(args.body) : CONVERSATION_KINDS.has(kind) ? title : "";
      const body = given([
        ["channelId", channelId],
        ["content", text],
        ["title", title],
        ["kind", kind],
        ["fields", args.fields],
        ["assignee", args.assignee],
        ["labels", listOf(args.labels)],
        ["due", args.due],
        ["parent", args.parent_thread_id],
        ["review", args.review],
        ["confirmNew", args.confirm_new === true ? true : undefined],
      ]);
      const r = await call(deps, "POST", "/api/messages", body);
      if (r?.id) deps.onRootSent?.({ id: String(r.id), channelId: String(r.channelId ?? channelId), threadId: String(r.threadId ?? ""), title, text });
      const item = r?.item;
      const similar = Array.isArray(r?.similar) ? r.similar.map(similarRow) : [];
      const status = item?.status ?? r?.status;
      const hints: string[] = [];
      if (similar.length > 0) hints.push(`${similar.length} similar thread(s): read them — if one is the same work, continue it there and say so here.`);
      if (status === "triage") hints.push("In triage: a channel owner accepts it (triage_item) before work starts.");
      if (item?.assignee) hints.push("Assigned: the assignee works it with add_activity (plan → progress → result).");
      return json(
        given([
          ["thread_id", r?.threadId],
          ["message_id", r?.id],
          ["kind", item?.kind ?? kind],
          ["status", status],
          ["assignee", item ? labelOf(item.assignee, deps.self?.()) : undefined],
          ["assignee_joined", item?.assigneeJoined],
          ["parent_thread_id", item?.parentThreadId ?? undefined],
          ["due", item?.dueAt ?? undefined],
          ["hold", r?.hold?.state],
          ["similar", similar],
          ["hint", hints.length > 0 ? hints.join(" ") : undefined],
        ])
      );
    }

    case "update_item": {
      const threadId = need(args, "thread_id");
      const labels = args.labels && typeof args.labels === "object" ? (args.labels as Record<string, unknown>) : undefined;
      const body = given([
        ["kind", args.kind],
        ["status", args.status],
        ["text", args.text],
        ["assignee", args.assignee],
        ["fields", args.fields],
        ["labels", labels ? given([["add", listOf(labels.add)], ["remove", listOf(labels.remove)]]) : undefined],
        ["due", args.due],
        ["title", args.title],
        ["review", args.review],
        ["expectedStatus", args.expected_status],
      ]);
      if (Object.keys(body).length === 0) throw new Error("name at least one thing to change (kind, status, assignee, fields, labels, due, title, review).");
      return json(itemView(await call(deps, "PUT", `/api/threads/${enc(threadId)}/work`, body), deps.self?.()));
    }

    case "resolve_item": {
      const threadId = need(args, "thread_id");
      const ri = args.resolved_in as Record<string, unknown> | undefined;
      if (ri !== undefined && ri !== null && !(typeof ri === "object" && isStr(ri.component) && isStr(ri.version))) {
        throw new Error('resolved_in needs both component and version, e.g. {component: "api", version: "1.2.3"} — nothing was sent.');
      }
      const body = given([
        ["reason", args.reason],
        ["duplicateOf", args.duplicate_of],
        ["conclusion", args.conclusion],
        ["fix", fixOf(args.fix)],
        ["resolvedIn", ri && typeof ri === "object" ? given([["component", ri.component], ["version", ri.version]]) : undefined],
        ["withoutReview", isStr(args.without_review_reason) ? { reason: args.without_review_reason } : undefined],
        ["resultEventId", args.result_event_id],
        ["expectedStatus", args.expected_status],
      ]);
      return json(itemView(await call(deps, "POST", `/api/threads/${enc(threadId)}/resolve`, body), deps.self?.()));
    }

    case "reopen_item": {
      const threadId = need(args, "thread_id");
      const body = given([
        ["regression", args.regression === true ? true : undefined],
        ["messageId", args.message_id],
        ["text", args.text],
        ["expectedStatus", args.expected_status],
      ]);
      return json(itemView(await call(deps, "POST", `/api/threads/${enc(threadId)}/reopen`, body), deps.self?.()));
    }

    case "triage_item": {
      const threadId = need(args, "thread_id");
      const action = need(args, "action", "accept, decline or duplicate");
      let body: Record<string, unknown>;
      if (action === "accept") body = given([["action", action], ["assignee", args.assignee]]);
      else if (action === "decline") body = { action, reason: need(args, "reason", "why it is declined") };
      else if (action === "duplicate") body = { action, duplicateOf: need(args, "duplicate_of", "the original's thread_id") };
      else throw new Error(`action must be accept, decline or duplicate, got ${JSON.stringify(action)}`);
      if (args.expected_status !== undefined) body.expectedStatus = args.expected_status;
      return json(itemView(await call(deps, "POST", `/api/threads/${enc(threadId)}/triage`, body), deps.self?.()));
    }

    case "add_activity": {
      const threadId = need(args, "thread_id");
      const type = need(args, "type", "plan, progress, needs_input, result or failed");
      const items = Array.isArray(args.items) ? args.items.map((i) => (typeof i === "string" ? { text: i } : i)) : args.items;
      const body = given([
        ["type", type],
        ["items", items],
        ["text", args.text],
        ["to", listOf(args.to)],
        ["fix", fixOf(args.fix)],
        ["conclusion", args.conclusion],
        ["proposed", proposedOf(args.proposed)],
        ["expectedStatus", args.expected_status],
      ]);
      const r = await call(deps, "POST", `/api/threads/${enc(threadId)}/activity`, body);
      return json({ event_id: r?.eventId, status: r?.status, item: itemView(r, deps.self?.()) });
    }

    case "add_link": {
      const threadId = need(args, "thread_id");
      const body = given([
        ["type", need(args, "type")],
        ["url", need(args, "url")],
        ["title", args.title],
        ["relation", args.relation],
      ]);
      const r = await call(deps, "POST", `/api/threads/${enc(threadId)}/links`, body);
      return json(
        given([
          ["link_id", r?.link?.id],
          [r?.created ? "created" : "updated", true],
          ["relation", r?.link?.relation],
          ["added_by", r?.link?.addedBy ? labelOf(r.link.addedBy, deps.self?.()) : undefined],
        ])
      );
    }

    case "remove_link": {
      const threadId = need(args, "thread_id");
      const linkId = need(args, "link_id");
      const r = await call(deps, "DELETE", `/api/threads/${enc(threadId)}/links/${enc(linkId)}`);
      return json({ removed: r?.removed === true, link_id: linkId });
    }

    case "list_items": {
      const p = new URLSearchParams({ scope: "work" });
      const set = (k: string, v: unknown) => {
        if (v === undefined || v === null || v === "") return;
        p.set(k, Array.isArray(v) ? v.join(",") : String(v));
      };
      set("channel", args.channel);
      set("q", args.query);
      set("kind", args.kind);
      set("status", args.status);
      set("assignee", args.assignee);
      set("label", args.label);
      set("parent", args.parent);
      set("severity", args.severity);
      set("dueBefore", args.due_before);
      set("resolvedIn", args.resolved_in);
      if (args.without_review === true) p.set("withoutReview", "true");
      set("attention", args.attention);
      set("updatedAfter", args.updated_after);
      set("sort", args.sort);
      const limit = Number(args.limit);
      if (Number.isInteger(limit) && limit > 0) p.set("limit", String(Math.min(limit, 50)));
      set("cursor", args.cursor);
      const r = await call(deps, "GET", `/api/threads?${p}`);
      const rows = (r?.items ?? []).map((i: any) =>
        given([
          ["thread_id", i.threadId],
          ["kind", i.kind],
          ["status", i.status],
          ["title", i.title],
          ["channel", i.channelName ? `#${i.channelName}` : i.channelId],
          ["assignee", i.assignee ? labelOf(i.assignee, deps.self?.()) : null],
          ["due", i.dueAt ?? undefined],
          ["severity", i.severity ?? undefined],
          ["resolved_reason", i.resolvedReason ?? undefined],
          ["attention", i.attention],
          // #301: unread for THIS reader, by the thread list's rule (0 omitted: the common case).
          ["unread", i.unreadCount ? i.unreadCount : undefined],
          ["updated_at", i.updatedAt],
        ])
      );
      return json({ count: rows.length, next: r?.next ?? null, ...(r?.next ? { hint: `More: list_items(..., cursor: ${JSON.stringify(r.next)})` } : {}), items: rows });
    }

    case "item_schema": {
      const q = isStr(args.channel) ? `?channel=${enc(String(args.channel).trim())}` : "";
      return json(await call(deps, "GET", `/api/work-schema${q}`));
    }
  }
  throw new Error(`unknown work tool: ${name}`);
}

/**
 * Detail keys whose value is someone's free TEXT: always quoted (JSON), so a reader can tell
 * what a person wrote from what einweave says. Every other string is a label (an enum such as a
 * resolve `reason`, a status, a cause) or an id, printed bare.
 */
const FREE_TEXT = new Set(["text", "conclusion", "declineReason", "title", "message"]);
/** Keys the event line already says (or that only the server needs). */
const SAID = new Set(["from", "to", "regression", "roundCarried"]);

function clip(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * The detail keys that hold a PRINCIPAL id, per action — the server's `PRINCIPAL_DETAIL_KEYS`
 * (S13, work/header.ts) plus `kind`'s doers, which the server leaves unnamed on purpose. A value
 * under one of these is always said as a name, never printed: "someone" when `names` lacks it.
 */
const PRINCIPAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  assigned: ["to", "from"],
  unassigned: ["to", "from"],
  triage: ["assignee"],
  needs_input: ["to"],
  input_answered: ["by"],
  reopen: ["assignee"],
  review: ["for"],
  stuck: ["holder"],
  kind: ["doers", "doersStrict"],
};

/**
 * How an event line names a principal (S13; the same rule as OpenClaw 2.2.0's): this agent is
 * "you"; anyone else by the payload's `names` (`@handle`, else the name, else "a removed
 * agent/person"); an id `names` lacks is "someone". A raw id is never printed — agents have no
 * roster, so an id tells the model nothing and invites it to guess.
 */
interface Namer {
  isSelf(v: unknown): boolean;
  /** A name the payload (or self) gives this id, else null. */
  known(v: unknown): string | null;
  /** A principal said as a name: known, else "someone". */
  name(v: unknown): string;
}

function namer(self: string | null, names: Readonly<Record<string, string>> | null | undefined): Namer {
  const isSelf = (v: unknown) => !!self && v === self;
  const table = names && typeof names === "object" ? names : {};
  const known = (v: unknown) => (isSelf(v) ? "you" : typeof v === "string" && Object.hasOwn(table, v) && isStr(table[v]) ? table[v]! : null);
  return { isSelf, known, name: (v) => known(v) ?? "someone" };
}

/** A detail, said in one short line: labels bare, free text quoted, objects as JSON, principals named. */
function detailLine(action: string, detail: Record<string, unknown>, skip: ReadonlySet<string>, n: Namer): string {
  const parts: string[] = [];
  const principal = new Set(PRINCIPAL_KEYS[action] ?? []);
  // A principal key is always a name; any other string is renamed only when it IS a known principal.
  const say = (k: string, x: unknown) => (typeof x !== "string" ? x : principal.has(k) ? n.name(x) : (n.known(x) ?? x));
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || skip.has(k)) continue;
    const free = FREE_TEXT.has(k);
    const named = free ? v : Array.isArray(v) ? v.map((x) => say(k, x)) : say(k, v);
    const s = typeof named === "string" && !free ? named : JSON.stringify(named);
    parts.push(`${k}: ${clip(s)}`);
  }
  return parts.join("; ");
}

/** What the event means to THIS agent, in words — the parts that change what it should do. */
function headline(action: string, d: Record<string, unknown>, n: Namer): { what: string; skip: Set<string> } {
  const skip = new Set(SAID);
  switch (action) {
    case "assigned":
      if (n.isSelf(d.to)) return { what: "assigned to you", skip };
      if (n.isSelf(d.from)) return { what: `reassigned AWAY from you${isStr(d.to) ? ` (now ${n.name(d.to)})` : ""} — it is no longer yours: STOP working on it`, skip };
      return { what: `assigned${isStr(d.to) ? ` to ${n.name(d.to)}` : ""}`, skip };
    case "unassigned":
      if (n.isSelf(d.from)) return { what: "unassigned from you — it is no longer yours: STOP working on it", skip };
      return { what: `unassigned${isStr(d.from) ? ` (was ${n.name(d.from)})` : ""}`, skip };
    case "status":
      if (d.from === "in_review" && typeof d.text === "string") {
        skip.add("text");
        return { what: `CHANGES REQUESTED (${String(d.from)} → ${String(d.to)}): ${JSON.stringify(clip(d.text))}`, skip };
      }
      return { what: `status ${String(d.from)} → ${String(d.to)}`, skip };
    case "needs_input": {
      const to = Array.isArray(d.to) ? d.to : d.to === undefined || d.to === null ? [] : [d.to];
      return { what: to.length > 0 ? `NEEDS INPUT from ${to.map(n.name).join(", ")}` : "needs input", skip };
    }
    case "reopen":
      return { what: d.regression === true ? "reopened as a REGRESSION (it came back)" : "reopened", skip };
    case "resolve":
      skip.add("reason");
      return { what: `resolved (reason: ${String(d.reason)})`, skip };
    default:
      return { what: action, skip };
  }
}

/**
 * A `thread_event` entry (RFC-029 §6) as the model reads it: what happened to which item — said
 * from THIS agent's side (`self`: a reassignment away tells it to stop; it is "you") and naming
 * everyone else by the payload's `names` — and the item NOW, the server's rendered header
 * (`work.text`, G11). The same text on a live push and on `read_deliveries` (a resumed session
 * drains the same entry).
 */
export function renderThreadEventContent(
  e: {
    threadId: string;
    action: string;
    detail: Record<string, unknown> | null;
    actorType: string;
    actorId: string | null;
    status: string | null;
    work: { text: string } | null;
    names?: Record<string, string> | null;
  },
  self: string | null = null
): string {
  const n = namer(self, e.names);
  // Only a NAMED actor is said: a system event, or one whose actor `names` lacks, has no "by"
  // part at all ("by someone" would invent a person).
  const actor = e.actorType === "system" || !e.actorId ? null : n.isSelf(e.actorId) ? "you" : n.known(e.actorId);
  const by = actor === null ? "" : actor === "you" ? " — by you" : ` — by ${e.actorType} ${actor}`;
  const detail = e.detail && typeof e.detail === "object" ? e.detail : {};
  const h = headline(e.action, detail, n);
  const d = detailLine(e.action, detail, h.skip, n);
  const head = `Work item ${e.threadId}: ${h.what}${by}${e.status ? ` (status ${e.status})` : ""}${d ? ` — ${d}` : ""}`;
  const tail = `read_thread(thread_id: "${e.threadId}") shows it in full.`;
  return e.work?.text ? `${head}\n${e.work.text}\n${tail}` : `${head}\n${tail}`;
}
