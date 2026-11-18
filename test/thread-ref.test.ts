/**
 * PR K: a thread parameter takes a thread id, a thread link or a work item key. A bare id costs no
 * request; anything else is the SDK's `threads.resolveRef`; every refusal names the parameter.
 * The source scan at the end keeps a new tool or call site from reading a thread param raw.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveThreadArg, resolveOptionalThreadArg, type ResolveRef } from "../thread-ref";

const T = "01a1499b-dbc7-7001-a4bb-d6b6fa14e01b";

function fake(answer: Awaited<ReturnType<ResolveRef>>) {
  const asked: string[] = [];
  const resolve: ResolveRef = async (input) => {
    asked.push(input);
    return answer;
  };
  return { resolve, asked };
}

describe("resolveThreadArg", () => {
  test("a bare id is the id (lower-cased, trimmed) and asks the server nothing", async () => {
    const f = fake({ ok: false, reason: "invalid" });
    expect(await resolveThreadArg(`  ${T.toUpperCase()} `, "thread_id", f.resolve)).toBe(T);
    expect(f.asked).toEqual([]);
  });

  test("a key or a link is resolved by the SDK, trimmed", async () => {
    const f = fake({ ok: true, threadId: T, via: "key", key: "EW-112" });
    expect(await resolveThreadArg(" ew-112 ", "thread_id", f.resolve)).toBe(T);
    expect(f.asked).toEqual(["ew-112"]);
  });

  test("each refusal names the parameter and why", async () => {
    await expect(resolveThreadArg("EW-9", "duplicate_of", fake({ ok: false, reason: "not_found" }).resolve)).rejects.toThrow(
      "duplicate_of: no work item EW-9 that this agent can read."
    );
    await expect(resolveThreadArg("https://x/w/a/c/b/t/c", "thread_id", fake({ ok: false, reason: "other_workspace" }).resolve)).rejects.toThrow(
      'thread_id: "https://x/w/a/c/b/t/c" is not a thread link of this workspace.'
    );
    await expect(resolveThreadArg("fix the build", "parent", fake({ ok: false, reason: "invalid" }).resolve)).rejects.toThrow(
      'parent: "fix the build" is not a thread id, a thread link, or a work item key (like EW-112).'
    );
  });

  test("absent, empty or not a string is required; nothing is asked", async () => {
    const f = fake({ ok: false, reason: "invalid" });
    for (const v of [undefined, null, "", "  ", 42]) {
      await expect(resolveThreadArg(v, "thread_id", f.resolve)).rejects.toThrow("thread_id is required");
    }
    expect(f.asked).toEqual([]);
  });

  test("optional: absent or empty stays undefined; whitespace is refused; a value is resolved like a required one", async () => {
    const f = fake({ ok: true, threadId: T, via: "key", key: "EW-1" });
    expect(await resolveOptionalThreadArg(undefined, "parent", f.resolve)).toBeUndefined();
    expect(await resolveOptionalThreadArg(null, "parent", f.resolve)).toBeUndefined();
    expect(await resolveOptionalThreadArg("", "parent", f.resolve)).toBeUndefined();
    await expect(resolveOptionalThreadArg("  ", "thread_id", f.resolve)).rejects.toThrow("thread_id is required");
    expect(await resolveOptionalThreadArg("EW-1", "parent", f.resolve)).toBe(T);
    await expect(resolveOptionalThreadArg("EW-1", "parent", fake({ ok: false, reason: "not_found" }).resolve)).rejects.toThrow("parent: no work item EW-1");
  });
});

describe("every thread parameter goes through the resolver (source scan)", () => {
  const root = join(import.meta.dir, "..");
  const PARAMS = ["thread_id", "parent_thread_id", "parent", "duplicate_of"];
  // A read of a thread param is allowed only as an argument of a resolver, or as a presence check.
  const ALLOWED = [
    /(?:threadArg|resolveThreadArg|resolveOptionalThreadArg)\(\s*(?:args|p)\.\w+/g,
    /typeof args\.\w+ !== "string"/g,
    /args\.\w+\.trim\(\) === ""/g,
    /args\.\w+ != null/g,
    /String\(args\.\w+\)\.trim\(\) !== ""/g,
  ];

  test("server.ts and work-tools.ts read no thread param raw", () => {
    const raw: string[] = [];
    for (const file of ["server.ts", "work-tools.ts"]) {
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          let rest = line;
          for (const re of ALLOWED) rest = rest.replace(re, "");
          const m = new RegExp(`\\b(?:args|p)\\.(${PARAMS.join("|")})\\b`).exec(rest);
          if (m) raw.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(raw).toEqual([]);
  });

  test("no tool schema has a thread-like string param outside the routed set", () => {
    const names = new Set<string>();
    for (const file of ["server.ts", "work-tools.ts"]) {
      for (const m of readFileSync(join(root, file), "utf8").matchAll(/\b(\w*(?:thread|parent|duplicate)\w*): \{\s*type: "string"/g)) names.add(m[1]!);
    }
    // `threadId` is in ui_state's OUTPUT schema (what the mod reads), not a parameter.
    expect([...names].filter((n) => !PARAMS.includes(n) && n !== "threadId")).toEqual([]);
  });
});
