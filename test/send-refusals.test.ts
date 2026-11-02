import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendMessage } from "../send-refusals";

const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: code, code, message }, { status, headers });
const ok = () => Response.json({ id: "m1" }, { status: 201 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A stub single-attempt fetch: answers in order (the last repeats), and FAILS the test past `max` calls — a lost retry bound goes red, never hangs. */
function stub(responses: Response[], max = 5) {
  const bodies: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const attempt = async (body: Record<string, unknown>) => {
    if (bodies.length >= max) throw new Error(`attempt called more than ${max} times: the retry bound is gone`);
    bodies.push(body);
    return responses[Math.min(bodies.length - 1, responses.length - 1)]!.clone() as Response;
  };
  const sleep = async (ms: number) => void sleeps.push(ms);
  return { send: (body: Record<string, unknown> = { content: "hi" }) => sendMessage(attempt, body, sleep), bodies, sleeps };
}

describe("sendMessage: clientMsgId", () => {
  test("mints a canonical UUID when absent, keeps the caller's own", async () => {
    const a = stub([ok()]);
    await a.send({ content: "hi" });
    expect(a.bodies[0]!.clientMsgId).toMatch(UUID);
    expect(a.bodies[0]!.content).toBe("hi");
    const b = stub([ok()]);
    await b.send({ content: "hi", clientMsgId: "mine" });
    expect(b.bodies[0]!.clientMsgId).toBe("mine");
  });

  test("the retry re-sends the SAME body and clientMsgId", async () => {
    const s = stub([refuse(503, "parser_busy", "busy", { "Retry-After": "1" }), ok()]);
    await s.send();
    expect(s.bodies).toHaveLength(2);
    expect(s.bodies[1]).toEqual(s.bodies[0]!);
  });
});

describe("sendMessage: parser_busy", () => {
  test("busy then ok: retried once, waits Retry-After", async () => {
    const s = stub([refuse(503, "parser_busy", "busy, not sent", { "Retry-After": "2" }), ok()]);
    expect((await s.send()).status).toBe(201);
    expect(s.bodies).toHaveLength(2);
    expect(s.sleeps).toEqual([2000]);
  });

  test("no Retry-After: waits 1 s", async () => {
    const s = stub([refuse(503, "parser_busy", "busy"), ok()]);
    await s.send();
    expect(s.sleeps).toEqual([1000]);
  });

  test("wait is capped at 5 s", async () => {
    const s = stub([refuse(503, "parser_busy", "b", { "Retry-After": "60" }), ok()]);
    await s.send();
    expect(s.sleeps).toEqual([5000]);
  });

  test("busy twice: error with the server message, no third try", async () => {
    const m = "Your message was not sent; try again.";
    const s = stub([refuse(503, "parser_busy", m)]);
    await expect(s.send()).rejects.toThrow(new RegExp(`^${m.replace(/[.;]/g, "\\$&")} \\(einweave 503 parser_busy`));
    expect(s.bodies).toHaveLength(2);
  });

  test("error-only body {error, message} (no code) is read the same way", async () => {
    const s = stub([Response.json({ error: "parser_busy", message: "busy" }, { status: 503 }), ok()]);
    expect((await s.send()).status).toBe(201);
    expect(s.bodies).toHaveLength(2);
  });

  test("parser_busy on a non-503 is thrown, not retried", async () => {
    const s = stub([refuse(500, "parser_busy", "odd")]);
    await expect(s.send()).rejects.toThrow(/^odd \(einweave 500 parser_busy/);
    expect(s.bodies).toHaveLength(1);
  });
});

describe("sendMessage: other refusals and pass-through", () => {
  test("422 too complex: leads with the remedy verbatim, no retry", async () => {
    const msg = "This message is too complex to display. Wrap it in a code block or shorten it.";
    const s = stub([refuse(422, "message_too_complex", msg)]);
    await expect(s.send()).rejects.toThrow(new RegExp(`^${msg.replace(/[.]/g, "\\.")} \\(einweave 422 message_too_complex`));
    expect(s.bodies).toHaveLength(1);
  });

  test("500 parser_error carries its message", async () => {
    await expect(stub([refuse(500, "parser_error", "Wrap it in a code block.")]).send()).rejects.toThrow(/^Wrap it in a code block\./);
  });

  test("429 throttled keeps the wait time (server message)", async () => {
    const s = stub([refuse(429, "parser_throttled", "Your message was not sent; wait 3 s and try again.", { "Retry-After": "3" })]);
    await expect(s.send()).rejects.toThrow(/wait 3 s/);
    expect(s.bodies).toHaveLength(1);
  });

  test("an empty message is not a refusal", async () => {
    const res = refuse(422, "message_too_complex", "");
    expect(await stub([res]).send()).toBeInstanceOf(Response);
  });

  test("other errors come back with their body still readable", async () => {
    for (const [status, code] of [[403, "join_required"], [409, "holder_online"]] as const) {
      const res = await stub([Response.json({ error: code }, { status })]).send();
      expect(res.status).toBe(status);
      expect(await res.text()).toContain(code);
    }
  });

  test("a 2xx whose body carries a refusal code and message is returned, not thrown", async () => {
    const res = await stub([Response.json({ code: "parser_busy", message: "looks like a refusal" }, { status: 201 })]).send();
    expect(res.status).toBe(201);
    expect(await res.text()).toContain("looks like a refusal");
  });
});

describe("the wiring: every message send goes through sendMessage", () => {
  // No better seam exists for server.ts (a module that boots an MCP server on import), so read it:
  // a POST to either message route that skips sendMessage loses the retry, the clientMsgId and the refusal text.
  const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");

  test("reply and create_item's send are built on sendMessage", () => {
    expect(src).toContain('await sendMessage((b) => apiFetch(sendPath, { method: "POST", body: JSON.stringify(b) }), body)');
    expect(src).toContain('await sendMessage((b) => apiFetch("/api/messages", { method: "POST", body: JSON.stringify(b) }), body)');
  });

  test("no other call posts to a message route", () => {
    const lines = src.split("\n").filter((l) => /apiFetch\(.*(\/api\/messages["`]|\/messages`)/.test(l) && !l.includes("sendMessage("));
    expect(lines).toEqual([]);
    expect(src.match(/sendPath/g)!.length).toBeGreaterThanOrEqual(2);
  });

  test("apiFetch has no busy logic of its own", () => {
    expect(src).not.toContain("busyRetried");
  });
});
