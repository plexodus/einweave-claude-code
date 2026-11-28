/**
 * RFC-038 D3 against the REAL einweave API: the mod's turn posts (`POST /turn`, the mod server) and a model's tool
 * call (`_meta["claudecode/toolUseId"]`) become the session's `session_turn_threads` rows, and an idle turn
 * clears them. Plugin 0.51.0's release gate.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   EINWEAVE_API_DIR=<bridge checkout, RFC-038 step 1 (76edda08) or later>/packages/api bun test test/turn-threads-real-api.test.ts
 *   EINWEAVE_TEST_PG_ADMIN_URL defaults to the server repo's test container (:5433).
 *
 * ⚠️ It SKIPS when EINWEAVE_API_DIR is unset — and then proves nothing. Set and unreachable,
 * it FAILS (never a quiet green). Seeding: test/fixtures/real-api-seed.ts (its own process).
 *
 * "Claude Code's pid" is this test process (a `sessions/pid-<pid>.json` mapping, as clear-carry-real-api): the
 * plugin opens its mod server for it, where the test posts as the mod would.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { modSocketPath } from "../delivery/ctl-path";
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
      // The API refuses to boot without its rate-key secret (go-live P0 1c-ii).
      EINWEAVE_RATE_KEY_SECRET: "test-rate-key-secret-at-least-32-chars",
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

let lastClient: Client;
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
  const client = new Client({ name: "turn-threads-real-api", version: "0" }, { capabilities: {} });
  const notices: Array<{ content: string; meta: Record<string, string> }> = [];
  client.fallbackNotificationHandler = async (n: any) => {
    if (typeof n?.params?.content === "string") notices.push({ content: n.params.content, meta: n.params.meta ?? {} });
  };
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
  };
  lastClient = client;
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
const CHANNEL = "turns";

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-038 D3: turn threads against the real API", () => {
  let dir = "";
  let p: Plugin;
  let client: Client;
  let seq = 0;

  beforeAll(async () => {
    dbName = `bridge_plugin_turns_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    await startApi();
    channelId = (await human("POST", "/api/channels", { name: CHANNEL, visibility: "public" })).id;
    dir = mkdtempSync(join(tmpdir(), "turns-real-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", `pid-${process.pid}.json`), JSON.stringify({ sessionId: "turns-c1", source: "startup", claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }));
    p = await plugin(dir, { EINWEAVE_ENROLMENT_KEY: seed.keys[0]!, EINWEAVE_SESSION_KEY: "turns-s1", CLAUDE_PID: String(process.pid) });
    expect(await until(p.connected, 20_000), `never authenticated:\n${p.stderr()}`).toBe(true);
    client = lastClient;
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

  /** One post as the mod sends it. */
  async function turnPost(body: Record<string, unknown>): Promise<Response> {
    return await fetch("http://einweave/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ epoch: "e1", seq: ++seq, ...body }), unix: modSocketPath(dir, process.pid) } as RequestInit);
  }
  const snapshot = (state: string, loops: unknown[]) => turnPost({ kind: "snapshot", state, loops, waiting: [], agents: [] });
  async function rows(): Promise<string[]> {
    const db = new Bun.SQL(dbUrl);
    try {
      return (await db`SELECT thread_id FROM session_turn_threads ORDER BY thread_id`).map((r: any) => String(r.thread_id));
    } finally {
      await db.close();
    }
  }

  test("an entry this process pushed, read in the turn, lights its thread; a reply joined by its tool-use id lights another; idle clears both", async () => {
    // T: a thread the agent took part in, where a person's reply is pushed to this window.
    const t = await human("POST", "/api/messages", { channelId, content: "Status of the deploy?", title: "Status of the deploy?" });
    const s = await p.call("reply", { channel_id: CHANNEL, thread_id: t.threadId, text: "Looking." });
    expect(s.isError, s.text).toBe(false);
    const before = p.notices.length;
    const h = await human("POST", `/api/threads/${t.threadId}/messages`, { content: "Any news?" });
    expect(await until(() => p.notices.slice(before).some((n) => n.meta.message_id === h.id), 15_000), `no inbound:\n${p.stderr().slice(-2000)}`).toBe(true);

    // A typed or quoted tag naming an id this process never pushed lights nothing.
    expect((await snapshot("working", [{ agent: "main", turn: "T1", inTurn: [{ id: "00000000-0000-7000-8000-00000000beef" }], pending: [] }])).status).toBe(200);
    // Pending (entered, not yet read by a step) lights nothing either.
    expect((await snapshot("working", [{ agent: "main", turn: "T1", inTurn: [], pending: [{ id: h.id }] }])).status).toBe(200);
    await Bun.sleep(400);
    expect(await rows()).toEqual([]);

    expect((await snapshot("working", [{ agent: "main", turn: "T1", inTurn: [{ id: h.id }], pending: [] }])).status).toBe(200);
    expect(await until(async () => (await rows()).length === 1, 10_000), `no row:\n${p.stderr().slice(-2000)}`).toBe(true);
    expect(await rows()).toEqual([t.threadId]);

    // U: a new thread the model starts with `reply` in this turn; Claude Code names the call, the mod its turn.
    expect((await turnPost({ kind: "tool", toolUseId: "toolu_real_1", agent: "main", turn: "T1" })).status).toBe(200);
    const r: any = await client.callTool({ name: "reply", arguments: { channel_id: CHANNEL, text: "A new topic", title: "A new topic" }, _meta: { "claudecode/toolUseId": "toolu_real_1" } } as any);
    expect(r.isError === true, String(r.content?.[0]?.text)).toBe(false);
    expect(await until(async () => (await rows()).length === 2, 10_000), `the reply's thread never lit:\n${p.stderr().slice(-2000)}`).toBe(true);
    expect((await rows()).includes(t.threadId)).toBe(true);

    expect((await snapshot("idle", [])).status).toBe(200);
    expect(await until(async () => (await rows()).length === 0, 10_000)).toBe(true);
  }, 60_000);

  test("a malformed post is a 400 and changes nothing", async () => {
    const res = await turnPost({ kind: "snapshot", state: "busy", loops: [], waiting: [], agents: [] });
    expect(res.status).toBe(400);
  });
});
