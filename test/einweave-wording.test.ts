/**
 * 0.32.0 is the one cutover reinstall: every word the plugin shows a person or the model says
 * "einweave", never "Bridge" — the MCP instructions, every tool description and error, every
 * notice, the skills, the README and the manifests.
 *
 * Source scan, comments excluded: each runtime .ts/.tsx file goes through Bun's transpiler, which
 * drops comments and types and keeps every string and template literal, so what is left is the
 * code and the text it can print. The match is case-insensitive — `bridge channel:` on stderr and a
 * `sender="bridge"` channel tag are read too — and on whole words: `\bbridge\b` cannot match an
 * identifier such as `requireBridge` or an env var such as `BRIDGE_PROFILE` (no word boundary
 * inside either). What must keep the word (a legacy path, the old plugin's name) is allow-listed
 * below, line by line, with the reason.
 */
import { test, expect } from "bun:test";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORD = /\bbridge\b/i;

/** Runtime sources NOT scanned, and why. */
const SKIP_DIRS = [
  "test/", // fixtures and assertions, not shipped text
  "vendor/", // the vendored SDK is generated from the server repo (its own sweep)
  "node_modules/",
  "docs/", // design records: history, not product text
  "scripts/", // release tooling run by the maintainer, never by a user's plugin
];

/**
 * Text that must keep the word, with the reason. An entry is `{file, text}` — an exact line
 * fragment — so an allowance never covers a whole file or a new sentence.
 */
const ALLOW: { file: string; text: string; reason: string }[] = [
  { file: "state-dir.ts", text: 'join(homedir(), ".claude", "channels", "bridge")', reason: "the pre-0.30 state directory, migrated once on start — a real path on disk" },
  { file: "README.md", text: "(https://github.com/plexodus/bridge)", reason: "the server repository's URL" },
  { file: "README.md", text: "Uninstall `bridge` (`/plugin` → Installed → bridge → Uninstall)", reason: "the OLD plugin's installed name, which the person must find to remove it" },
  { file: "README.md", text: "plugin:bridge@bored-marketplace", reason: "the OLD launch flag a person must find in their aliases and replace" },
  { file: "README.md", text: "`~/.claude/channels/bridge` to `~/.einweave`", reason: "the pre-0.30 state directory the migration moves from" },
  { file: "skills/configure/SKILL.md", text: "Do NOT add a `bridge` entry to `~/.claude.json` mcpServers", reason: "the legacy hand-added MCP server name that must not be re-added" },
];

function allowed(file: string, line: string): boolean {
  return ALLOW.some((a) => a.file === file && line.includes(a.text));
}

async function files(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Bun.Glob(pattern).scan({ cwd: ROOT, dot: true })) {
    if (SKIP_DIRS.some((d) => f.startsWith(d)) || f.includes("/node_modules/") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
    out.push(f);
  }
  return out.sort();
}

function hits(file: string, text: string): string[] {
  return text
    .split("\n")
    .filter((l) => WORD.test(l) && !allowed(file, l))
    .map((l) => `${file}: ${l.trim().slice(0, 160)}`);
}

test("the scan sees the files that matter (it cannot pass by scanning nothing)", async () => {
  const ts = await files("**/*.{ts,tsx}");
  for (const f of ["server.ts", "work-tools.ts", "auth/login.ts", "reconnect-policy.ts", "link/adapter.ts"]) expect(ts).toContain(f);
  const md = await files("skills/**/*.md");
  expect(md.length).toBeGreaterThanOrEqual(13);
  // The transpiler keeps strings and drops comments — the scan's premise, checked.
  const out = new Bun.Transpiler({ loader: "ts" }).transformSync('// Bridge in a comment\nexport const s = "Bridge in a string";');
  expect(out).toContain("Bridge in a string");
  expect(out).not.toContain("in a comment");
  // Every allowance still matches a line: a stale one would silently widen the list.
  for (const a of ALLOW) expect((await Bun.file(join(ROOT, a.file)).text()).includes(a.text), `${a.file}: ${a.text}`).toBe(true);
});

test("no shipped code prints bridge (any case): instructions, tool descriptions, errors, notices, channel tags, stderr", async () => {
  const bad: string[] = [];
  for (const f of await files("**/*.{ts,tsx}")) {
    const src = await Bun.file(join(ROOT, f)).text();
    const code = new Bun.Transpiler({ loader: f.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(src);
    bad.push(...hits(f, code));
  }
  expect(bad).toEqual([]);
});

test("no skill, README or manifest says bridge (any case)", async () => {
  const bad: string[] = [];
  const docs = [...(await files("skills/**/*.md")), "README.md", ".claude-plugin/plugin.json", "hooks/hooks.json"];
  for (const f of docs) bad.push(...hits(relative(ROOT, join(ROOT, f)), await Bun.file(join(ROOT, f)).text()));
  expect(bad).toEqual([]);
});
