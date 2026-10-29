/**
 * P2: per-session label wiring + the `set_session_label` tool. RFC-028 D6: the server stores
 * the label (authenticated.label); a window sends one only as a change (session-settings.ts).
 *
 * server.ts has zero exports and runs `connectUnlessDuplicate()` at the top
 * level, so — like session-label.test.ts and
 * session-lock.test.ts — this drives it as a spawned child process rather
 * than importing it.
 *
 * SESSION_KEY here MUST match what resolveSessionKey() actually resolves. Per server.ts's
 * resolveSessionKey(): with no EINWEAVE_SESSION_KEY override and no session-map
 * hook running (EINWEAVE_STATE_DIR/CLAUDE_PLUGIN_DATA point at a throwaway temp
 * dir with no `sessions/` subdirectory, so the ancestry walk always misses),
 * it falls through to CLAUDE_CODE_SESSION_ID (CLAUDE_CODE_SSE_PORT left "" so
 * the SSE-port path is skipped too) — same fixed id session-label.test.ts
 * already uses for the same reason.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgentAuthRoutes } from "./agent-auth-routes";
import { mintAgentToken } from "./agent-auth-stub";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const SESSION_KEY = "11111111-2222-3333-4444-555555555555";
// A well-formed key (server format + CRC) — the strict core refuses anything else.
const ENROLMENT_KEY = mintAgentToken("ek");

// ── stub Bridge server (WS auth only) ───────────────────────────────────────

function startStub() {
  let authFrame: any = null;
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
          authFrame = frame;
          ws.send(
            JSON.stringify({
              v: 2,
              type: "authenticated",
              payload: { agentId: "jorgen-mac", agentName: "Jörgen (Mac)", contextId: "ctx" },
            })
          );
        }
      },
    },
  });
  return { port: server.port!, authFrame: () => authFrame, stop: () => server.stop(true) };
}

async function authFrameWithStore(opts: { envLabel?: string }): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "srt-"));
  const stub = startStub();
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    EINWEAVE_STATE_DIR: dir,
    EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
    EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY, EINWEAVE_AUTOCONNECT: "1",
    CLAUDE_CODE_SESSION_ID: SESSION_KEY,
    CLAUDE_CODE_SSE_PORT: "",
  };
  if (opts.envLabel !== undefined) env.EINWEAVE_SESSION_LABEL = opts.envLabel;
  const plugin = Bun.spawn(["bun", SERVER], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !stub.authFrame()) await Bun.sleep(50);
    return stub.authFrame();
  } finally {
    plugin.kill();
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session label at launch", () => {
  test("EINWEAVE_SESSION_LABEL rides the first auth frame", async () => {
    const frame = await authFrameWithStore({ envLabel: "FromEnv" });
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBe("FromEnv");
  }, 30_000);

  test("no env label means no sessionLabel (a label from an earlier launch is the server's to keep)", async () => {
    const frame = await authFrameWithStore({});
    expect(frame?.type).toBe("auth");
    expect(frame?.sessionInfo?.sessionLabel).toBeUndefined();
  }, 30_000);
});

// ── set_session_label tool round-trip (best effort — stdio MCP client) ─────
//
// Uses the SDK's own Client + StdioClientTransport (rather than hand-rolling
// the newline-delimited JSON-RPC framing) to drive `initialize` then
// `tools/call`. The stub server here additionally answers the PUT .../label
// HTTP request the tool is expected to make.

/** `stores`: answer like a server with #327 -- the label lives on the grant and `authenticated` reports it. */
function startLabelStub(opts: { stores?: boolean; storedLabel?: string | null } = {}) {
  let stored: string | null = opts.storedLabel ?? null;
  let putSeen: { path: string; body: any; contextHeader: string | null } | null = null;
  // Every auth frame received, in order — a reconnect sends a SECOND one, and
  // the regression test below is specifically about what that second frame
  // carries. A single `authFrame` (last-write-wins) would not distinguish
  // "never reconnected" from "reconnected and sent the same thing twice".
  const authFrames: any[] = [];
  // The current connection's server-side socket, captured off the first
  // frame we see on it — WS auth is always the first message. Lets a test
  // force a reconnect deterministically by closing the transport out from
  // under the client, rather than waiting on the 90s liveness timeout.
  let liveWs: any = null;
  const agentAuth = createAgentAuthRoutes();
  agentAuth.addEnrolmentKey(ENROLMENT_KEY);
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, never the wildcard default — see stub-loopback-bind.test.ts.
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const auth = await agentAuth.handle(req);
      if (auth) return auth;
      const url = new URL(req.url);
      if (req.method === "PUT" && /^\/api\/agents\/[^/]+\/contexts\/[^/]+\/label$/.test(url.pathname)) {
        let body: any = {};
        try {
          body = await req.json();
        } catch {}
        putSeen = { path: url.pathname, body, contextHeader: req.headers.get("x-bridge-context") };
        stored = String(body.label ?? "") || null;
        return new Response(JSON.stringify({ label: "Reviewer · #ctx" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        liveWs = ws;
        let frame: any = {};
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (frame.type === "auth") {
          authFrames.push(frame);
          if (opts.stores && frame.sessionInfo?.sessionLabel) stored = frame.sessionInfo.sessionLabel;
          ws.send(
            JSON.stringify({
              v: 2,
              type: "authenticated",
              payload: {
                agentId: "jorgen-mac",
                agentName: "Jörgen (Mac)",
                contextId: "ctx",
                ...(opts.stores ? { label: stored } : {}),
              },
            })
          );
        }
      },
    },
  });
  return {
    port: server.port!,
    putSeen: () => putSeen,
    authFrames: () => authFrames,
    closeLiveSocket: () => {
      try {
        liveWs?.close();
      } catch {}
    },
    stop: () => server.stop(true),
  };
}

describe("set_session_label tool (best effort — stdio round trip)", () => {
  test("PUTs the label endpoint and reports the stored name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srt-tool-"));
    const stub = startLabelStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY, EINWEAVE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_KEY,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      // WS auth (and therefore agentId/myContextId) settles independently of
      // the stdio handshake, and the tool requires it — retry rather than
      // guessing a fixed delay.
      const deadline = Date.now() + 15_000;
      let lastErrText = "";
      let result: any = null;
      while (Date.now() < deadline) {
        result = await client.callTool({ name: "set_session_label", arguments: { label: "Reviewer" } });
        const text = Array.isArray(result?.content) ? (result.content[0]?.text ?? "") : "";
        if (!result?.isError) break;
        lastErrText = text;
        if (!/not yet authenticated/.test(text)) break;
        await Bun.sleep(200);
      }

      expect(result?.isError, `expected success, got: ${lastErrText}`).not.toBe(true);
      const text = result.content[0].text as string;
      expect(text).toContain("Reviewer · #ctx");

      const seen = stub.putSeen();
      expect(seen?.path).toBe("/api/agents/jorgen-mac/contexts/ctx/label");
      expect(seen?.body).toEqual({ label: "Reviewer" });
      // RFC-027 D2: no session header — the access token names the grant; the path carries its id.
      expect(seen?.contextHeader).toBeNull();
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Regression: the bug the first round-trip test could not have caught, because
// it never drove a SECOND auth frame. `set_session_label` used to stash the
// server's SUFFIXED response ("Reviewer · #ctx") into the in-memory
// `sessionLabel`, which `minimalSessionInfo()` feeds into the NEXT auth
// frame's `sessionInfo.sessionLabel` verbatim — and the SERVER re-suffixes
// whatever it receives. So a reconnect after a rename sent the already-
// suffixed value back, and the server would have compounded it further
// ("Reviewer · #ctx · #ctx") on every subsequent reconnect. `sessionLabel`
// must hold the RAW label, exactly like the on-disk file already does.
describe("an older server (no authenticated.label): the label rides every frame (regression: no double-suffix)", () => {
  test("the second auth frame after a rename carries the RAW label, not the server's suffixed one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srt-reconnect-"));
    const stub = startLabelStub();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY, EINWEAVE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_KEY,
        CLAUDE_CODE_SSE_PORT: "",
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);

      // First auth frame — the initial connect, before any rename.
      let deadline = Date.now() + 15_000;
      while (Date.now() < deadline && stub.authFrames().length < 1) await Bun.sleep(50);
      expect(stub.authFrames().length, "initial connect must auth").toBeGreaterThanOrEqual(1);

      // Rename — same auth-settling retry as the round-trip test above.
      deadline = Date.now() + 15_000;
      let result: any = null;
      let lastErrText = "";
      while (Date.now() < deadline) {
        result = await client.callTool({ name: "set_session_label", arguments: { label: "Reviewer" } });
        const text = Array.isArray(result?.content) ? (result.content[0]?.text ?? "") : "";
        if (!result?.isError) break;
        lastErrText = text;
        if (!/not yet authenticated/.test(text)) break;
        await Bun.sleep(200);
      }
      expect(result?.isError, `expected rename success, got: ${lastErrText}`).not.toBe(true);

      // Force a RECONNECT by closing the server-side socket out from under
      // the plugin. Its `close` listener fires scheduleReconnect() (~1s
      // backoff after a prior successful auth), which re-authenticates with
      // freshly collected sessionInfo — sessionInfoPromise was reset by the
      // tool call, so this is what actually exercises the in-memory
      // `sessionLabel` value the tool just set, not a cached auth payload.
      stub.closeLiveSocket();

      deadline = Date.now() + 15_000;
      while (Date.now() < deadline && stub.authFrames().length < 2) await Bun.sleep(50);
      const frames = stub.authFrames();
      expect(frames.length, "expected a second auth frame after forcing reconnect").toBeGreaterThanOrEqual(2);

      const secondLabel = frames[1]?.sessionInfo?.sessionLabel;
      expect(secondLabel).toBe("Reviewer");
      expect(secondLabel).not.toBe("Reviewer · #ctx");
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

// RFC-028 D6 (server #327): the label lives on the grant. Two windows on one session key: B renames,
// A takes the session back -- A's frame must not carry A's old label, or it undoes B's rename.
describe("a server that stores the label: a window sends one only as a change", () => {
  async function withPlugin(
    stub: ReturnType<typeof startLabelStub>,
    env: Record<string, string>,
    body: (client: Client) => Promise<void>
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "srt-stores-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: dir,
        EINWEAVE_STATE_DIR: dir,
        EINWEAVE_API_URL: `http://127.0.0.1:${stub.port}`,
        EINWEAVE_ENROLMENT_KEY: ENROLMENT_KEY, EINWEAVE_AUTOCONNECT: "1",
        CLAUDE_CODE_SESSION_ID: SESSION_KEY,
        CLAUDE_CODE_SSE_PORT: "",
        ...env,
      } as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await body(client);
    } finally {
      await client.close().catch(() => {});
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function frames(stub: ReturnType<typeof startLabelStub>, n: number): Promise<any[]> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && stub.authFrames().length < n) await Bun.sleep(50);
    expect(stub.authFrames().length, `expected ${n} auth frame(s)`).toBeGreaterThanOrEqual(n);
    return stub.authFrames();
  }

  async function status(client: Client): Promise<any> {
    const r: any = await client.callTool({ name: "status", arguments: { local: true } });
    return JSON.parse(r.content[0].text);
  }
  const shownLabel = async (client: Client): Promise<string | null> => (await status(client)).label;

  test("a window that did not rename adopts the stored label and never sends its own", async () => {
    const stub = startLabelStub({ stores: true, storedLabel: "renamed-in-b" });
    await withPlugin(stub, {}, async (client) => {
      const [first] = await frames(stub, 1);
      expect(first.sessionInfo?.sessionLabel).toBeUndefined();
      const until = Date.now() + 10_000;
      while (Date.now() < until && (await shownLabel(client)) !== "renamed-in-b") await Bun.sleep(50);
      expect(await shownLabel(client)).toBe("renamed-in-b");
      stub.closeLiveSocket();
      const all = await frames(stub, 2);
      expect(all[1].sessionInfo?.sessionLabel, "a reconnect must not undo a rename made in another window").toBeUndefined();
    });
  }, 40_000);

  test("the launch label rides the first frame only", async () => {
    const stub = startLabelStub({ stores: true });
    await withPlugin(stub, { EINWEAVE_SESSION_LABEL: "FromEnv" }, async (client) => {
      const [first] = await frames(stub, 1);
      expect(first.sessionInfo?.sessionLabel).toBe("FromEnv");
      const until = Date.now() + 10_000;
      while (Date.now() < until && (await status(client)).websocket !== "connected") await Bun.sleep(50);
      stub.closeLiveSocket();
      const all = await frames(stub, 2);
      expect(all[1].sessionInfo?.sessionLabel).toBeUndefined();
      expect(await shownLabel(client)).toBe("FromEnv");
    });
  }, 40_000);

  test("connect with a label on a connected window renames through the route: no later frame carries it", async () => {
    const stub = startLabelStub({ stores: true, storedLabel: "old" });
    await withPlugin(stub, {}, async (client) => {
      await frames(stub, 1);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (await shownLabel(client)) !== "old") await Bun.sleep(50);
      const r: any = await client.callTool({ name: "connect", arguments: { label: "x" } });
      expect(r?.isError, r?.content?.[0]?.text).not.toBe(true);
      expect(stub.putSeen()?.body, "the server must have the name, not only this window").toEqual({ label: "x" });
      stub.closeLiveSocket();
      const all = await frames(stub, 2);
      expect(all[1].sessionInfo?.sessionLabel, "a pending label would undo another window's later rename").toBeUndefined();
      expect(await shownLabel(client)).toBe("x");
    });
  }, 40_000);

  test("a rename here is stored by the route: no later frame carries it", async () => {
    const stub = startLabelStub({ stores: true });
    await withPlugin(stub, {}, async (client) => {
      await frames(stub, 1);
      const deadline = Date.now() + 15_000;
      let result: any = null;
      while (Date.now() < deadline) {
        result = await client.callTool({ name: "set_session_label", arguments: { label: "Reviewer" } });
        if (!result?.isError || !/not yet authenticated/.test(result.content?.[0]?.text ?? "")) break;
        await Bun.sleep(200);
      }
      expect(result?.isError).not.toBe(true);
      expect(await shownLabel(client)).toBe("Reviewer");
      stub.closeLiveSocket();
      const all = await frames(stub, 2);
      expect(all[1].sessionInfo?.sessionLabel).toBeUndefined();
      expect(await shownLabel(client)).toBe("Reviewer");
    });
  }, 40_000);
});
