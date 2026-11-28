/**
 * The mod server (ui/mod-server.ts): HTTP over a private Unix socket, so a long thread page is not
 * cut by Claude Code's tool-output limit. The safety rules are the control socket's (delivery/ctl-server.ts),
 * pinned here the same way: the file is 0600 in a 0700 directory, an unsafe directory refuses to bind, and
 * `stop()` leaves a newer server's socket alone.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openModServer, ModHttpError, type ModRoutes, type ModServer } from "../ui/mod-server";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function privateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ew-mod-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir; // mkdtemp makes it 0700
}

const seen: string[] = [];
const ROUTES: ModRoutes = {
  state: async () => ({ rev: 1 }),
  channels: async () => ({ channels: [] }),
  sessions: async () => ({ sessions: [{ id: "s1" }] }),
  channel: async (id) => {
    if (id === "nope") throw new ModHttpError(404, "no such channel");
    return { channel_id: id };
  },
  thread: async (id, page) => {
    seen.push(`${id} ${page.beforeSeq ?? "-"} ${page.limit ?? "-"}`);
    if (id === "boom") throw new Error("kaboom");
    return { thread: { id }, content: "x".repeat(200_000) };
  },
  search: async (p) => {
    seen.push(`search ${JSON.stringify(p)}`);
    return { results: [] };
  },
  tool: async (name, args) => {
    if (name !== "take") throw new ModHttpError(403, `${name} is not run from the pane`);
    return { content: [{ type: "text", text: `took ${String(args.ref)}` }] };
  },
  turn: async (post) => {
    seen.push(`turn ${JSON.stringify(post)}`);
    return { ok: true };
  },
};

function open(path: string, routes: ModRoutes = ROUTES): ModServer {
  const r = openModServer({ path, routes, log: () => {} });
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

describe("mod server", () => {
  test("serves a 200 KB thread page whole: no budget on the socket", async () => {
    const path = join(privateDir(), "m1.sock");
    open(path);
    const res = await get(path, "/thread/x");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(200_000);
    expect(JSON.parse(text).thread).toEqual({ id: "x" });
  });

  test("routes: state, channels, channel (id decoded), thread with its page query", async () => {
    const path = join(privateDir(), "m1.sock");
    open(path);
    expect(await (await get(path, "/state")).json()).toEqual({ rev: 1 });
    expect(await (await get(path, "/channels")).json()).toEqual({ channels: [] });
    expect(await (await get(path, "/sessions")).json()).toEqual({ sessions: [{ id: "s1" }] });
    expect(await (await get(path, "/channel/a%2Fb")).json()).toEqual({ channel_id: "a/b" });
    await get(path, "/thread/t1?before_seq=42&limit=7");
    await get(path, "/thread/t2?before_seq=-1&limit=abc");
    expect(seen.slice(-2)).toEqual(["t1 42 7", "t2 - -"]);
  });

  test("GET /search passes q, type, sort, cursor and limit decoded; no q or a bad type/sort is 400", async () => {
    const path = join(privateDir(), "m1.sock");
    open(path);
    const q = encodeURIComponent('deploy "a phrase" in:#ops');
    const res = await get(path, `/search?q=${q}&type=messages&sort=newest&cursor=${encodeURIComponent("eyJ/=")}&limit=7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(seen.at(-1)).toBe(`search ${JSON.stringify({ query: 'deploy "a phrase" in:#ops', type: "messages", sort: "newest", cursor: "eyJ/=", limit: 7 })}`);
    await get(path, "/search?q=w");
    expect(seen.at(-1)).toBe(`search ${JSON.stringify({ query: "w" })}`);
    for (const url of ["/search", "/search?q=%20", "/search?q=w&type=people", "/search?q=w&sort=oldest"]) expect((await get(path, url)).status).toBe(400);
    expect((await get(path, "/search/x?q=w")).status).toBe(404);
  });

  test("POST /turn takes one JSON post of the mod's turn sender; GET is 405, not JSON 400, too large 413, a path after it 404", async () => {
    const path = join(privateDir(), "m1.sock");
    open(path);
    const post = { kind: "snapshot", epoch: "e", seq: 1, state: "working", loops: [], waiting: [], agents: [] };
    const res = await get(path, "/turn", { method: "POST", body: JSON.stringify(post) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toBe(`turn ${JSON.stringify(post)}`);
    expect((await get(path, "/turn")).status).toBe(405);
    expect((await get(path, "/turn", { method: "POST", body: "{" })).status).toBe(400);
    expect((await get(path, "/turn", { method: "POST", body: JSON.stringify({ pad: "x".repeat(70_000) }) })).status).toBe(413);
    expect((await get(path, "/turn/working", { method: "POST" })).status).toBe(404);
  });

  test("a failing route answers { error } with its status (a plain throw is 500); the server stays up", async () => {
    const path = join(privateDir(), "m1.sock");
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
    const path = join(privateDir(), "m1.sock");
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
    const path = join(privateDir(), "m1.sock");
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
    const path = join(dir, "m1.sock");
    open(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("a directory that is not private refuses to bind, and nothing is left behind", () => {
    const dir = privateDir();
    chmodSync(dir, 0o755);
    const path = join(dir, "m1.sock");
    const lines: string[] = [];
    const r = openModServer({ path, routes: ROUTES, log: (l) => lines.push(l) });
    expect(r.server).toBeNull();
    expect(r.failure).toMatch(/mode 755/);
    expect(lines.join("\n")).toMatch(/not started/);
    chmodSync(dir, 0o700);
    expect(existsSync(path)).toBe(false);
  });

  test("stop() removes its own socket", () => {
    const path = join(privateDir(), "m1.sock");
    const s = open(path);
    expect(existsSync(path)).toBe(true);
    s.stop();
    expect(existsSync(path)).toBe(false);
  });

  test("stop() leaves a newer server's socket alone", async () => {
    const path = join(privateDir(), "m1.sock");
    const a = open(path);
    const b = open(path, { ...ROUTES, state: async () => ({ rev: 2 }) });
    expect(a.ownership()).toBe("replaced");
    a.stop();
    expect(existsSync(path)).toBe(true);
    expect(b.ownership()).toBe("ours");
    expect(await (await get(path, "/state")).json()).toEqual({ rev: 2 });
  });
});

/**
 * RFC-039 §5 step 0: the server first named for the pane is the MOD server — it carries the pane's data, a person's actions,
 * RFC-038 turns and, next, the mod's control signals. No old name is left in the plugin's sources, so a
 * reader never meets two names for one channel. The patterns are split so this file does not match itself.
 */
test("no source names the mod server by its old UI name", async () => {
  const root = join(import.meta.dir, "..");
  const old = [
    new RegExp("\\bui" + "-server\\b"),
    new RegExp("\\bUi" + "(HttpError|Routes|Server|ServerOptions|Open)\\b"),
    new RegExp("\\bui" + "(Socket|SocketPath|Read|Tool|Handler|Routes)\\b"),
    new RegExp("\\bUI " + "(socket|server)\\b", "i"),
    new RegExp("\\bdata " + "socket\\b", "i"),
    new RegExp("\\bu" + "\\d+(-[0-9a-f]{8,12})?\\.sock\\b"),
    new RegExp('socketPath\\("' + 'u"'),
  ];
  const skip = ["vendor/", "node_modules/", "docs/", "test/fixtures/"];
  const hits: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx,md,json}").scan({ cwd: root })) {
    if (skip.some((d) => file.startsWith(d))) continue;
    const lines = (await Bun.file(join(root, file)).text()).split("\n");
    lines.forEach((line, i) => {
      if (old.some((re) => re.test(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});
