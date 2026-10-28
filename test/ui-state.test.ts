/**
 * The einweave mod's snapshot (ui/ui-state.ts) and its push path: the control socket's `watch` op
 * (delivery/ctl-server.ts) and the relay the mod starts (ui/ctl-watch.ts), against a real socket.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildUiState, toWaiting, UiWatch, type UiInputs } from "../ui/ui-state";
import { ctlSocketPath } from "../delivery/ctl-path";
import { openCtlServer, MAX_WATCHERS, type CtlServer, type WatchPort } from "../delivery/ctl-server";
import { MissedTracker } from "../delivery/missed";
import { parseCtlRequest } from "../delivery/ctl-protocol";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const INPUTS: UiInputs = {
  authenticated: true,
  hasSession: true,
  standby: false,
  stateText: "connected",
  agent: "bellman",
  label: "probe",
  kind: "session",
  scope: { mode: "none" },
  holds: ["t1"],
  waiting: { forYou: 2, channel: 0, more: false, top: [] },
  version: "0.38.0",
  staleSince: null,
};

describe("buildUiState", () => {
  test("connected: everything the session knows", () => {
    const s = buildUiState(INPUTS);
    expect(s.connection).toEqual({ state: "connected", detail: null });
    expect(s.session).toEqual({ agent: "bellman", label: "probe", kind: "session", scope: { mode: "none" } });
    expect(s.holds).toEqual(["t1"]);
    expect(s.waiting?.forYou).toBe(2);
  });

  test("not connected: no holds, scope or waiting from a socket that is gone, and the reason as detail", () => {
    const s = buildUiState({ ...INPUTS, authenticated: false, stateText: "disconnected (reconnect attempt 2, in 4s)" });
    expect(s.connection).toEqual({ state: "disconnected", detail: "disconnected (reconnect attempt 2, in 4s)" });
    expect(s.holds).toEqual([]);
    expect(s.waiting).toBeNull();
    expect(s.session.scope).toBeNull();
  });

  test("standby and idle are told apart from disconnected", () => {
    expect(buildUiState({ ...INPUTS, authenticated: false, standby: true }).connection.state).toBe("standby");
    expect(buildUiState({ ...INPUTS, authenticated: false, hasSession: false }).connection.state).toBe("idle");
  });
});

describe("toWaiting", () => {
  const row = (id: string, hold: "unheld" | "parked" | "held") => ({
    thread: { id, title: `T ${id}` },
    channel: { name: "general" },
    why: "addressed" as const,
    hold: { state: hold },
  });

  test("drops threads someone holds, keeps the order, caps at the limit", () => {
    const w = toWaiting({ rows: [row("a", "unheld"), row("b", "held"), row("c", "parked"), row("d", "unheld")], more: true, counts: { forYou: 3, channel: 1 } }, 2);
    expect(w.top.map((t) => t.threadId)).toEqual(["a", "c"]);
    expect(w).toMatchObject({ forYou: 3, channel: 1, more: true });
  });

  test("a server without counts: null, not 0", () => {
    const w = toWaiting({ rows: [], more: false, counts: null });
    expect(w.forYou).toBeNull();
    expect(w.channel).toBeNull();
  });
});

describe("UiWatch", () => {
  test("rev moves only when the snapshot changes, and only then are subscribers told", () => {
    const w = new UiWatch();
    const seen: number[] = [];
    w.subscribe((rev) => seen.push(rev));
    expect(w.set(buildUiState(INPUTS))).toBe(true);
    expect(w.set(buildUiState(INPUTS))).toBe(false);
    expect(w.set(buildUiState({ ...INPUTS, holds: ["t1", "t2"] }))).toBe(true);
    expect(seen).toEqual([1, 2]);
    expect(w.current()?.rev).toBe(2);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const w = new UiWatch();
    const seen: number[] = [];
    const off = w.subscribe((rev) => seen.push(rev));
    w.set(buildUiState(INPUTS));
    off();
    w.set(buildUiState({ ...INPUTS, label: "renamed" }));
    expect(seen).toEqual([1]);
    expect(w.subscribers()).toBe(0);
  });
});

test("the protocol knows watch", () => {
  expect(parseCtlRequest(JSON.stringify({ op: "watch" }))).toEqual({ op: "watch" });
});

// ── The socket ──────────────────────────────────────────────────────────────

const PID = 616161;

async function serve(watch: WatchPort | null): Promise<{ server: CtlServer; path: string; dir: string }> {
  const dir = mkdtempSync(join("/tmp", "ewu-"));
  const path = ctlSocketPath(dir, PID);
  const opened = await openCtlServer({
    path,
    pending: { list: () => [], confirm: () => [] },
    tracker: new MissedTracker(),
    toNotice: (e: { id: string }) => ({ id: e.id }) as never,
    log: () => {},
    ...(watch ? { watch } : {}),
  });
  if (!opened.server) throw new Error(`no server: ${opened.failure.detail}`);
  const server = opened.server;
  cleanups.push(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, path, dir };
}

/** Opens `watch` and collects the lines it gets until closed. */
function watchLines(path: string): { lines: any[]; closed: Promise<void>; end: () => void } {
  const lines: any[] = [];
  let buf = "";
  let sock: { end(): void } | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  void Bun.connect({
    unix: path,
    socket: {
      open(s) {
        sock = s;
        s.write(JSON.stringify({ op: "watch" }) + "\n");
      },
      data(_s, chunk) {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      },
      close() {
        resolveClosed();
      },
    },
  });
  return { lines, closed, end: () => sock?.end() };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

describe("ctl watch", () => {
  test("sends the current snapshot at once, then each change, on one open connection", async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    const { server, path } = await serve(w);
    const c = watchLines(path);
    await until(() => c.lines.length === 1);
    expect(c.lines[0]).toMatchObject({ ok: true, op: "watch", rev: 1, state: { holds: ["t1"] } });
    w.set(buildUiState({ ...INPUTS, holds: [] }));
    await until(() => c.lines.length === 2);
    expect(c.lines[1]).toMatchObject({ rev: 2, state: { holds: [] } });
    expect(server.watchers()).toBe(1);
    c.end();
    await c.closed;
    await until(() => server.watchers() === 0);
  });

  test("a current() that refreshes (as server.ts's does) still sends each rev once", async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    // server.ts rebuilds the snapshot inside current(): a change found there must not reach a new
    // watcher twice (once as a push, once as the first answer).
    const port: WatchPort = {
      current: () => {
        w.set(buildUiState({ ...INPUTS, holds: [] }));
        return w.current();
      },
      subscribe: (fn) => w.subscribe(fn),
    };
    const { path } = await serve(port);
    const c = watchLines(path);
    await until(() => c.lines.length >= 1);
    await Bun.sleep(50);
    expect(c.lines.map((l) => l.rev)).toEqual([2]);
    c.end();
    await c.closed;
  });

  test("a watcher is not a hook: hooks stay 'not reporting'", async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    const { server, path } = await serve(w);
    const c = watchLines(path);
    await until(() => c.lines.length === 1);
    expect(server.stats().lastHookAt).toBeNull();
  });

  test(`at most ${MAX_WATCHERS} watchers; the next is refused and closed`, async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    const { server, path } = await serve(w);
    const open = Array.from({ length: MAX_WATCHERS }, () => watchLines(path));
    await until(() => open.every((c) => c.lines.length === 1));
    const extra = watchLines(path);
    await extra.closed;
    expect(extra.lines).toEqual([{ ok: false, error: "too many watchers" }]);
    expect(server.watchers()).toBe(MAX_WATCHERS);
  });

  test("stop closes every watcher", async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    const { server, path } = await serve(w);
    const c = watchLines(path);
    await until(() => c.lines.length === 1);
    server.stop();
    await c.closed;
    expect(w.subscribers()).toBe(0);
  });

  test("a server without a snapshot refuses watch", async () => {
    const { path } = await serve(null);
    const c = watchLines(path);
    await c.closed;
    expect(c.lines).toEqual([{ ok: false, error: "watch unavailable" }]);
  });
});

describe("ui/ctl-watch.ts (the relay the mod starts)", () => {
  test("relays every snapshot line to stdout and exits 0 when the server closes", async () => {
    const w = new UiWatch();
    w.set(buildUiState(INPUTS));
    const { server, dir } = await serve(w);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "ui", "ctl-watch.ts")], {
      env: { ...process.env, EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(PID) },
      stdout: "pipe",
    });
    const reader = proc.stdout.getReader();
    let out = "";
    const read = async (n: number) => {
      while (out.split("\n").filter(Boolean).length < n) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
    };
    await read(1);
    w.set(buildUiState({ ...INPUTS, label: "renamed" }));
    await read(2);
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.rev)).toEqual([1, 2]);
    expect(lines[1].state.session.label).toBe("renamed");
    server.stop();
    expect(await proc.exited).toBe(0);
  });

  test("no socket: one error line, exit 1", async () => {
    const dir = mkdtempSync(join("/tmp", "ewu-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "ui", "ctl-watch.ts")], {
      env: { ...process.env, EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(PID) },
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(JSON.parse((await new Response(proc.stdout).text()).trim())).toEqual({ ok: false, error: "no control socket" });
  });
});

test("relay: a socket directory that is not ours alone is never read (exit 2)", async () => {
  const dir = mkdtempSync(join("/tmp", "ewu-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dirname(ctlSocketPath(dir, PID)), { mode: 0o755 });
  chmodSync(dirname(ctlSocketPath(dir, PID)), 0o755);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "ui", "ctl-watch.ts")], {
    env: { ...process.env, EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(PID) },
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(2);
});

test("server: ui_state answers with structuredContent even unconfigured (idle)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ewu-mcp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.EINWEAVE_API_URL;
  env.CLAUDE_PLUGIN_DATA = dir;
  env.EINWEAVE_STATE_DIR = dir;
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(new StdioClientTransport({ command: "bun", args: [new URL("../server.ts", import.meta.url).pathname], env }));
    const tool = (await client.listTools()).tools.find((t) => t.name === "ui_state");
    expect(tool?.outputSchema).toBeDefined();
    const r: any = await client.callTool({ name: "ui_state", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ v: 1, rev: 1, connection: { state: "idle" }, holds: [], waiting: null });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  } finally {
    await client.close().catch(() => {});
  }
}, 30_000);
