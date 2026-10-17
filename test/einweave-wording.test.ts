/**
 * 0.32.0 is the one cutover reinstall: every word the plugin shows a person or the model says
 * "einweave", never "Bridge" — the MCP instructions, every tool description and error, every
 * notice, the skills, the README and the manifests.
 *
 * Source scan, comments excluded: each runtime .ts/.tsx file goes through Bun's transpiler, which
 * drops comments and types and keeps every string and template literal, so what is left is the
 * code and the text it can print. `\bBridge\b` cannot match an identifier such as `requireBridge`
 * (no word boundary inside it), env var names (`BRIDGE_…`, other case) or paths (`bridge-…`).
 */
import { test, expect } from "bun:test";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORD = /\bBridge\b/;

/** Runtime sources NOT scanned, and why. */
const SKIP_DIRS = [
  "test/", // fixtures and assertions, not shipped text
  "vendor/", // the vendored SDK is generated from the server repo (its own sweep)
  "node_modules/",
  "docs/", // design records: history, not product text
  "scripts/", // release tooling run by the maintainer, never by a user's plugin
];

/**
 * Text that must keep the word, with the reason. Empty today: nothing shipped needs it. An entry
 * is `{file, text}` — the exact line fragment — so an allowance never covers a whole file.
 */
const ALLOW: { file: string; text: string; reason: string }[] = [];

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
});

test("no shipped code prints Bridge: instructions, tool descriptions, errors, notices", async () => {
  const bad: string[] = [];
  for (const f of await files("**/*.{ts,tsx}")) {
    const src = await Bun.file(join(ROOT, f)).text();
    const code = new Bun.Transpiler({ loader: f.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(src);
    bad.push(...hits(f, code));
  }
  expect(bad).toEqual([]);
});

test("no skill, README or manifest says Bridge", async () => {
  const bad: string[] = [];
  const docs = [...(await files("skills/**/*.md")), "README.md", ".claude-plugin/plugin.json", "hooks/hooks.json"];
  for (const f of docs) bad.push(...hits(relative(ROOT, join(ROOT, f)), await Bun.file(join(ROOT, f)).text()));
  expect(bad).toEqual([]);
});
