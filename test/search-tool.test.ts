/**
 * `search` (RFC-031): the real plugin over stdio against a stub `/api/search` that answers in the
 * server's shapes (bridge `packages/api/src/search/search.ts`; SDK 0.25.0 types).
 *
 * What it pins: the query and its options reach the server encoded; a snippet's private-use marks
 * (U+E000/U+E001) never reach the model — hits come back as **bold**; names are cleaned of control
 * characters; "1000+" when the total is capped; a refusal (422) is an answer with its reason and
 * suggestions, not an error; a server without search (404) says so; bad arguments are refused here.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = join(import.meta.dir, "..", "server.ts");
const ENROLMENT_KEY = mintAgentToken("ek");
const S = "";
const E = "";

type Answer = { status: number; body: unknown };
type Stub = { port: number; connected: () => boolean; calls: URL[]; answer: (a: Answer) => void; stop: () => void };

const threadPage = {
  query: { text: "deploy window", filters: [{ key: "in", value: "ch-1", label: "in:#ops" }], sort: "relevance" },
  results: [
    {
      thread: {
        id: "t-1", title: "Deploy\u001b[31m window today", kind: "question", status: "open",
        channel: { id: "ch-1", name: "ops", archived: false }, assignee: { id: "p-1", name: "Kevin", handle: "kevin", kind: "human" },
        lastActivityAt: "2026-11-03T09:40:00.000Z", replyCount: 4,
      },
      match: { in: "message", snippet: `pushing after the ${S}deploy${E} ${S}window${E} closes`, messageId: "m-9" },
      matchingReplies: 3,
    },
    {
      thread: {
        id: "t-2", title: "Deployment checklist", kind: "task", status: "todo",
        channel: { id: "ch-1", name: "ops", archived: false }, assignee: null,
        lastActivityAt: "2026-11-01T09:40:00.000Z", replyCount: 0,
      },
      match: { in: "title", snippet: "Deployment checklist", fuzzy: true },
      matchingReplies: 0,
    },
  ],
  next: "cur/sor=",
  total: { count: 1000, capped: true },
};
const messagePage = {
  query: { text: "deploy", filters: [], sort: "newest" },
  results: [
    {
      message: { id: "m-9", threadId: "t-1", seq: 12, sender: { id: "a-1", name: "Brian", handle: "brian", kind: "agent" }, createdAt: "2026-11-03T09:41:00.000Z" },
      thread: { id: "t-1", title: "Deploy window today", kind: "question", status: "open" },
      channel: { id: "ch-1", name: "ops", archived: false },
      snippet: `is the ${S}deploy${E} still on`,
    },
  ],
  next: null,
  total: { count: 1, capped: false },
};

function startStub(): Stub {
  let socket: unknown = null;
  const calls: URL[] = [];
  let next: Answer = { status: 200, body: threadPage };
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      const url = new URL(req.url);
      if (url.pathname === "/ws" || req.headers.get("upgrade") === "websocket") {
        if (srv.upgrade(req)) return;
      }
      if (url.pathname === "/api/channels") return Response.json({ channels: [] });
      if (url.pathname === "/api/search" && req.method === "GET") {
        calls.push(url);
        return next.status === 404 ? new Response("Not Found", { status: 404 }) : Response.json(next.body, { status: next.status });
      }
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type === "auth") {
          socket = ws;
          ws.send(JSON.stringify({ v: 2, type: "authenticated", payload: { agentId: "bellman", agentName: "Bellman", contextId: "ctx-under-test" } }));
        }
      },
      close() { socket = null; },
    },
  });
  return { port: server.port!, connected: () => socket !== null, calls, answer: (a) => void (next = a), stop: () => server.stop(true) };
}

describe("search tool", () => {
  let dir = "";
  let stub: Stub;
  let plugin: ReturnType<typeof Bun.spawn>;
  let out = "";
  let nextId = 1;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "st-"));
    stub = startStub();
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", `pid-${process.pid}.json`), JSON.stringify({ sessionId: "11111111-2222-3333-4444-555555555555", claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }));
    plugin = Bun.spawn(["bun", SERVER], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY, EINWEAVE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555",
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    out = "";
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of plugin.stdout as any) out += dec.decode(chunk, { stream: true });
    })();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stub.connected()) await Bun.sleep(50);
    expect(stub.connected(), "plugin never connected to the stub").toBe(true);
    const initId = nextId++;
    send({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    await waitForId(initId);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }, 30_000);

  afterEach(async () => {
    const [p, s, d] = [plugin, stub, dir];
    p?.kill();
    await p?.exited;
    s?.stop();
    if (d) rmSync(d, { recursive: true, force: true });
  }, 15_000);

  async function waitForId(id: number, waitMs = 8000): Promise<any> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === id) return m;
      }
      await Bun.sleep(25);
    }
    throw new Error(`no response to id ${id} within ${waitMs}ms. stdout:\n${out.slice(-2000)}`);
  }
  function send(frame: unknown) {
    const sink = plugin.stdin as { write: (s: string) => void; flush?: () => void };
    sink.write(JSON.stringify(frame) + "\n");
    sink.flush?.();
  }
  async function callTool(name: string, args: Record<string, unknown>) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const m = await waitForId(id);
    return { isError: !!m.result?.isError, text: (m.result?.content?.[0]?.text ?? "") as string };
  }

  test("is listed, with the query language in its description", async () => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    const tool = (await waitForId(id)).result.tools.find((t: any) => t.name === "search");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["query"]);
    for (const k of ["in:#channel", "from:@person", "is:answered", "no:assignee", "has:link", "before:"]) expect(tool.description).toContain(k);
  });

  test("threads: the query reaches the server encoded; hits come back **bold**, no mark survives; names cleaned; 1000+", async () => {
    const r = await callTool("search", { query: 'deploy window "a b" in:#ops', sort: "relevance", cursor: "c/=", limit: 7 });
    expect(r.isError).toBe(false);
    const call = stub.calls.at(-1)!;
    expect(call.searchParams.get("q")).toBe('deploy window "a b" in:#ops');
    expect(call.searchParams.get("type")).toBe("threads");
    expect(call.searchParams.get("sort")).toBe("relevance");
    expect(call.searchParams.get("cursor")).toBe("c/=");
    expect(call.searchParams.get("limit")).toBe("7");
    expect(r.text).not.toContain(S);
    expect(r.text).not.toContain(E);
    expect(r.text).not.toContain("\u001b");
    const body = JSON.parse(r.text);
    expect(body.total).toBe("1000+");
    expect(body.next).toBe("cur/sor=");
    expect(body.query.filters).toEqual(["in:#ops"]);
    expect(body.results[0]).toMatchObject({
      thread_id: "t-1", channel: "ops", matched_in: "message", message_id: "m-9", matching_replies: 3,
      assignee: "@kevin", snippet: "pushing after the **deploy** **window** closes", similar_title: false,
    });
    expect(body.results[0].title).toBe("Deploy window today");
    expect(body.results[1]).toMatchObject({ thread_id: "t-2", similar_title: true, snippet: "Deployment checklist", assignee: null });
    expect(body.hint).toContain("cursor");
  });

  test("messages: type=messages, one row per message with its sender", async () => {
    stub.answer({ status: 200, body: messagePage });
    const r = await callTool("search", { query: "deploy", type: "messages", sort: "newest" });
    expect(stub.calls.at(-1)!.searchParams.get("type")).toBe("messages");
    const body = JSON.parse(r.text);
    expect(body.total).toBe("1");
    expect(body.next).toBeNull();
    expect(body.results).toEqual([
      { message_id: "m-9", thread_id: "t-1", thread_title: "Deploy window today", kind: "question", status: "open", channel_id: "ch-1", channel: "ops", channel_archived: false, sender: "@brian", created_at: "2026-11-03T09:41:00.000Z", snippet: "is the **deploy** still on" },
    ]);
  });

  test("a refusal is an answer with its reason and suggestions, not an error", async () => {
    stub.answer({ status: 422, body: { error: "unresolved_filter", code: "unresolved_filter", token: "in:#opz", suggestions: ["in:#ops", "in:#infra"] } });
    const r = await callTool("search", { query: "deploy in:#opz" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ refused: "unresolved_filter", hint: "Nothing you can read matches in:#opz. Did you mean: in:#ops, in:#infra?", suggestions: ["in:#ops", "in:#infra"] });
    stub.answer({ status: 422, body: { error: "unknown_filter", code: "unknown_filter", token: "chan:ops", keys: ["in", "from"] } });
    expect(JSON.parse((await callTool("search", { query: "chan:ops" })).text).hint).toBe("chan:ops is not a filter. Filters: in: from:");
  });

  test("a server without search says so; bad arguments are refused before any request", async () => {
    stub.answer({ status: 404, body: null });
    const old = await callTool("search", { query: "deploy" });
    expect(old.isError).toBe(true);
    expect(old.text).toContain("too old for search");
    const before = stub.calls.length;
    expect((await callTool("search", { query: "  " })).isError).toBe(true);
    expect((await callTool("search", { query: "x", type: "people" })).isError).toBe(true);
    expect((await callTool("search", { query: "x", sort: "oldest" })).isError).toBe(true);
    expect(stub.calls.length).toBe(before);
  });

  test("limit is bounded to the server's 50", async () => {
    await callTool("search", { query: "deploy", limit: 500 });
    expect(stub.calls.at(-1)!.searchParams.get("limit")).toBe("50");
  });
});
