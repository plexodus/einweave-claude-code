/**
 * RFC-038 D3 — the tool table's `turn` column (`turn/tools.ts`), scanned against the source both ways:
 * every tool the server lists declares one, and its case body touches a thread exactly when it says so.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_TURN } from "../turn/tools";
import { WORK_TOOL_NAMES } from "../work-tools";

const root = join(import.meta.dir, "..");
const server = readFileSync(join(root, "server.ts"), "utf8");
const work = readFileSync(join(root, "work-tools.ts"), "utf8");

/** Names in the ListTools handler's table (server.ts) plus the work tools. */
function listedTools(): string[] {
  const start = server.indexOf("mcp.setRequestHandler(ListToolsRequestSchema");
  const end = server.indexOf("mcp.setRequestHandler(CallToolRequestSchema");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const own = [...server.slice(start, end).matchAll(/^ {4,6}name: "([a-z_]+)"/gm)].map((m) => m[1]!);
  return [...new Set([...own, ...WORK_TOOL_NAMES])];
}

/** A tool's case body: from its `case` to the next one at the same indent. */
function caseBody(src: string, name: string, indent: string): string {
  const start = src.indexOf(`\n${indent}case "${name}"`);
  if (start < 0) return "";
  const next = src.indexOf(`\n${indent}case "`, start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

const bodyOf = (name: string) => (WORK_TOOL_NAMES.has(name) ? caseBody(work, name, "    ") : caseBody(server.slice(server.indexOf("async function runTool(")), name, "      "));
/** The ways a body adds to the call's `touched` list (directly, or by handing the list on). */
const TOUCHES = /touched\.push\(|readDeliveries\(args, touched\)|took: \(t\) => touched\.push/;

describe("the `turn` column", () => {
  test("every listed tool declares one, and nothing else does", () => {
    const listed = listedTools();
    expect(listed.length).toBeGreaterThan(30);
    expect(listed.filter((n) => !(n in TOOL_TURN)), "listed with no `turn`").toEqual([]);
    expect(Object.keys(TOOL_TURN).filter((n) => !listed.includes(n)), "a `turn` for a tool not listed").toEqual([]);
  });

  test("a `write` or `held-read` tool's case touches; a `none` tool's never does", () => {
    for (const [name, turn] of Object.entries(TOOL_TURN)) {
      const body = bodyOf(name);
      expect(body.length, `case "${name}" found`).toBeGreaterThan(0);
      if (turn === "none") expect(TOUCHES.test(body), `${name} is "none" but touches`).toBe(false);
      else expect(TOUCHES.test(body), `${name} is "${turn}" but touches nothing`).toBe(true);
    }
  });

  test("the work-tools dispatcher hands the call's list on", () => {
    expect(server).toContain("await callWorkTool(name, args, workDeps, touched)");
  });
});
