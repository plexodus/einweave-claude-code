/**
 * RFC-028 D6: the session label is stored on the grant (server #327), against the REAL einweave API.
 * Two windows on one session key (`claude --resume <id>` without `--fork-session`): A launches
 * with a label, B takes the session over and renames it, A takes it back -- B's name stands, on
 * the server and in both windows. Before PR B, A's auth frame carried A's own label and undid it.
 *
 * ── HOW TO RUN IT ─────────────────────────────────────────────────────────────────────
 *   EINWEAVE_API_DIR=<bridge checkout with #327>/packages/api bun test test/session-label-real-api.test.ts
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
const KEY = "label-two-windows";

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

describe.skipIf(!HAVE_SERVER || !HAVE_PG)("RFC-028 D6: the session label against the real API", () => {
  let dir = "";
  const windows: Array<{ client: Client; log: { text: string } }> = [];

  async function openWindow(env: Record<string, string> = {}): Promise<{ client: Client; log: { text: string } }> {
    const log = { text: "" };
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
        EINWEAVE_SESSION_KEY: KEY,
        EINWEAVE_ENROLMENT_KEY: seed.keys[0]!,
        EINWEAVE_TEST: "1",
        ...env,
      } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (b: Buffer) => (log.text += b.toString()));
    const client = new Client({ name: "label-real-api", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    const w = { client, log };
    windows.push(w);
    return w;
  }
  const call = async (w: { client: Client }, name: string, args: Record<string, unknown> = {}) => {
    const r: any = await w.client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
  };
  const status = async (w: { client: Client }) => JSON.parse((await call(w, "status", { local: true })).text);
  const connected = (w: { client: Client }) => async () => (await status(w)).websocket === "connected";
  async function stored(): Promise<{ session_label: string | null; label: string | null }> {
    const db = new Bun.SQL(dbUrl);
    try {
      const r = await db`SELECT g.session_label, c.label FROM agent_grants g LEFT JOIN agent_contexts c ON c.id = g.id::text WHERE g.session_key = ${KEY}`;
      return r[0] ?? { session_label: null, label: null };
    } finally {
      await db.close();
    }
  }

  beforeAll(async () => {
    dbName = `bridge_plugin_label_${Date.now()}_${process.pid}`;
    admin = new Bun.SQL(ADMIN_URL);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const r = Bun.spawnSync(["bun", SEED_TS, API_DIR, AUTH_SECRET], { env: { ...process.env, DATABASE_URL: dbUrl } });
    if (r.exitCode !== 0) throw new Error(`seed failed:\n${r.stderr.toString().slice(-3000)}`);
    seed = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    await startApi();
    dir = mkdtempSync(join(tmpdir(), "label-real-"));
  }, 90_000);

  afterAll(async () => {
    for (const w of windows) await w.client.close().catch(() => {});
    apiProc?.kill();
    await apiProc?.exited;
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  test("B renames, A takes the session back: B's name stands on the server and in both windows", async () => {
    const a = await openWindow({ EINWEAVE_SESSION_LABEL: "a-name" });
    expect(await until(connected(a), 20_000), `A never authenticated:\n${a.log.text}`).toBe(true);
    expect((await stored()).session_label).toBe("a-name");

    const b = await openWindow();
    const tb = await call(b, "connect", { takeover: "lock" });
    expect(tb.isError, tb.text).toBe(false);
    expect(await until(connected(b), 20_000), `B never took over:\n${b.log.text}`).toBe(true);
    expect((await status(b)).label, "B adopts the stored label, not none").toBe("a-name");
    const rn = await call(b, "set_session_label", { label: "b-name" });
    expect(rn.isError, rn.text).toBe(false);
    expect((await stored()).session_label).toBe("b-name");

    const ta = await call(a, "connect", { takeover: "lock" });
    expect(ta.isError, ta.text).toBe(false);
    expect(await until(connected(a), 20_000), `A never took back:\n${a.log.text}`).toBe(true);
    await Bun.sleep(300);
    const s = await stored();
    expect(s.session_label, "A's sign-in must not undo B's rename").toBe("b-name");
    expect(s.label).toContain("b-name");
    expect((await status(a)).label).toBe("b-name");
    expect((await status(b)).label).toBe("b-name");
  }, 90_000);
});
