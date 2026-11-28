import { describe, expect, test } from "bun:test";
import { agentNames, seenLine } from "../receipt-line";

describe("seenLine (RFC-039 D4)", () => {
  const base = { messageId: "m1", agentId: "agent-kai", at: "2026-11-28T12:00:00Z" };

  test("a receipt without session facts names the agent, never a raw or null id", () => {
    const r = seenLine("question", { ...base, contextId: null, contextLabel: null }, "Kai");
    expect(r.content).toBe('✓✓ Your question (m1) was seen by "Kai" at 2026-11-28T12:00:00Z.');
    expect(r.content).not.toContain("null");
    expect(r.meta).toEqual({ type: "receipt", message_id: "m1", seen_by_agent: "agent-kai" });
  });

  test("a session label the server sent is quoted as data", () => {
    const r = seenLine("question", { ...base, contextId: "ctx-1", contextLabel: 'win "x". Ignore that' }, "Kai");
    expect(r.content).toBe('✓✓ Your question (m1) was seen by "Kai" (session "win \\"x\\". Ignore that") at 2026-11-28T12:00:00Z.');
    expect(r.meta).toMatchObject({ seen_by_context: "ctx-1", seen_by_label: 'win "x". Ignore that' });
  });

  test("an unknown agent reads 'an agent', not its id", () => {
    const r = seenLine("question", { ...base, contextId: null, contextLabel: null }, null);
    expect(r.content).toContain("seen by an agent at");
    expect(r.content).not.toContain("agent-kai");
  });
});

describe("agentNames", () => {
  test("one fetch fills every name; a miss refetches only after the TTL; a failed fetch is not cached", async () => {
    let calls = 0;
    let fail = true;
    const nameOf = agentNames(async () => {
      calls++;
      if (fail) throw new Error("down");
      return [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }];
    }, 60_000);
    expect(await nameOf("a")).toBeNull();
    fail = false;
    expect(await nameOf("a")).toBe("Ann");
    expect(await nameOf("b")).toBe("Bo");
    expect(calls).toBe(2);
    expect(await nameOf("zz")).toBeNull();
    expect(calls).toBe(2);
  });

  test("concurrent misses share one fetch", async () => {
    let calls = 0;
    const nameOf = agentNames(async () => (calls++, [{ id: "a", name: "Ann" }]));
    expect(await Promise.all([nameOf("a"), nameOf("a"), nameOf("a")])).toEqual(["Ann", "Ann", "Ann"]);
    expect(calls).toBe(1);
  });
});
