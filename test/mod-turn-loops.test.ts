/**
 * RFC-038 D3 — the mod's rule (`mod/turn-loops.ts`) end to end with the server's list (`turn/list.ts`),
 * replaying the event ORDERS measured on Claude Code 2.1.329 (einweave repo,
 * `.claude/plans/2026-11-20-rfc038-step3-measurements.md`). Each step sends what the sender would: the
 * ordered posts queued so far, then a snapshot built at send time.
 */
import { describe, expect, test } from "bun:test";
import { handBackChild, TurnLoops, type ListedAgent, type OrderedPost } from "../mod/turn-loops";
import { TurnList } from "../turn/list";

function rig(list = new TurnList(), epoch = "e1") {
  const queued: OrderedPost[] = [];
  const loops = new TurnLoops((p) => queued.push(p));
  let seq = 0;
  const send = () => {
    for (const p of queued.splice(0)) list.post({ ...p, epoch, seq: ++seq });
    list.post({ ...loops.snapshot(), epoch, seq: ++seq });
  };
  /** Run one event, then send (the sender drains after every event in these tests). */
  const ev = (f: (l: TurnLoops) => void) => {
    f(loops);
    send();
  };
  return {
    loops,
    list,
    ev,
    push: (id: string, thread: string) => list.pushed(id, thread),
    call: (toolUseId: string, ...threads: string[]) => list.toolCall(toolUseId, threads),
    lit: () => list.view().threads,
    state: () => list.view().state,
  };
}

describe("the entry rule (E1–E4, Q1, M4e)", () => {
  test("E1: an idle batch lights from the step of the turn its `next` resolved at", () => {
    const r = rig();
    r.push("p1", "A");
    r.push("p2", "B");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p1"));
    expect(r.lit(), "entered, before step 0").toEqual([]);
    r.ev((l) => l.turnStep(undefined, "T1"));
    expect(r.lit()).toEqual(["A"]);
    r.ev((l) => l.turnComplete(undefined, "T1"));
    expect(r.state()).toBe("idle");
    // p2 was submitted during T1's answer; its `next` resolves at T2's start
    r.ev((l) => l.turnStart(undefined, "T2"));
    r.ev((l) => l.entered("p2"));
    r.ev((l) => l.turnStep(undefined, "T2"));
    expect(r.lit(), "B in T2 only, never T1").toEqual(["B"]);
  });

  test("E2: a push held while a tool runs lights in the SAME turn, from the step that reads it", () => {
    const r = rig();
    r.push("p4", "A");
    r.push("p5", "B");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p4"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.toolCall(undefined, "tu-bash", "Bash", false));
    r.ev((l) => l.toolDone("tu-bash"));
    r.ev((l) => l.entered("p5"));
    expect(r.lit()).toEqual(["A"]);
    r.ev((l) => l.turnStep(undefined, "T1"));
    expect(new Set(r.lit())).toEqual(new Set(["A", "B"]));
  });

  test("E4 (Bash): an entry submitted INSIDE an Esc-aborted turn lights only the next turn", () => {
    const r = rig();
    r.push("p4", "A");
    r.push("p5", "B");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p4"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    // p5 submitted 15 ms before the abort; its `next` resolves at T2's start
    r.ev((l) => l.turnComplete(undefined, "T1"));
    expect(r.lit()).toEqual([]);
    r.ev((l) => l.turnStart(undefined, "T2"));
    r.ev((l) => l.entered("p5"));
    r.ev((l) => l.turnStep(undefined, "T2"));
    expect(r.lit()).toEqual(["B"]);
  });

  test("Q1 / stranded: an entry whose `next` resolved early lights at the step that reads it; an abort with no step after it leaves it for the next turn", () => {
    const r = rig();
    r.push("q", "Q");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.entered("q"));
    expect(r.lit(), "resolved early: not lit before a step").toEqual([]);
    r.ev((l) => l.turnComplete(undefined, "T1")); // aborted: no step followed
    r.ev((l) => l.turnStart(undefined, "T2"));
    expect(r.lit()).toEqual([]);
    r.ev((l) => l.turnStep(undefined, "T2"));
    expect(r.lit()).toEqual(["Q"]);
  });

  test("M4e / M4e4: a blocked prompt joins nothing; an entered one with no turn after it rides the next turn's step", () => {
    const r = rig();
    r.push("p8", "B");
    // p7 blocked: the register never calls entered() for a `{ drop }`
    r.ev((l) => l.entered("p8"));
    expect(r.state()).toBe("idle");
    expect(r.list.view().threads).toEqual([]);
    r.ev((l) => l.turnStart(undefined, "T5"));
    r.ev((l) => l.turnStep(undefined, "T5"));
    expect(r.lit()).toEqual(["B"]);
  });

  test("pending with an open subagent and an idle main lights nothing (rev 8 M1)", () => {
    const r = rig();
    r.push("p1", "A");
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.entered("p1"));
    expect(r.state()).toBe("working");
    expect(r.lit()).toEqual([]);
  });
});

describe("loops (decision 6)", () => {
  test("M4a′: Esc on main leaves a subagent open; its touch keeps the session working on its thread", () => {
    const r = rig();
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "tu1", "mcp__plugin_einweave_einweave__reply", true));
    r.call("tu1", "A");
    r.ev((l) => l.turnComplete(undefined, "T1"));
    expect(r.list.view()).toEqual({ state: "working", threads: ["A"] });
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.list.view()).toEqual({ state: "idle", threads: [] });
  });

  test("M4a″: a loop reopened under the same agentId (new turnId) drops the old turn's touch", () => {
    const r = rig();
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "tu1", "mcp__plugin_einweave_einweave__reply", true));
    r.call("tu1", "A");
    r.ev((l) => l.turnStart("sub", "S2"));
    expect(r.lit()).toEqual([]);
  });

  test("`aborted`, `error`, `refusal`: a turn.complete closes the loop whatever its reason", () => {
    const r = rig();
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.state()).toBe("idle");
  });

  test("a complete for an older turn of the loop closes nothing", () => {
    const r = rig();
    r.ev((l) => l.turnStart("sub", "S2"));
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.state()).toBe("working");
  });

  test("idle_prompt closes the main loop only", () => {
    const r = rig();
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.idlePrompt());
    expect(r.list.view().state).toBe("working");
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.state()).toBe("idle");
  });

  test("needs_you per call across two loops: one loop's call returning does not end another's ask", () => {
    const r = rig();
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "ask1", "AskUserQuestion", false));
    expect(r.state()).toBe("needs_you");
    r.ev((l) => l.toolCall(undefined, "tu2", "Bash", false));
    r.ev((l) => l.toolDone("tu2"));
    expect(r.state(), "main's call returned: the sub still asks").toBe("needs_you");
    r.ev((l) => l.toolDone("ask1"));
    expect(r.state()).toBe("working");
  });

  test("a loop that closes while it asks (TaskStop, Esc) waits on nothing any more", () => {
    const r = rig();
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "ask1", "AskUserQuestion", false));
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.state()).toBe("working");
  });

  test("a dialog waits on the calls in flight when it showed; a later call's return does not end it; an Esc does", () => {
    const r = rig();
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.toolCall(undefined, "tu1", "Bash", false));
    r.ev((l) => l.dialogShown());
    expect(r.state()).toBe("needs_you");
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "tu2", "Read", false));
    r.ev((l) => l.toolDone("tu2"));
    expect(r.state()).toBe("needs_you");
    r.ev((l) => l.turnComplete(undefined, "T1")); // Esc: tu1's tool.done never comes
    expect(r.state(), "the sub works on").toBe("working");
  });

  test("M4f2: a new module instance opens a loop from a step or a tool call it never saw start", () => {
    const list = new TurnList();
    const old = rig(list, "e1");
    old.ev((l) => l.turnStart("sub", "S1"));
    const r = rig(list, "e2");
    r.ev((l) => l.toolCall("sub", "tu1", "mcp__plugin_einweave_einweave__reply", true));
    r.call("tu1", "A");
    r.ev((l) => l.turnStep("sub", "S1"));
    expect(r.list.view()).toEqual({ state: "working", threads: ["A"] });
    r.ev((l) => l.turnComplete("sub", "S1"));
    expect(r.state()).toBe("idle");
  });
});

describe("re-key (M4d)", () => {
  test("/clear and /resume drop main's entries and loop, keep an open subagent's touches", () => {
    const r = rig();
    r.push("p1", "A");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p1"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.turnStart("sub", "S1"));
    r.ev((l) => l.toolCall("sub", "tu1", "mcp__plugin_einweave_einweave__reply", true));
    r.call("tu1", "B");
    r.ev((l) => l.rekey());
    r.list.rekey();
    expect(r.list.view()).toEqual({ state: "working", threads: ["B"] });
  });
});

describe("delegated work (B1)", () => {
  test("spawn → main ends → child works → report → hand-back lights from step 0 → goes at its complete", () => {
    const r = rig();
    r.push("p1", "A");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p1"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.toolCall(undefined, "tu-agent", "Agent", false));
    r.ev((l) => l.spawned("c1", undefined));
    r.ev((l) => l.turnStart("c1", "C1"));
    r.ev((l) => l.toolDone("tu-agent"));
    r.ev((l) => l.turnComplete(undefined, "T1"));
    expect(r.list.view(), "8.6 s → 33.7 s: the child carries A").toEqual({ state: "working", threads: ["A"] });
    r.ev((l) => l.reported("c1", undefined));
    r.ev((l) => l.handBackEntered("c1"));
    r.ev((l) => l.turnComplete("c1", "C1"));
    expect(r.list.view(), "21 ms residual").toEqual({ state: "idle", threads: [] });
    r.ev((l) => l.turnStart(undefined, "T2"));
    r.ev((l) => l.turnStep(undefined, "T2"));
    expect(r.lit()).toEqual(["A"]);
    r.ev((l) => l.turnComplete(undefined, "T2"));
    r.ev((l) => l.turnStart(undefined, "T3"));
    r.ev((l) => l.turnStep(undefined, "T3"));
    expect(r.lit()).toEqual([]);
  });

  test("a hand-back dropped by a hook lights nothing later; a report with no hand-back stays unlit", () => {
    const r = rig();
    r.push("p1", "A");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p1"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.spawned("c1", undefined));
    r.ev((l) => l.turnStart("c1", "C1"));
    r.ev((l) => l.seed([{ id: "c1", status: "running", model: "m" }])); // listed: the server keeps its set
    r.ev((l) => l.turnComplete(undefined, "T1"));
    r.ev((l) => l.reported("c1", undefined));
    r.ev((l) => l.handBackDropped("c1"));
    r.ev((l) => l.turnComplete("c1", "C1"));
    r.ev((l) => l.handBackEntered("c1")); // a stray later prompt naming it
    r.ev((l) => l.turnStart(undefined, "T2"));
    r.ev((l) => l.turnStep(undefined, "T2"));
    expect(r.lit()).toEqual([]);
  });

  test("a pane teammate's spawn lights nothing after the spawning turn ends (it runs no loop here)", () => {
    const r = rig();
    r.push("p1", "A");
    r.ev((l) => l.turnStart(undefined, "T1"));
    r.ev((l) => l.entered("p1"));
    r.ev((l) => l.turnStep(undefined, "T1"));
    r.ev((l) => l.spawned("mate@team", undefined));
    r.ev((l) => l.turnComplete(undefined, "T1"));
    expect(r.list.view()).toEqual({ state: "idle", threads: [] });
  });

  test("a resume spawn while main is idle posts nothing", () => {
    const posts: OrderedPost[] = [];
    const l = new TurnLoops((p) => posts.push(p));
    l.spawned("c1", undefined);
    expect(posts).toEqual([]);
  });
});

describe("seed and reconcile (M3)", () => {
  const listed = (id: string, status: string, model?: string): ListedAgent => ({ id, status, ...(model ? { model } : {}) });

  test("a seed opens running agents with a model; one with no model (a pane teammate) opens nothing", () => {
    const l = new TurnLoops(() => {});
    l.seed([listed("a", "running", "haiku"), listed("mate", "running")]);
    expect(l.snapshot().loops.map((x) => x.agent)).toEqual(["a"]);
    expect(l.snapshot().agents).toEqual(["a", "mate"]);
  });

  test("a seeded loop the list later reports completed (or idle) closes; one that reopened during the read stays; an unlisted one stays", () => {
    const l = new TurnLoops(() => {});
    l.seed([listed("a", "running", "m"), listed("b", "running", "m"), listed("c", "running", "m")]);
    l.turnStart("w", "W1"); // a workflow agent: no list names it
    const marks = l.reconcileMark();
    l.turnStart("b", "B2"); // b reopened while the read ran
    l.reconcile([listed("a", "completed", "m"), listed("b", "idle", "m"), listed("c", "running", "m")], marks);
    expect(l.snapshot().loops.map((x) => x.agent).sort(), "c still running stays").toEqual(["b", "c", "w"]);
  });
});

describe("handBackChild", () => {
  test("reads the leading peer or task tag only", () => {
    expect(handBackChild('<agent-message from="a651aa763db7790e9">\n[Subagent hand-back] …')).toBe("a651aa763db7790e9");
    expect(handBackChild("<task-notification>\n<task-id>a6ffc55d836976440</task-id>\n<tool-use-id>t</tool-use-id>")).toBe("a6ffc55d836976440");
    expect(handBackChild('hello <agent-message from="x">')).toBeNull();
    expect(handBackChild("plain")).toBeNull();
  });
});
