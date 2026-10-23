/**
 * RFC-028 §11 /clear carries or releases, against the REAL einweave API — the plugin 0.34.0
 * release gate. The plugin's own code (server.ts over stdio, the vendored SDK 0.11.0) and the
 * real SessionStart hook against a real `packages/api` process (bridge #303 or later) on a
 * scratch Postgres database: a /clear carries what was handed to "next", releases the rest, and
 * the hook hands the new conversation the note; a /resume moves nothing.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   EINWEAVE_API_DIR=<bridge checkout with #303>/packages/api bun test test/clear-carry-real-api.test.ts
 *   EINWEAVE_TEST_PG_ADMIN_URL defaults to the server repo's test container (:5433).
 *
 * ⚠️ It SKIPS when EINWEAVE_API_DIR is unset — and then proves nothing. Set and unreachable,
 * it FAILS (never a quiet green). Seeding: test/fixtures/real-api-seed.ts (its own process).
 *
 * "Claude Code's pid" is this test process: a `sessions/pid-<pid>.json` mapping makes it the
 * ancestor the plugin finds, and the hook runs with CLAUDE_PID set to it (as delivery-server.test.ts).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const HOOK_TS = join(import.meta.dir, "..", "hooks", "session-map.ts");
const SEED_TS = join(import.meta.dir, "fixtures", "real-api-seed.ts");
const AUTH_SECRET = "test-secret-at-least-32-characters-long";
const CHANNEL = "clear-carry";

let dbName = "";
let dbUrl = "";
let admin: InstanceType<typeof Bun.SQL> | null = null;
let seed: { cookie: string; userId: string; agentId: string; tenantId: string; keys: string[] } = { cookie: "", userId: "", agentId: "", tenantId: "", keys: [] };
let apiProc: ReturnType<typeof Bun.spawn> | null = null;
let apiLog = "";
let apiUrl = "";

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

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

async function until(pred: () => boolean | Promise<boolean>, ms: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await Bun.sleep(stepMs);
  }
  return !!(await pred());
}

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-028 §11 /clear against the real API", () => {
  let dir = "";
  let client: Client;
  let log = "";
  const notices: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
  };
  const connected = async () => JSON.parse((await call("status", { local: true })).text).websocket === "connected";
  /** The SessionStart hook, as Claude Code runs it; retried until the running server answered. */
  async function sessionStart(id: string, source: string): Promise<{ err: string; context: string | null }> {
    let err = "";
    let out = "";
    const end = Date.now() + 15_000;
    while (Date.now() < end && !/re-keyed|already on/.test(err)) {
      const proc = Bun.spawn(["bun", HOOK_TS, "start"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...(process.env as Record<string, string>), EINWEAVE_STATE_DIR: dir, CLAUDE_PLUGIN_DATA: dir, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: id, CLAUDE_CODE_SSE_PORT: "" },
      });
      proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: id, source }));
      proc.stdin.end();
      [err, out] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
      await proc.exited;
      if (!/re-keyed|already on/.test(err)) await Bun.sleep(200);
    }
    const line = out.split("\n").find((l) => l.startsWith("{"));
    return { err, context: line ? (JSON.parse(line).hookSpecificOutput?.additionalContext ?? null) : null };
  }
  /** thread → the session_key of the grant holding it (null = unheld). */
  async function holders(ids: string[]): Promise<Record<string, string | null>> {
    const db = new Bun.SQL(dbUrl);
    try {
      const out: Record<string, string | null> = {};
      for (const id of ids) {
        const r = await db`SELECT g.session_key FROM thread_holds h JOIN agent_grants g ON g.id = h.session_id WHERE h.thread_id = ${id}`;
        out[id] = r[0]?.session_key ?? null;
      }
      return out;
    } finally {
      await db.close();
    }
  }

  beforeAll(async () => {
    dbName = `bridge_plugin_clear_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    await startApi();
    const ch = await fetch(`${apiUrl}/api/channels`, {
      method: "POST",
      headers: { Cookie: seed.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: CHANNEL, visibility: "public" }),
    });
    if (!ch.ok) throw new Error(`channel: ${ch.status} ${await ch.text()}`);

    dir = mkdtempSync(join(tmpdir(), "clear-real-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", `pid-${process.pid}.json`), JSON.stringify({ sessionId: "clear-c1", source: "startup", claudePid: process.pid, procStart: "", updatedAt: new Date().toISOString() }));
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
        CLAUDE_CODE_SESSION_ID: "clear-c1",
        EINWEAVE_ENROLMENT_KEY: seed.keys[0]!,
        EINWEAVE_TEST: "1",
      } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (b: Buffer) => (log += b.toString()));
    client = new Client({ name: "clear-real-api", version: "0" }, { capabilities: {} });
    client.fallbackNotificationHandler = async (n: any) => {
      if (typeof n?.params?.content === "string") notices.push(n.params.content);
    };
    await client.connect(transport);
    expect(await until(connected, 20_000), `never authenticated:\n${log}`).toBe(true);
    const j = await call("join_channel", { channel_id: CHANNEL });
    expect(j.isError, j.text).toBe(false);
  }, 90_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    apiProc?.kill();
    await apiProc?.exited;
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("/clear carries what was handed to next, releases the rest, and the hook tells the new conversation; /resume moves nothing", async () => {
    // Two threads this conversation starts, so its session holds both.
    const keep = JSON.parse((await call("create_item", { channel_id: CHANNEL, kind: "discussion", title: "Keep working on the deploy" })).text).thread_id as string;
    const drop = JSON.parse((await call("create_item", { channel_id: CHANNEL, kind: "discussion", title: "Old log question" })).text).thread_id as string;
    expect(await holders([keep, drop])).toEqual({ [keep]: "clear-c1", [drop]: "clear-c1" });

    const h = await call("handover", { ref: keep, to: "next" });
    expect(h.isError, h.text).toBe(false);
    expect(h.text).toContain("to the next conversation in this window");
    expect(await holders([keep, drop])).toEqual({ [keep]: "clear-c1", [drop]: "clear-c1" }); // nothing moves before the /clear

    const t0 = Date.now();
    const clear = await sessionStart("clear-c2", "clear");
    expect(clear.err).toContain("server re-keyed to clear-c2");
    expect(await holders([keep, drop])).toEqual({ [keep]: "clear-c2", [drop]: null });
    const note = clear.context;
    expect(note, `no note from the hook (${Date.now() - t0} ms):\n${clear.err}\n${log.slice(-2000)}`).not.toBeNull();
    expect(note).toContain("This session holds");
    expect(note).toContain(`"Keep working on the deploy" (${keep})`);
    expect(note).toContain(`#${CHANNEL} "Old log question" (${drop})`);
    expect(await until(connected, 10_000)).toBe(true);

    // /resume of the old conversation: no replaces — the old session comes back holdless, nothing moves.
    const resume = await sessionStart("clear-c1", "resume");
    expect(resume.err).toContain("server re-keyed to clear-c1");
    expect(resume.context).toBeNull();
    expect(await until(connected, 10_000)).toBe(true);
    expect(await holders([keep, drop])).toEqual({ [keep]: "clear-c2", [drop]: null });
  }, 60_000);
});
