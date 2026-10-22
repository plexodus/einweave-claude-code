/**
 * RFC-029 work items against the REAL einweave API — the plugin 0.32.0 release gate (A1).
 *
 * The plugin's own code (server.ts over stdio, the vendored SDK 0.8.0) against a real
 * `packages/api` process on a scratch Postgres database: the §7 tools answer what the server
 * says, and a `thread_event` reaches the model live and on resume, once.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   EINWEAVE_API_DIR=<bridge checkout with RFC-029>/packages/api bun test test/work-items-real-api.test.ts
 *   EINWEAVE_TEST_PG_ADMIN_URL defaults to the server repo's test container (:5433).
 *
 * ⚠️ It SKIPS when EINWEAVE_API_DIR is unset — and then proves nothing. Set and unreachable,
 * it FAILS (never a quiet green). Seeding: test/fixtures/real-api-seed.ts (its own process).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const API_DIR = process.env.EINWEAVE_API_DIR ?? "";
const HAVE_SERVER = !!API_DIR && (await Bun.file(join(API_DIR, "src/index.ts")).exists().catch(() => false));
const ADMIN_URL = process.env.EINWEAVE_TEST_PG_ADMIN_URL ?? "postgres://bridge:bridge-test-not-a-secret@127.0.0.1:5433/bridge";
async function pgReachable(): Promise<boolean> {
  try {
    const probe = new Bun.SQL(ADMIN_URL);
    await probe`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}
const HAVE_PG = HAVE_SERVER ? await pgReachable() : false;
if (process.env.EINWEAVE_API_DIR && !HAVE_SERVER) throw new Error(`EINWEAVE_API_DIR=${process.env.EINWEAVE_API_DIR} has no src/index.ts. Refusing to skip.`);
if (process.env.EINWEAVE_API_DIR && !HAVE_PG) throw new Error(`EINWEAVE_API_DIR is set but Postgres is not reachable at ${ADMIN_URL.replace(/:[^:@/]*@/, ":***@")}. Refusing to skip.`);

const SERVER_TS = join(import.meta.dir, "..", "server.ts");
const SEED_TS = join(import.meta.dir, "fixtures", "real-api-seed.ts");
const AUTH_SECRET = "test-secret-at-least-32-characters-long";

let dbName = "";
let dbUrl = "";
let admin: InstanceType<typeof Bun.SQL> | null = null;
let seed: { cookie: string; userId: string; agentId: string; tenantId: string; keys: string[] } = { cookie: "", userId: "", agentId: "", tenantId: "", keys: [] };

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

let apiProc: ReturnType<typeof Bun.spawn> | null = null;
let apiLog = "";
let apiUrl = "";

async function startApi(): Promise<void> {
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  apiProc = Bun.spawn(["bun", join(API_DIR, "src/index.ts")], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      PORT: String(port),
      EINWEAVE_PUBLIC_URL: apiUrl,
      FORGE_OIDC_CLIENT_SECRET: "x",
      BETTER_AUTH_SECRET: AUTH_SECRET,
      NODE_ENV: "test",
      ANON_BURST: "1000",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:1",
      EINWEAVE_SHUTDOWN_GRACE_MS: "150",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const s of [apiProc.stdout, apiProc.stderr]) {
    void (async () => {
      const dec = new TextDecoder();
      for await (const c of s as any) apiLog += dec.decode(c);
    })();
  }
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${apiUrl}/api/health`)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`bridge API did not start:\n${apiLog.slice(-3000)}`);
}

interface Plugin {
  notices: string[];
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
  tools: () => Promise<string[]>;
  listed: () => Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  connected: () => Promise<boolean>;
  close: () => Promise<void>;
}

async function plugin(dir: string, env: Record<string, string>): Promise<Plugin> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER_TS],
    env: {
      ...process.env,
      EINWEAVE_API_URL: apiUrl,
      EINWEAVE_AUTOCONNECT: "1",
      EINWEAVE_BROWSER: "none",
      EINWEAVE_STATE_DIR: dir,
      CLAUDE_PLUGIN_DATA: dir,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_CODE_SSE_PORT: "",
      EINWEAVE_TEST: "1",
      ...env,
    } as Record<string, string>,
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (b: Buffer) => {
    log += b.toString();
  });
  const client = new Client({ name: "work-real-api", version: "0" }, { capabilities: {} });
  const notices: string[] = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") notices.push(n.params.content);
  };
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
  };
  return {
    notices,
    stderr: () => log,
    call,
    tools: async () => ((await client.listTools()).tools ?? []).map((t: any) => t.name),
    listed: async () => ((await client.listTools()).tools ?? []) as any,
    connected: async () => JSON.parse((await call("status", { local: true })).text).websocket === "connected",
    close: () => client.close().catch(() => {}),
  };
}

async function until(pred: () => boolean | Promise<boolean>, ms: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(stepMs);
  }
  return !!(await pred());
}

/** The workspace owner (a person, cookie session) — the requester and the channel's owner. */
async function human(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Cookie: seed.cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** A person's task in the work channel; `assignee` the agent's id, or none. */
async function humanTask(title: string, assignee?: string): Promise<string> {
  const r = await human("POST", "/api/messages", {
    channelId,
    content: title,
    title,
    kind: "task",
    fields: { goal: `${title} — done when it works` },
    ...(assignee ? { assignee } : {}),
  });
  return r.threadId as string;
}

let channelId = "";
const CHANNEL = "work-items";

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-029 work items against the real API", () => {
  let dir = "";
  let p: Plugin;

  beforeAll(async () => {
    dbName = `bridge_plugin_work_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    await startApi();
    channelId = (await human("POST", "/api/channels", { name: CHANNEL, visibility: "public" })).id;
    dir = mkdtempSync(join(tmpdir(), "work-real-"));
    p = await plugin(dir, { EINWEAVE_ENROLMENT_KEY: seed.keys[0]!, EINWEAVE_SESSION_KEY: "work-s1" });
    expect(await until(p.connected, 20_000), `never authenticated:\n${p.stderr()}`).toBe(true);
    const j = await p.call("join_channel", { channel_id: CHANNEL });
    expect(j.isError, j.text).toBe(false);
  }, 90_000);

  afterAll(async () => {
    await p?.close();
    apiProc?.kill();
    await apiProc?.exited;
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("the tool list is RFC §7's: the task tools are gone, the work tools are there", async () => {
    const tools = await p.tools();
    for (const gone of ["set_thread_kind", "claim_task", "update_task_status", "cancel_task", "list_my_tasks"]) expect(tools).not.toContain(gone);
    for (const t of ["create_item", "update_item", "resolve_item", "reopen_item", "triage_item", "add_activity", "add_link", "remove_link", "list_items", "item_schema"]) expect(tools).toContain(t);
  });

  test("the tools this release reworded say einweave, never Bridge", async () => {
    const listed = await p.listed();
    const touched = ["reply", "leave_channel", "read_deliveries", "who_can_see", "create_item", "update_item", "resolve_item", "reopen_item", "triage_item", "add_activity", "add_link", "remove_link", "list_items", "item_schema"];
    for (const name of touched) {
      const t = listed.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(JSON.stringify(t), name).not.toContain("Bridge");
    }
  });

  test("create_item without body: a work kind's root is empty (RFC §2), a discussion's is its title", async () => {
    const task = JSON.parse((await p.call("create_item", { channel_id: CHANNEL, kind: "task", title: "Empty-root task", fields: { goal: "nothing in the root" } })).text);
    const tRead = JSON.parse((await p.call("read_thread", { thread_id: task.thread_id, mark_read: false })).text);
    expect(tRead.root.content, JSON.stringify(tRead.root)).toBe("");
    const disc = JSON.parse((await p.call("create_item", { channel_id: CHANNEL, kind: "discussion", title: "Where should logs live" })).text);
    const dRead = JSON.parse((await p.call("read_thread", { thread_id: disc.thread_id, mark_read: false })).text);
    expect(dRead.root.content).toBe("Where should logs live");
  });

  test("create_item naming an assignee answers with its NAME from the server (S14), never its id", async () => {
    const r = await p.call("create_item", { channel_id: CHANNEL, kind: "task", title: "Self-assigned chore", fields: { goal: "it is done" }, assignee: "me" });
    expect(r.isError, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.assignee, r.text).toBe("you");
    expect(r.text).not.toContain(seed.agentId);
  });

  test("resolve_item with half a resolved_in is refused before the server is asked", async () => {
    const tid = await humanTask("Bump the base image");
    const r = await p.call("resolve_item", { thread_id: tid, reason: "done", conclusion: "bumped", resolved_in: { component: "api" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("resolved_in needs both component and version");
    expect(r.text).not.toContain("einweave refused");
  });

  test("item_schema answers the vocabulary (bug's required fields among it)", async () => {
    const r = await p.call("item_schema", { channel: CHANNEL });
    expect(r.isError, r.text).toBe(false);
    const s = JSON.parse(r.text);
    const bug = s.kinds.find((k: any) => k.kind === "bug");
    expect(bug.required).toEqual(["what_happened", "expected", "steps"]);
    expect(s.channel).toMatchObject({ name: CHANNEL });
  });

  test("missing fields: 422 missing_fields names each one, and nothing is filed", async () => {
    const r = await p.call("create_item", { channel_id: CHANNEL, kind: "bug", title: "Export button does nothing", fields: { what_happened: "click, nothing" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("422 missing_fields");
    expect(r.text).toContain("missing required fields: expected, steps");
    const list = JSON.parse((await p.call("list_items", { query: "Export button", status: "triage,todo" })).text);
    expect(list.items).toEqual([]);
  });

  test("an agent's bug lands in triage; a near-identical one is refused (similar_exists) until confirm_new, and `similar` names the first", async () => {
    const fields = { what_happened: "Saving a draft throws 500", expected: "the draft is saved", steps: "open composer, type, save" };
    const first = await p.call("create_item", { channel_id: CHANNEL, kind: "bug", title: "Saving a draft throws a 500 error", fields });
    expect(first.isError, first.text).toBe(false);
    const a = JSON.parse(first.text);
    expect(a).toMatchObject({ kind: "bug", status: "triage", assignee: null });
    expect(a.hint).toContain("In triage");

    const dup = await p.call("create_item", { channel_id: CHANNEL, kind: "bug", title: "Saving a draft throws a 500 error", fields });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("409 similar_exists");
    expect(dup.text).toContain(a.thread_id);
    expect(dup.text).toContain("confirm_new: true");

    const forced = await p.call("create_item", { channel_id: CHANNEL, kind: "bug", title: "Saving a draft throws a 500 error", fields, confirm_new: true });
    expect(forced.isError, forced.text).toBe(false);
    const b = JSON.parse(forced.text);
    expect(b.thread_id).not.toBe(a.thread_id);
    expect(b.similar.map((s: any) => s.thread_id)).toContain(a.thread_id);
    expect(b.hint).toContain("similar thread(s): read them");
  });

  test("resolve_item as the assignee: 403 not_allowed with the remedy (post a result); read_thread prints the header; who_can_see(thread_id)", async () => {
    const tid = await humanTask("Rotate the staging certificates", seed.agentId);
    const r = await p.call("resolve_item", { thread_id: tid, reason: "done", conclusion: "rotated" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("403 not_allowed");
    expect(r.text).toContain("remedy: an agent never resolves: post your result (add_activity type: result");

    const read = JSON.parse((await p.call("read_thread", { thread_id: tid, mark_read: false })).text);
    expect(read.thread.kind).toBe("task");
    expect(read.thread.work.text).toContain("task · todo");
    expect(read.thread.work.may.resolve).toBe(false);

    const w = await p.call("who_can_see", { thread_id: tid });
    expect(w.isError, w.text).toBe(false);
    expect(JSON.parse(w.text)).toMatchObject({ visibility: "public", readers: "everyone in the workspace" });

    // The right way to finish: plan → result; the item moves on, nobody resolved it for the agent.
    const plan = JSON.parse((await p.call("add_activity", { thread_id: tid, type: "plan", items: ["rotate", "verify"] })).text);
    expect(plan.status).toBe("in_progress");
    const result = await p.call("add_activity", { thread_id: tid, type: "result", text: "rotated and verified", conclusion: "certificates rotated", proposed: { reason: "done" } });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text).status).not.toBe("in_progress");
  });

  test("0.33.0 reads mark on the server: read_thread, read_messages, and list_items unread clears", async () => {
    const db = new Bun.SQL(dbUrl);
    try {
      const threadCursor = async (tid: string) =>
        (await db`SELECT last_read_seq FROM thread_cursors WHERE principal_id = ${seed.agentId} AND thread_id = ${tid}`)[0]?.last_read_seq;
      const channelCursor = async () =>
        (await db`SELECT last_read_seq FROM read_cursors WHERE principal_id = ${seed.agentId} AND channel_id = ${channelId}`)[0]?.last_read_seq;

      // An item of the agent's with a person's reply: unread until read_thread reads it.
      const tid = await humanTask("Review the read rule", seed.agentId);
      await human("POST", `/api/threads/${tid}/messages`, { content: "any news?" });
      const row = async () => JSON.parse((await p.call("list_items", { assignee: "me" })).text).items.find((i: any) => i.thread_id === tid);
      expect((await row())?.unread ?? 0).toBeGreaterThanOrEqual(1);

      const peek = JSON.parse((await p.call("read_thread", { thread_id: tid, mark_read: false })).text);
      expect(peek.marked_read_up_to).toBeUndefined();
      expect(await threadCursor(tid)).toBeUndefined();

      const read = JSON.parse((await p.call("read_thread", { thread_id: tid })).text);
      expect(typeof read.marked_read_up_to).toBe("number");
      expect(Number(await threadCursor(tid))).toBe(read.marked_read_up_to);
      expect((await row())?.unread).toBeUndefined();

      // The channel's roots, from the start (a gap-free run from read position 0).
      const chan = JSON.parse((await p.call("read_messages", { channel_id: channelId, since_seq: 0 })).text);
      expect(chan.count).toBeGreaterThan(0);
      expect(typeof chan.marked_read_up_to).toBe("number");
      expect(Number(await channelCursor())).toBe(chan.marked_read_up_to);
    } finally {
      await db.close();
    }
  });

  test("claim = update_item assignee: \"me\" on a person's unassigned task", async () => {
    const tid = await humanTask("Prune old preview deployments");
    const r = await p.call("update_item", { thread_id: tid, assignee: "me" });
    expect(r.isError, r.text).toBe(false);
    const claimed = JSON.parse(r.text);
    expect(claimed.assignee).toBe("you"); // S15: principalLabel with this agent as self
    expect(claimed.created_by, r.text).toBe("Owner"); // the person who filed it, named (no handle → name)
    expect(r.text).not.toContain(seed.agentId);
    expect(r.text).not.toContain(seed.userId);
    const mine = JSON.parse((await p.call("list_items", { assignee: "me" })).text);
    expect(mine.items.map((i: any) => i.thread_id)).toContain(tid);
  });

  test("reply gains assignee (assign as you reply, one step) and loses type task", async () => {
    const tid = await humanTask("Check the nightly backup restore");
    const r = await p.call("reply", { channel_id: CHANNEL, thread_id: tid, text: "I'll take this one", assignee: "me" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("assigned to you");
    expect(r.text).not.toContain(seed.agentId);
    const read = JSON.parse((await p.call("read_thread", { thread_id: tid, mark_read: false })).text);
    expect(read.thread.work.text).toContain("assignee: @me");

    const task = await p.call("reply", { channel_id: CHANNEL, text: "do a thing", type: "task" });
    expect(task.isError).toBe(true);
    expect(task.text).toContain("create_item");
    const root = await p.call("reply", { channel_id: CHANNEL, text: "x", assignee: "me" });
    expect(root.isError).toBe(true);
    expect(root.text).toContain("pass thread_id");
  });

  test("a thread_event reaches the model live, and on resume, ONCE each", async () => {
    const eventLine = (tid: string) => `Work item ${tid}: assigned`;
    const count = (pl: Plugin, tid: string) => pl.notices.filter((n) => n.includes(eventLine(tid))).length;

    // Live: a person assigns an item to the agent while it is connected.
    const t1 = await humanTask("Renew the TLS wildcard");
    await human("PUT", `/api/threads/${t1}/work`, { assignee: seed.agentId });
    expect(await until(() => count(p, t1) > 0, 15_000), `no live thread_event:\n${p.notices.join("\n---\n")}`).toBe(true);
    await Bun.sleep(2000);
    expect(count(p, t1)).toBe(1);
    const live = p.notices.find((n) => n.includes(eventLine(t1)))!;
    expect(live).toContain("task · todo"); // the item NOW (work.text)
    // S13: said from this agent's side, the person NAMED by the payload's names — no raw ids.
    const line = live.split("\n")[0]!;
    expect(line).toContain(`Work item ${t1}: assigned to you — by human `);
    expect(line).not.toContain(seed.userId);
    expect(line).not.toContain(seed.agentId);
    // The model has it: read_deliveries returns it and acks it (`model`).
    const owed = JSON.parse((await p.call("read_deliveries")).text);
    expect(owed.entries.filter((e: any) => e.kind === "thread_event" && e.thread_id === t1)).toHaveLength(1);

    // Offline: the plugin process ends; another item is assigned meanwhile.
    await p.close();
    const t2 = await humanTask("Rotate the API signing key");
    await human("PUT", `/api/threads/${t2}/work`, { assignee: seed.agentId });

    // Resume: the same profile and session key — the event drains on the new connection.
    p = await plugin(dir, { EINWEAVE_SESSION_KEY: "work-s1" });
    expect(await until(p.connected, 20_000), p.stderr()).toBe(true);
    expect(await until(() => count(p, t2) > 0, 15_000), `no thread_event on resume:\n${p.notices.join("\n---\n")}`).toBe(true);
    await Bun.sleep(3000);
    expect(count(p, t2)).toBe(1);
    // The one the model already had is not handed over again.
    expect(count(p, t1)).toBe(0);

    // Taken AWAY (the person unassigns it — a takeover is unassign, then assign): the agent is
    // told, as previous_assignee, to stop.
    await human("PUT", `/api/threads/${t2}/work`, { assignee: null });
    const away = `Work item ${t2}: unassigned from you`;
    expect(await until(() => p.notices.some((n) => n.includes(away)), 15_000), `no reassignment notice:\n${p.notices.join("\n---\n")}`).toBe(true);
    expect(p.notices.find((n) => n.includes(away))).toContain("STOP working on it");
  }, 90_000);
});
