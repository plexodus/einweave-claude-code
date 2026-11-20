/**
 * RFC-038 D3 — the server's turn list (`turn/list.ts`), driven by the post orders the mod sends.
 * Each test names the RFC rule it pins.
 */
import { describe, expect, test } from "bun:test";
import { PUSHED_KEPT, TurnList } from "../turn/list";
import type { TurnEntry, TurnLoopView, TurnPost, TurnStateWord } from "../types/turn";

const id = (x: string): TurnEntry => ({ id: x });
const hb = (agent: string): TurnEntry => ({ agent });
const loop = (agent: string, turn: string | null, inTurn: TurnEntry[] = [], pending: TurnEntry[] = []): TurnLoopView => ({ agent, turn, inTurn, pending });

/** A mod: one epoch, a seq counter, post helpers. */
function mod(list: TurnList, epoch = "e1") {
  let seq = 0;
  return {
    snap: (loops: TurnLoopView[], state: TurnStateWord = loops.length ? "working" : "idle", agents: string[] = []) =>
      list.post({ kind: "snapshot", epoch, seq: ++seq, state, loops, waiting: [], agents }),
    tool: (toolUseId: string, agent = "main", turn: string | null = "T1") => list.post({ kind: "tool", epoch, seq: ++seq, toolUseId, agent, turn }),
    spawn: (agent: string, from: { agent: string; turn: string | null }) => list.post({ kind: "spawn", epoch, seq: ++seq, agent, from }),
    report: (agent: string, to = "main") => list.post({ kind: "report", epoch, seq: ++seq, agent, to }),
    raw: (p: Omit<TurnPost, "epoch">) => list.post({ ...p, epoch } as TurnPost),
    get seq() {
      return seq;
    },
  };
}

const threads = (l: TurnList) => l.view().threads;

describe("entries", () => {
  test("an entry lights from inTurn only; pending pins it but lights nothing", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [], [id("m1")])]);
    expect(threads(l)).toEqual([]);
    m.snap([loop("main", "T1", [id("m1")])]);
    expect(threads(l)).toEqual(["A"]);
    m.snap([]);
    expect(l.view()).toEqual({ state: "idle", threads: [] });
  });

  test("an id this process did not push lights nothing (a typed or quoted tag)", () => {
    const l = new TurnList();
    mod(l).snap([loop("main", "T1", [id("forged")])]);
    expect(threads(l)).toEqual([]);
  });

  test("pending with an open subagent and an idle main lights nothing (rev 8 M1)", () => {
    const l = new TurnList();
    l.pushed("m1", "A");
    mod(l).snap([loop("main", null, [], [id("m1")]), loop("sub", "S1")]);
    expect(threads(l)).toEqual([]);
  });

  test("a pinned id survives the bound; an unpinned old one does not", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("old", "A");
    l.pushed("pin", "B");
    m.snap([loop("main", "T1", [], [id("pin")])]);
    for (let i = 0; i < PUSHED_KEPT; i++) l.pushed(`x${i}`, "X");
    m.snap([loop("main", "T1", [id("pin"), id("old")])]);
    expect(threads(l)).toEqual(["B"]);
  });

  test("newest first", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    l.pushed("m2", "B");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.snap([loop("main", "T1", [id("m1"), id("m2")])]);
    expect(threads(l)).toEqual(["B", "A"]);
  });
});

describe("tool touches", () => {
  test("the join works in either arrival order", () => {
    for (const callFirst of [true, false]) {
      const l = new TurnList();
      const m = mod(l);
      m.snap([loop("main", "T1")]);
      if (callFirst) l.toolCall("tu1", ["A"]);
      m.tool("tu1");
      if (!callFirst) l.toolCall("tu1", ["A"]);
      expect(threads(l), `call first: ${callFirst}`).toEqual(["A"]);
    }
  });

  test("a touch survives a late snapshot and goes with a newer one closing its turn (review M3)", () => {
    const l = new TurnList();
    l.post({ kind: "snapshot", epoch: "e1", seq: 1, state: "working", loops: [loop("main", "T1")], waiting: [], agents: [] });
    l.post({ kind: "tool", epoch: "e1", seq: 3, toolUseId: "tu1", agent: "main", turn: "T1" });
    l.toolCall("tu1", ["A"]);
    l.post({ kind: "snapshot", epoch: "e1", seq: 2, state: "idle", loops: [], waiting: [], agents: [] });
    expect(threads(l), "an older snapshot never saw the touch").toEqual(["A"]);
    l.post({ kind: "snapshot", epoch: "e1", seq: 4, state: "working", loops: [loop("main", "T1")], waiting: [], agents: [] });
    expect(threads(l), "still open").toEqual(["A"]);
    l.post({ kind: "snapshot", epoch: "e1", seq: 5, state: "working", loops: [loop("main", "T2")], waiting: [], agents: [] });
    expect(threads(l), "T1 closed by a newer snapshot").toEqual([]);
  });

  test("a late join whose turn a newer snapshot already closed adds nothing, not even to a later seeded loop", () => {
    const l = new TurnList();
    const m = mod(l);
    m.snap([loop("sub", "S1")], "working", ["sub"]);
    m.tool("tu1", "sub", "S1");
    m.snap([loop("sub", "S2")], "working", ["sub"]);
    l.toolCall("tu1", ["A"]);
    expect(threads(l)).toEqual([]);
    // a reload seeds the loop with `turn: null`, which matches any turn of its agent
    l.post({ kind: "snapshot", epoch: "e2", seq: 1, state: "working", loops: [loop("sub", null)], waiting: [], agents: ["sub"] });
    expect(threads(l)).toEqual([]);
  });

  test("a loop reopened under the same agentId (new turnId) drops the old turn's touch", () => {
    const l = new TurnList();
    const m = mod(l);
    m.snap([loop("sub", "S1")]);
    m.tool("tu1", "sub", "S1");
    l.toolCall("tu1", ["A"]);
    expect(threads(l)).toEqual(["A"]);
    m.snap([loop("sub", "S2")]);
    expect(threads(l)).toEqual([]);
  });

  test("a `turn: null` touch binds at the loop's next event and goes at that turn's complete (review M4)", () => {
    const l = new TurnList();
    const m = mod(l);
    m.snap([loop("sub", null)]);
    m.tool("tu1", "sub", null);
    l.toolCall("tu1", ["A"]);
    m.snap([loop("sub", "S1")]);
    expect(threads(l)).toEqual(["A"]);
    m.snap([loop("sub", "S2")]);
    expect(threads(l)).toEqual([]);
  });

  test("a waiting call ends at an idle snapshot", () => {
    const l = new TurnList();
    const m = mod(l);
    m.snap([loop("main", "T1")]);
    l.toolCall("tu1", ["A"]);
    m.snap([]);
    m.snap([loop("main", "T2")]);
    m.tool("tu1", "main", "T2");
    expect(threads(l)).toEqual([]);
  });
});

describe("epochs", () => {
  test("out-of-order posts keep the highest seq", () => {
    const l = new TurnList();
    l.pushed("m1", "A");
    l.post({ kind: "snapshot", epoch: "e1", seq: 5, state: "working", loops: [loop("main", "T1", [id("m1")])], waiting: [], agents: [] });
    l.post({ kind: "snapshot", epoch: "e1", seq: 4, state: "idle", loops: [], waiting: [], agents: [] });
    expect(threads(l)).toEqual(["A"]);
  });

  test("a new epoch after a high seq is accepted, replaces main, keeps a listed open subagent's touches", () => {
    const l = new TurnList();
    l.pushed("m1", "A");
    l.post({ kind: "snapshot", epoch: "e1", seq: 99, state: "working", loops: [loop("main", "T1", [id("m1")]), loop("sub", "S1")], waiting: [], agents: ["sub"] });
    l.post({ kind: "tool", epoch: "e1", seq: 100, toolUseId: "tu1", agent: "main", turn: "T1" });
    l.toolCall("tu1", ["M"]);
    l.post({ kind: "tool", epoch: "e1", seq: 101, toolUseId: "tu2", agent: "sub", turn: "S1" });
    l.toolCall("tu2", ["B"]);
    expect(new Set(threads(l))).toEqual(new Set(["A", "M", "B"]));
    // reload: the new instance never saw main's entries; it seeds the subagent with turn null
    l.post({ kind: "snapshot", epoch: "e2", seq: 1, state: "working", loops: [loop("sub", null)], waiting: [], agents: ["sub"] });
    expect(threads(l)).toEqual(["B"]);
    // the loop's next event names its turn: same turn, still lit
    l.post({ kind: "snapshot", epoch: "e2", seq: 2, state: "working", loops: [loop("sub", "S1")], waiting: [], agents: ["sub"] });
    expect(threads(l)).toEqual(["B"]);
  });

  test("a new epoch drops main's touches even when main's same turn is open in it (its entries are lost too)", () => {
    const l = new TurnList();
    l.post({ kind: "snapshot", epoch: "e1", seq: 1, state: "working", loops: [loop("main", "T1")], waiting: [], agents: [] });
    l.post({ kind: "tool", epoch: "e1", seq: 2, toolUseId: "tu1", agent: "main", turn: "T1" });
    l.toolCall("tu1", ["M"]);
    l.post({ kind: "snapshot", epoch: "e2", seq: 1, state: "working", loops: [loop("main", "T1")], waiting: [], agents: [] });
    expect(threads(l)).toEqual([]);
  });
});

describe("work moved away", () => {
  test("release deletes touches and tombstones entries; a background loop's old touch does not bring it back; a new entry does", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")]), loop("sub", "S1")]);
    m.tool("tu1", "sub", "S1");
    l.toolCall("tu1", ["A"]);
    l.drop("A");
    m.snap([loop("main", "T1", [id("m1")]), loop("sub", "S1")]);
    expect(threads(l)).toEqual([]);
    l.pushed("m2", "A");
    m.snap([loop("main", "T1", [id("m1"), id("m2")]), loop("sub", "S1")]);
    expect(threads(l)).toEqual(["A"]);
  });
});

describe("re-key", () => {
  for (const order of ["mod first", "server first"] as const) {
    test(`keeps an open subagent's touches, drops main's (${order})`, () => {
      const l = new TurnList();
      const m = mod(l);
      l.pushed("m1", "A");
      m.snap([loop("main", "T1", [id("m1")]), loop("sub", "S1")]);
      m.tool("tu1", "main", "T1");
      l.toolCall("tu1", ["M"]);
      m.tool("tu2", "sub", "S1");
      l.toolCall("tu2", ["B"]);
      if (order === "mod first") {
        m.snap([loop("sub", "S1")]);
        l.rekey();
      } else {
        l.rekey();
        m.snap([loop("sub", "S1")]);
      }
      expect(threads(l)).toEqual(["B"]);
    });
  }

  test("a re-key the mod never saw (`/branch`) leaves main's old entries tombstoned", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])]);
    l.rekey();
    m.snap([loop("main", "T1", [id("m1")])]);
    expect(threads(l)).toEqual([]);
  });
});

describe("delegated work (B1)", () => {
  test("a spawn inside an einweave turn lights the thread while the child works after main's end; the hand-back lights it from step 0 and it goes at that turn's complete", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])], "working", []);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("main", "T1", [id("m1")]), loop("c1", "C1")], "working", ["c1"]);
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    expect(threads(l), "main ended, the child carries A").toEqual(["A"]);
    m.report("c1");
    m.snap([loop("main", null, [], [hb("c1")])], "working", ["c1"]);
    expect(threads(l), "armed, pending: not lit (21 ms residual)").toEqual([]);
    m.snap([loop("main", "T2", [hb("c1")])], "working", ["c1"]);
    expect(threads(l), "hand-back turn, step 0").toEqual(["A"]);
    m.snap([], "idle", ["c1"]);
    m.snap([loop("main", "T3")], "working", ["c1"]);
    expect(threads(l), "gone with that turn").toEqual([]);
  });

  test("a reply made after the spawn in the spawning turn is inherited; a child's own touch lights in the hand-back turn", () => {
    const l = new TurnList();
    const m = mod(l);
    m.snap([loop("main", "T1")]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.tool("tu1", "main", "T1");
    l.toolCall("tu1", ["A"]);
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    expect(threads(l)).toEqual(["A"]);
    m.tool("tu2", "c1", "C1");
    l.toolCall("tu2", ["B"]);
    m.report("c1");
    m.snap([loop("main", "T2", [hb("c1")])], "working", ["c1"]);
    expect(new Set(threads(l))).toEqual(new Set(["A", "B"]));
  });

  test("a nested spawn inherits from its parent loop's turn", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("main", "T1", [id("m1")]), loop("c1", "C1")], "working", ["c1"]);
    m.spawn("g1", { agent: "c1", turn: "C1" });
    m.snap([loop("g1", "G1")], "working", ["c1", "g1"]);
    expect(threads(l)).toEqual(["A"]);
  });

  test("a child reopened under its id still counts its inherited set", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    m.snap([], "idle", ["c1"]);
    m.snap([loop("c1", "C2")], "working", ["c1"]);
    expect(threads(l)).toEqual(["A"]);
  });

  test("a resume spawn while main is idle adds nothing; inside an unrelated turn it adds that turn without replacing", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    l.pushed("m2", "B");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    m.snap([], "idle", ["c1"]);
    m.spawn("c1", { agent: "main", turn: "T9" });
    m.snap([loop("c1", "C2")], "working", ["c1"]);
    expect(threads(l), "idle main: nothing added").toEqual(["A"]);
    m.snap([loop("main", "T2", [id("m2")])], "working", ["c1"]);
    m.spawn("c1", { agent: "main", turn: "T2" });
    m.snap([loop("main", "T2", [id("m2")]), loop("c1", "C3")], "working", ["c1"]);
    m.snap([loop("c1", "C3")], "working", ["c1"]);
    expect(new Set(threads(l))).toEqual(new Set(["A", "B"]));
  });

  test("release of a thread a live child inherited stops it showing, and its hand-back does not bring it back", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    l.drop("A");
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    expect(threads(l)).toEqual([]);
    m.report("c1");
    m.snap([loop("main", "T2", [hb("c1")])], "working", ["c1"]);
    expect(threads(l)).toEqual([]);
  });

  test("the server forgets a listed agent's set once it leaves the list, and a never-listed agent's once its loop closes", () => {
    for (const listed of [true, false]) {
      const l = new TurnList();
      const m = mod(l);
      l.pushed("m1", "A");
      const agents = listed ? ["c1"] : [];
      m.snap([loop("main", "T1", [id("m1")])], "working", agents);
      m.spawn("c1", { agent: "main", turn: "T1" });
      m.snap([loop("c1", "C1")], "working", agents);
      m.snap([], "idle", agents);
      m.snap([], "idle", []);
      // the same id reopening later has no set left
      m.snap([loop("c1", "C9")], "working", []);
      expect(threads(l), `listed: ${listed}`).toEqual([]);
    }
  });

  test("a spawn whose child has not been seen yet is not forgotten for lack of a loop", () => {
    const l = new TurnList();
    const m = mod(l);
    l.pushed("m1", "A");
    m.snap([loop("main", "T1", [id("m1")])]);
    m.spawn("c1", { agent: "main", turn: "T1" });
    m.snap([loop("main", "T1", [id("m1")])]); // child's loop not open yet, not listed yet
    m.snap([loop("c1", "C1")], "working", ["c1"]);
    expect(threads(l)).toEqual(["A"]);
  });
});

describe("waiting entries (closed loops)", () => {
  test("an entered hand-back of a never-listed child, waiting while main is idle, is not forgotten and lights the hand-back turn", () => {
    const l = new TurnList();
    l.pushed("m1", "A");
    const snap = (seq: number, loops: TurnLoopView[], waiting: { agent: string; pending: TurnEntry[] }[] = []) =>
      l.post({ kind: "snapshot", epoch: "e1", seq, state: loops.length ? "working" : "idle", loops, waiting, agents: [] });
    snap(1, [loop("main", "T1", [id("m1")])]);
    l.post({ kind: "spawn", epoch: "e1", seq: 2, agent: "w1", from: { agent: "main", turn: "T1" } });
    snap(3, [loop("w1", "W1")]);
    l.post({ kind: "report", epoch: "e1", seq: 4, agent: "w1", to: "main" });
    snap(5, [], [{ agent: "main", pending: [hb("w1")] }]);
    expect(threads(l)).toEqual([]);
    snap(6, [loop("main", "T2", [hb("w1")])]);
    expect(threads(l)).toEqual(["A"]);
  });

  test("a waiting id is pinned, and a re-key tombstones main's waiting ids", () => {
    const l = new TurnList();
    l.pushed("w", "W");
    l.post({ kind: "snapshot", epoch: "e1", seq: 1, state: "idle", loops: [], waiting: [{ agent: "main", pending: [id("w")] }], agents: [] });
    for (let i = 0; i < PUSHED_KEPT; i++) l.pushed(`x${i}`, "X");
    l.post({ kind: "snapshot", epoch: "e1", seq: 2, state: "working", loops: [loop("main", "T1", [id("w")])], waiting: [], agents: [] });
    expect(threads(l), "pinned while waiting").toEqual(["W"]);
    l.post({ kind: "snapshot", epoch: "e1", seq: 3, state: "idle", loops: [], waiting: [{ agent: "main", pending: [id("w")] }], agents: [] });
    l.rekey();
    l.post({ kind: "snapshot", epoch: "e1", seq: 4, state: "working", loops: [loop("main", "T2", [id("w")])], waiting: [], agents: [] });
    expect(threads(l), "tombstoned by the re-key").toEqual([]);
  });
});
