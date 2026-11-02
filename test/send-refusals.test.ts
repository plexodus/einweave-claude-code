import { describe, expect, test } from "bun:test";
import { handleRefusal } from "../send-refusals";

const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error: code, code, message }, { status, headers });
const ok = () => Response.json({ id: "m1" }, { status: 201 });
const noSleep = async () => {};

// Mirrors apiFetch's wiring: the retry re-enters the handler with busyRetried=true.
function run(responses: Response[], sleeps: number[] = []) {
  let calls = 0;
  const next = () => responses[Math.min(calls++, responses.length - 1)]!;
  const sleep = async (ms: number) => void sleeps.push(ms);
  const go = (res: Response, busyRetried: boolean): Promise<Response> =>
    handleRefusal(res, "/api/messages", async () => go(next(), true), busyRetried, sleep);
  return { result: go(next(), false), calls: () => calls };
}

describe("send refusals", () => {
  test("busy then ok: retried once, waits Retry-After", async () => {
    const sleeps: number[] = [];
    const r = run([refuse(503, "parser_busy", "busy, not sent", { "Retry-After": "2" }), ok()], sleeps);
    expect((await r.result).status).toBe(201);
    expect(r.calls()).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  test("busy wait is capped at 5 s", async () => {
    const sleeps: number[] = [];
    await run([refuse(503, "parser_busy", "b", { "Retry-After": "60" }), ok()], sleeps).result;
    expect(sleeps).toEqual([5000]);
  });

  test("busy twice: error with the server message, no third try", async () => {
    const r = run([refuse(503, "parser_busy", "Your message was not sent; try again."), refuse(503, "parser_busy", "Your message was not sent; try again.")]);
    await expect(r.result).rejects.toThrow(/^Your message was not sent; try again\. \(einweave 503 parser_busy/);
    expect(r.calls()).toBe(2);
  });

  test("422 too complex: model text leads with the remedy verbatim, no retry", async () => {
    const msg = "This message is too complex to display. Wrap it in a code block or shorten it.";
    const r = run([refuse(422, "message_too_complex", msg)]);
    await expect(r.result).rejects.toThrow(new RegExp(`^${msg.replace(/[.]/g, "\\.")} \\(einweave 422 message_too_complex`));
    expect(r.calls()).toBe(1);
  });

  test("500 parser_error carries its message", async () => {
    await expect(run([refuse(500, "parser_error", "Wrap it in a code block.")]).result).rejects.toThrow(/^Wrap it in a code block\./);
  });

  test("429 throttled keeps the wait time (server message)", async () => {
    const r = run([refuse(429, "parser_throttled", "Your message was not sent; wait 3 s and try again.", { "Retry-After": "3" })]);
    await expect(r.result).rejects.toThrow(/wait 3 s/);
    expect(r.calls()).toBe(1);
  });

  test("plain 429 and other errors pass through for the existing handling", async () => {
    const rl = new Response("slow down", { status: 429, headers: { "Retry-After": "7" } });
    expect(await handleRefusal(rl, "/x", async () => ok(), false, noSleep)).toBe(rl);
    const other = Response.json({ error: "join_required" }, { status: 403 });
    expect(await handleRefusal(other, "/x", async () => ok(), false, noSleep)).toBe(other);
  });
});
