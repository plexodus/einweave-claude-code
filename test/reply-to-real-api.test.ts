/**
 * RFC-035 D8 against the REAL einweave API: the reply tool's reply_to / new_thread / silent, the inbound
 * reply line, and read rows' url / reply_to / replied_elsewhere. Plugin 0.46.0's release gate.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   EINWEAVE_API_DIR=<bridge checkout with #360>/packages/api bun test test/reply-to-real-api.test.ts
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
  notices: Array<{ content: string; meta: Record<string, string> }>;
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
  const client = new Client({ name: "reply-to-real-api", version: "0" }, { capabilities: {} });
  const notices: Array<{ content: string; meta: Record<string, string> }> = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") notices.push({ content: n.params.content, meta: n.params.meta ?? {} });
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

let channelId = "";
const CHANNEL = "replies";

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-035 D8: reply-to against the real API", () => {
  let dir = "";
  let p: Plugin;

  beforeAll(async () => {
    dbName = `bridge_plugin_replyto_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    await startApi();
    channelId = (await human("POST", "/api/channels", { name: CHANNEL, visibility: "public" })).id;
    dir = mkdtempSync(join(tmpdir(), "replyto-real-"));
    p = await plugin(dir, { EINWEAVE_ENROLMENT_KEY: seed.keys[0]!, EINWEAVE_SESSION_KEY: "replyto-s1" });
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

  /** A person's new thread in the channel: its root message. */
  async function humanRoot(content: string): Promise<{ id: string; threadId: string }> {
    const r = await human("POST", "/api/messages", { channelId, content, title: content });
    return { id: r.id, threadId: r.threadId };
  }
  const sentId = (text: string): string => /sent \(id: ([0-9a-f-]{36})/.exec(text)?.[1] ?? "";
  async function stored(id: string): Promise<{ reply_to_id: string | null; thread_id: string; channel_id: string }> {
    const db = new Bun.SQL(dbUrl);
    try {
      return (await db`SELECT reply_to_id, thread_id, channel_id FROM messages WHERE id = ${id}`)[0];
    } finally {
      await db.close();
    }
  }

  test("reply_to alone answers in the TARGET's thread, even with a link; the server stores the reference", async () => {
    const q = await humanRoot("Which port does the API use?");
    // A message LINK, as a person would paste it (the server's own template).
    const ws = await human("GET", "/api/me/workspace");
    const link = String(ws.links.message).replace("{channelId}", channelId).replace("{threadId}", q.threadId).replace("{id}", q.id);
    const s = await p.call("reply", { channel_id: CHANNEL, text: "4000.", reply_to: link });
    expect(s.isError, s.text).toBe(false);
    expect(s.text).toContain(`in the thread of the message it answers: ${q.threadId}`);
    // The channel it landed in is the target's (by id), not whatever channel_id named.
    expect(s.text).toContain(`channel: ${channelId}`);
    const row = await stored(sentId(s.text));
    expect(row).toMatchObject({ reply_to_id: q.id, thread_id: q.threadId });
  });

  test("reply_to + thread_id answers from ANOTHER thread; the target's row counts it as replied elsewhere", async () => {
    const q = await humanRoot("Who owns the release?");
    const here = await humanRoot("Release notes draft");
    const s = await p.call("reply", { channel_id: CHANNEL, text: "I do.", reply_to: q.id, thread_id: here.threadId });
    expect(s.isError, s.text).toBe(false);
    expect(await stored(sentId(s.text))).toMatchObject({ reply_to_id: q.id, thread_id: here.threadId });

    const target = JSON.parse((await p.call("read_thread", { thread_id: q.threadId, mark_read: false })).text);
    expect(target.root.replied_elsewhere, JSON.stringify(target.root)).toBe(1);
    expect(String(target.root.url)).toContain(`/m/${q.id}`);
    const answer = JSON.parse((await p.call("read_thread", { thread_id: here.threadId, mark_read: false })).text);
    const mine = answer.replies.find((r: any) => r.id === sentId(s.text));
    expect(mine.reply_to, JSON.stringify(mine)).toEqual({ id: q.id, sender: expect.any(String), excerpt: "Who owns the release?", thread_id: q.threadId });
  });

  test("new_thread + title starts a thread that answers; a title without new_thread is refused and sends nothing", async () => {
    const q = await humanRoot("Should we split the deploy script?");
    const refused = await p.call("reply", { channel_id: CHANNEL, text: "Yes", reply_to: q.id, title: "Split deploy" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("new_thread");
    const s = await p.call("reply", { channel_id: CHANNEL, text: "Plan for the split", reply_to: q.id, new_thread: true, title: "Split deploy" });
    expect(s.isError, s.text).toBe(false);
    const row = await stored(sentId(s.text));
    expect(row.reply_to_id).toBe(q.id);
    expect(row.thread_id).not.toBe(q.threadId);
    expect(row.channel_id).toBe(channelId);
    const roots = JSON.parse((await p.call("read_messages", { channel_id: CHANNEL, mark_read: false })).text);
    const root = roots.messages.find((m: any) => m.id === sentId(s.text));
    expect(root.reply_to?.id, JSON.stringify(root)).toBe(q.id);
    expect(String(root.url)).toContain(`/m/${root.id}`);
  });

  test("an unknown reply_to is one 404 sentence and sends nothing", async () => {
    const r = await p.call("reply", { channel_id: CHANNEL, text: "x", reply_to: "01992f6e-0000-7000-8000-00000000dead" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no such message");
  });

  test("a person's reply to the agent's message arrives led by what it answers, with reply_to", async () => {
    const t = await humanRoot("Status of the migration?");
    const s = await p.call("reply", { channel_id: CHANNEL, thread_id: t.threadId, text: "Migration 23 is applied everywhere." });
    expect(s.isError, s.text).toBe(false);
    const agentMsg = sentId(s.text);
    const before = p.notices.length;
    const h = await human("POST", `/api/threads/${t.threadId}/messages`, { content: "Great, thanks", replyTo: agentMsg });
    expect(await until(() => p.notices.slice(before).some((n) => n.meta.message_id === h.id), 15_000), `no inbound:\n${p.stderr().slice(-2000)}`).toBe(true);
    const n = p.notices.slice(before).find((x) => x.meta.message_id === h.id)!;
    expect(n.meta.reply_to).toBe(agentMsg);
    expect(n.content.split("\n")[0]).toBe('↪ Me: "Migration 23 is applied everywhere."');
  });

  // `silent`'s effect (no `reply` reason) is the server's, proven in bridge test/message-references.test.ts G3;
  // deliveries are agent rows, so a person's target cannot show it here. This proves the tool accepts it.
  test("silent: accepted with reply_to, the reference still stored", async () => {
    const q = await humanRoot("Silent target");
    const s = await p.call("reply", { channel_id: CHANNEL, text: "fyi", reply_to: q.id, silent: true });
    expect(s.isError, s.text).toBe(false);
    expect((await stored(sentId(s.text))).reply_to_id).toBe(q.id);
  });
});
