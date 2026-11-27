/**
 * A closed window holds nothing (plan 2026-11-26-closed-window-holds) — the pure halves:
 * the guard that keeps a session another window is on (end-session.ts `keepReason`), the note a
 * conversation gets about threads its ended session lost (clear-note.ts `releasedNote`), the
 * once-per-ended-session record (released-store.ts), and the SessionEnd hook's choice of which
 * exits end a session. The wiring is proven at the seam in delivery-server.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepReason, endConversation } from "../end-session";
import { releasedNote, NOTE_MAX_CHARS } from "../clear-note";
import { wasTold, markTold, TOLD_TTL_MS } from "../released-store";
import { procStartOf } from "../proc-start";
import { createRuntime } from "../vendor/einweave-agent-sdk/index.js";

const T = (n: number) => `01990000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const KEY = "conv-left";
const WINDOW = 4242; // this window's Claude Code pid (data only)

let dir = "";
const live: Array<ReturnType<typeof Bun.spawn>> = [];
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ewclosed-"))));
afterEach(() => {
  for (const p of live.splice(0)) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** A live process to stand for another einweave copy (its pid must be alive and verifiable). */
function aLivePid(): number {
  const p = Bun.spawn(["sleep", "30"]);
  live.push(p);
  return p.pid;
}
function writeProcRecord(pid: number, sessionKey: string, claudePid: number | null): void {
  mkdirSync(join(dir, "procs"), { recursive: true });
  writeFileSync(
    join(dir, "procs", `${pid}.json`),
    JSON.stringify({ format: 0, pid, procStart: procStartOf(pid), software: "einweave-claude-code", version: "0.52.0", sessionKey, profile: "default", claudePid, tty: "", termProgram: "", cwd: "", state: "standby", startedAt: new Date().toISOString() })
  );
}
function writeLock(sessionKey: string, pid: number, procStart = procStartOf(pid)): void {
  mkdirSync(join(dir, "locks"), { recursive: true });
  writeFileSync(join(dir, "locks", `${sessionKey}.lock`), JSON.stringify({ pid, procStart, sessionKey, at: new Date().toISOString() }));
}

describe("keepReason: a session another window is on is never ended", () => {
  test("nobody on the key: it may end", async () => {
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
  });

  test("this window's own einweave on the key (it holds the lock): it may end", async () => {
    const mine = aLivePid();
    writeProcRecord(mine, KEY, WINDOW);
    writeLock(KEY, mine);
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
  });

  test("another window's einweave on the key (standing by): kept", async () => {
    writeProcRecord(aLivePid(), KEY, WINDOW + 1);
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toMatch(/another window's einweave/);
  });

  test("another window's einweave on ANOTHER key: irrelevant", async () => {
    writeProcRecord(aLivePid(), "conv-other", WINDOW + 1);
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
  });

  test("the lock held by a live process that is not this window's: kept", async () => {
    writeLock(KEY, aLivePid());
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toMatch(/session lock is held by pid/);
  });

  test("the lock record of a process that is gone (or a reused pid): it may end", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    writeLock(KEY, p.pid, "Thu Jan  1 00:00:00 1970");
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
    writeLock(KEY, process.pid, "Thu Jan  1 00:00:00 1970"); // alive, but provably someone else
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
  });


  test("this window unknown: kept (nothing can be attributed to it)", async () => {
    expect(await keepReason(dir, KEY, { claudePid: null })).toMatch(/unknown/);
  });

  test("the plugin is on the key AGAIN (a /resume back before the end landed): kept", async () => {
    expect(await keepReason(dir, KEY, { claudePid: WINDOW, current: () => KEY })).toMatch(/on it again/);
    expect(await keepReason(dir, KEY, { claudePid: WINDOW, current: () => "conv-now" })).toBeNull();
  });

  test("a NEWER plugin's record that may be on the key (not ours to interpret): kept; a dead one or another key's: not", async () => {
    mkdirSync(join(dir, "procs"), { recursive: true });
    const newer = (pid: number, rec: Record<string, unknown>) => writeFileSync(join(dir, "procs", `${pid}.json`), JSON.stringify({ format: 9, ...rec }));
    newer(aLivePid(), { sessionKey: "conv-other" });
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    newer(gone.pid, { sessionKey: KEY });
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBeNull();
    const p = aLivePid();
    newer(p, { conversation: KEY }); // a shape this build cannot read
    expect(await keepReason(dir, KEY, { claudePid: WINDOW })).toBe(`a newer einweave (pid ${p}) may be on this conversation`);
    expect(existsSync(join(dir, "procs", `${p}.json`)), "never swept").toBe(true);
  });
});

describe("endConversation", () => {
  test("no sign-in in the profile: not_enrolled, nothing sent", async () => {
    expect(await endConversation(createRuntime(), dir, dir, KEY, { claudePid: WINDOW }, "0.0.0")).toBe("not_enrolled");
  });
});

describe("released note", () => {
  const threads = [
    { id: T(1), title: "Fix the build", channel: "general" },
    { id: T(2), title: "Review the PR" },
  ];

  test("after an ended session: why, each thread with its channel, take what is continued", () => {
    const note = releasedNote(threads, 0, false)!;
    expect(note).toContain("this conversation's einweave session ended while it was away (its window closed, or nobody used it for 24 h), so the 2 threads it held were released. Nobody has taken them since:");
    expect(note).toContain(`\n- #general "Fix the build" (${T(1)})`);
    expect(note).toContain(`\n- "Review the PR" (${T(2)})`);
    expect(note).toContain("take(ref) any the user is continuing; leave the rest.");
    expect(note).toContain("Ids are authoritative");
    expect(note).not.toContain("more");
  });

  test("the threads beyond the server's capped list are counted", () => {
    const note = releasedNote(threads, 3, false)!;
    expect(note).toContain("so the 5 threads it held were released");
    expect(note).toContain("\n- …and 3 more (list_threads / take list them)");
  });

  test("after /clear: what the previous conversation did not carry", () => {
    expect(releasedNote(threads.slice(0, 1), 0, true)).toContain("einweave: 1 thread the previous conversation in this window held was not carried here; nobody holds it:");
  });

  test("nothing released: no note", () => {
    expect(releasedNote([], 4, false)).toBeNull();
  });

  test("never longer than 1,500 characters: the rest is counted with the uncapped count", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: T(i), title: "y".repeat(120), channel: "c".repeat(60) }));
    const note = releasedNote(many, 40, false)!;
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
    const listed = note.split("\n").filter((l) => l.startsWith("- #")).length;
    expect(note).toContain(`…and ${60 - listed + 40} more`);
  });
});

describe("told store: once per ended session", () => {
  test("told, then remembered; another session is not", () => {
    expect(wasTold(dir, "grant-1")).toBe(false);
    markTold(dir, "grant-1");
    expect(wasTold(dir, "grant-1")).toBe(true);
    expect(wasTold(dir, "grant-2")).toBe(false);
  });

  test("an expired record of ANOTHER session is swept by the next write", () => {
    markTold(dir, "grant-old");
    const old = (Date.now() - TOLD_TTL_MS - 60_000) / 1000;
    utimesSync(join(dir, "told", "grant-old.json"), old, old);
    markTold(dir, "grant-new");
    expect(existsSync(join(dir, "told", "grant-old.json"))).toBe(false);
  });

  test("a newer plugin's record counts as told and is never swept", () => {
    mkdirSync(join(dir, "told"), { recursive: true });
    const path = join(dir, "told", "grant-n.json");
    writeFileSync(path, JSON.stringify({ format: 9 }));
    const old = (Date.now() - TOLD_TTL_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    expect(wasTold(dir, "grant-n")).toBe(true);
    markTold(dir, "grant-x");
    expect(existsSync(path)).toBe(true);
  });

  test("ids that are not ids never become paths", () => {
    markTold(dir, "../x");
    expect(existsSync(join(dir, "x.json"))).toBe(false);
    expect(wasTold(dir, "../x")).toBe(true);
  });
});

describe("the SessionEnd hook: which exits end a session", () => {
  const HOOK = join(import.meta.dir, "..", "hooks", "session-map.ts");
  const logFile = () => join(dir, "session-end.log");

  async function end(reason: string, sessionId = "conv-exit-1"): Promise<number> {
    const t0 = Date.now();
    const proc = Bun.spawn(["bun", HOOK, "end"], {
      env: { ...(process.env as Record<string, string>), CLAUDE_PLUGIN_DATA: dir, EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SSE_PORT: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, reason }));
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out, "the hook must write nothing to stdout").toBe("");
    return Date.now() - t0;
  }
  async function outcome(ms = 8000): Promise<string> {
    for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(50)) {
      if (existsSync(logFile())) return readFileSync(logFile(), "utf8");
    }
    return "";
  }

  for (const reason of ["prompt_input_exit", "other", "logout"]) {
    test(`${reason}: the hook returns at once and its process ends the session (no sign-in here: not_enrolled)`, async () => {
      const ms = await end(reason);
      // Claude Code kills the hook ~1.4 s in: it must be long gone by then (bun's own start included).
      expect(ms).toBeLessThan(1400);
      expect(await outcome()).toMatch(/ conv-exit-1 not_enrolled\n$/);
    }, 15_000);
  }

  for (const reason of ["clear", "resume"]) {
    test(`${reason}: nothing ends (the window keeps its threads / the running server ends the old conversation itself)`, async () => {
      await end(reason);
      expect(await outcome(2000)).toBe("");
    }, 15_000);
  }

  // Claude Code kills the hook's whole process group/tree ~1.4 s in (measured): the process must not be in it.
  test("the process survives the hook's process group being killed the moment the hook returns", async () => {
    const proc = Bun.spawn(
      ["perl", "-MPOSIX", "-e", 'POSIX::setsid(); system(@ARGV); kill "KILL", -$$', "bun", HOOK, "end"],
      {
        env: { ...(process.env as Record<string, string>), CLAUDE_PLUGIN_DATA: dir, EINWEAVE_STATE_DIR: dir, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SSE_PORT: "" },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    proc.stdin.write(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "conv-killed", reason: "prompt_input_exit" }));
    proc.stdin.end();
    await proc.exited;
    expect(proc.signalCode, "the group kill ran").toBe("SIGKILL");
    expect(await outcome()).toMatch(/ conv-killed not_enrolled\n$/);
  }, 15_000);
});
