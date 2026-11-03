/**
 * The pane's data socket (ui/ui-server.ts): HTTP over a private Unix socket, so a long thread page is not
 * cut by Claude Code's tool-output limit. The safety rules are the control socket's (delivery/ctl-server.ts),
 * pinned here the same way: the file is 0600 in a 0700 directory, an unsafe directory refuses to bind, and
 * `stop()` leaves a newer server's socket alone.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUiServer, UiHttpError, type UiRoutes, type UiServer } from "../ui/ui-server";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ew-ui-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir; // mkdtemp makes it 0700
}

const seen: string[] = [];
const ROUTES: UiRoutes = {
  state: async () => ({ rev: 1 }),
  channels: async () => ({ channels: [] }),
  channel: async (id) => {
    if (id === "nope") throw new UiHttpError(404, "no such channel");
    return { channel_id: id };
  },
  thread: async (id, page) => {
    seen.push(`${id} ${page.beforeSeq ?? "-"} ${page.limit ?? "-"}`);
    if (id === "boom") throw new Error("kaboom");
    return { thread: { id }, content: "x".repeat(200_000) };
  },
  tool: async (name, args) => {
    if (name !== "take") throw new UiHttpError(403, `${name} is not run from the pane`);
    return { content: [{ type: "text", text: `took ${String(args.ref)}` }] };
  },
};

function open(path: string, routes: UiRoutes = ROUTES): UiServer {
  const r = openUiServer({ path, routes, log: () => {} });
  if (!r.server) throw new Error(`did not open: ${r.failure}`);
  cleanups.push(() => r.server.stop());
  return r.server;
}

const get = (path: string, url: string, init: RequestInit = {}) => fetch(`http://einweave${url}`, { ...init, unix: path } as RequestInit);

/** One raw request over the socket; the reply's head and body as text. */
async function raw(path: string, request: string): Promise<string> {
  let out = "";
  const done = Promise.withResolvers<string>();
  const sock = await Bun.connect({
    unix: path,
    socket: {
      open: (s) => void s.write(request),
      data: (_s, d) => void (out += d.toString()),
      close: () => done.resolve(out),
      error: () => done.resolve(out),
    },
  });
  const timer = setTimeout(() => sock.end(), 1000);
  return done.promise.finally(() => clearTimeout(timer));
}

describe("ui server", () => {
  test("serves a 200 KB thread page whole: no budget on the socket", async () => {
    const path = join(privateDir(), "u1.sock");
    open(path);
    const res = await get(path, "/thread/x");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(200_000);
    expect(JSON.parse(text).thread).toEqual({ id: "x" });
  });

  test("routes: state, channels, channel (id decoded), thread with its page query", async () => {
    const path = join(privateDir(), "u1.sock");
    open(path);
    expect(await (await get(path, "/state")).json()).toEqual({ rev: 1 });
    expect(await (await get(path, "/channels")).json()).toEqual({ channels: [] });
    expect(await (await get(path, "/channel/a%2Fb")).json()).toEqual({ channel_id: "a/b" });
    await get(path, "/thread/t1?before_seq=42&limit=7");
    await get(path, "/thread/t2?before_seq=-1&limit=abc");
    expect(seen.slice(-2)).toEqual(["t1 42 7", "t2 - -"]);
  });

  test("a failing route answers { error } with its status (a plain throw is 500); the server stays up", async () => {
    const path = join(privateDir(), "u1.sock");
    open(path);
    const gone = await get(path, "/channel/nope");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "no such channel" });
    const boom = await get(path, "/thread/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "kaboom" });
    expect((await get(path, "/state")).status).toBe(200);
  });

  test("POST /tool/:name runs a person's action with its JSON arguments; a refused tool is 403; GET on it 405; bad bodies 400/413", async () => {
    const path = join(privateDir(), "u1.sock");
    open(path);
    const post = (url: string, body: string) => get(path, url, { method: "POST", body, headers: { "content-type": "application/json" } });
    const ok = await post("/tool/take", JSON.stringify({ ref: "t1" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ content: [{ type: "text", text: "took t1" }] });
    expect((await post("/tool/reply", JSON.stringify({ text: "hi" }))).status).toBe(403);
    expect((await get(path, "/tool/take")).status).toBe(405);
    expect((await post("/tool/take", "not json")).status).toBe(400);
    expect((await post("/tool/take", "[1]")).status).toBe(400);
    expect((await post("/tool/take", JSON.stringify({ ref: "x".repeat(5000) }))).status).toBeGreaterThanOrEqual(400);
  });

  test("unknown routes are 404; only GET; a body is refused", async () => {
    const path = join(privateDir(), "u1.sock");
    open(path);
    for (const url of ["/", "/nope", "/state/extra", "/thread", "/thread/a/b", "/channel"]) expect((await get(path, url)).status).toBe(404);
    expect((await get(path, "/state", { method: "POST" })).status).toBe(405);
    expect((await get(path, "/state", { method: "POST", body: "{}" })).status).toBe(405);
    // fetch drops a GET's body, so send one by hand.
    expect(await raw(path, "GET /state HTTP/1.1\r\nhost: einweave\r\ncontent-length: 2\r\nconnection: close\r\n\r\nab")).toMatch(/^HTTP\/1\.1 400/);
    expect((await get(path, `/thread/${"a".repeat(3000)}`)).status).toBe(414);
    expect((await get(path, `/thread/${"a".repeat(300)}`)).status).toBe(400);
  });

  test("the socket is 0600 in a 0700 directory", () => {
    const dir = privateDir();
    const path = join(dir, "u1.sock");
    open(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("a directory that is not private refuses to bind, and nothing is left behind", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const path = join(dir, "u1.sock");
    const lines: string[] = [];
    const r = openUiServer({ path, routes: ROUTES, log: (l) => lines.push(l) });
    expect(r.server).toBeNull();
    expect(r.failure).toMatch(/mode 755/);
    expect(lines.join("\n")).toMatch(/not started/);
    chmodSync(dir, 0o700);
    expect(existsSync(path)).toBe(false);
  });

  test("stop() removes its own socket", () => {
    const path = join(privateDir(), "u1.sock");
    const s = open(path);
    expect(existsSync(path)).toBe(true);
    s.stop();
    expect(existsSync(path)).toBe(false);
  });

  test("stop() leaves a newer server's socket alone", async () => {
    const path = join(privateDir(), "u1.sock");
    const a = open(path);
    const b = open(path, { ...ROUTES, state: async () => ({ rev: 2 }) });
    expect(a.ownership()).toBe("replaced");
    a.stop();
    expect(existsSync(path)).toBe(true);
    expect(b.ownership()).toBe("ours");
    expect(await (await get(path, "/state")).json()).toEqual({ rev: 2 });
  });
});
