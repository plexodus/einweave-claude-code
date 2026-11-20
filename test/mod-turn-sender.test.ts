/** RFC-038 D3 — the mod's one ordered sender (`mod/turn-sender.ts`). */
import { expect, test } from "bun:test";
import { TurnSender } from "../mod/turn-sender";
import type { SnapshotBody } from "../mod/turn-loops";
import type { TurnPost } from "../types/turn";

const settle = () => new Promise((r) => setTimeout(r, 0));

function rig() {
  let state: SnapshotBody["state"] = "idle";
  const sent: TurnPost[] = [];
  let gate: (() => void) | null = null;
  let fail = false;
  const s = new TurnSender(
    "e1",
    () => ({ kind: "snapshot", state, loops: [], waiting: [], agents: [] }),
    async (p) => {
      if (gate === null) await new Promise<void>((r) => (gate = r));
      sent.push(p);
      return !fail;
    },
  );
  s.release();
  return {
    s,
    sent,
    set: (v: SnapshotBody["state"]) => (state = v),
    /** Let the post in flight finish (and every later one, until the next hold()). */
    open: () => {
      const g = gate;
      gate = () => {};
      g?.();
    },
    hold: () => (gate = null),
    failing: (v: boolean) => (fail = v),
  };
}

test("one post in flight; snapshots coalesce and are built when SENT; ordered posts keep their place", async () => {
  const r = rig();
  await settle(); // release() drained an empty queue
  r.set("working");
  r.s.changed(); // in flight, held
  r.s.changed();
  r.s.ordered({ kind: "spawn", agent: "c1", from: { agent: "main", turn: "T1" } });
  r.s.changed();
  r.s.changed();
  r.set("idle");
  expect(r.s.waiting, "in-flight snapshot + one snapshot + spawn + one snapshot").toBe(4);
  r.open();
  await settle();
  expect(r.sent.map((p) => p.kind)).toEqual(["snapshot", "snapshot", "spawn", "snapshot"]);
  expect(r.sent.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
  expect(r.sent.every((p) => p.epoch === "e1")).toBe(true);
  expect((r.sent[1] as Extract<TurnPost, { kind: "snapshot" }>).state, "built at send: the latest state").toBe("idle");
});

test("a failed post stays at the head and goes again at the next event, with a new seq", async () => {
  const r = rig();
  r.open();
  r.failing(true);
  r.s.ordered({ kind: "tool", toolUseId: "tu1", agent: "main", turn: "T1" });
  await settle();
  expect(r.s.waiting).toBe(1);
  r.failing(false);
  r.s.changed();
  await settle();
  expect(r.sent.map((p) => [p.kind, p.seq])).toEqual([
    ["tool", 1],
    ["tool", 2],
    ["snapshot", 3],
  ]);
  expect(r.s.waiting).toBe(0);
});

test("resend() sends a snapshot even with nothing changed (a restarted server)", async () => {
  const r = rig();
  r.open();
  r.s.resend();
  await settle();
  expect(r.sent.map((p) => p.kind)).toEqual(["snapshot"]);
});

test("a post that throws counts as failed, never wedges the sender", async () => {
  let n = 0;
  const sent: string[] = [];
  const s = new TurnSender("e1", () => ({ kind: "snapshot", state: "idle", loops: [], waiting: [], agents: [] }), async (p) => {
    if (n++ === 0) throw new Error("socket gone");
    sent.push(p.kind);
    return true;
  });
  s.release();
  s.changed();
  await settle();
  s.changed();
  await settle();
  expect(sent).toEqual(["snapshot"]);
  expect(s.waiting).toBe(0);
});

test("a change queued after the drain's last look (before it hands back) is still sent", async () => {
  for (let depth = 0; depth < 6; depth++) {
    const sent: string[] = [];
    let s!: TurnSender;
    let first = true;
    s = new TurnSender("e1", () => ({ kind: "snapshot", state: "idle", loops: [], waiting: [], agents: [] }), async (p) => {
      sent.push(p.kind);
      if (first) {
        first = false;
        let f = () => s.changed();
        for (let i = 0; i < depth; i++) {
          const g = f;
          f = () => queueMicrotask(g);
        }
        queueMicrotask(f);
      }
      return true;
    });
    s.release();
    s.changed();
    await settle();
    expect(sent.length, `depth ${depth}`).toBe(2);
    expect(s.waiting).toBe(0);
  }
});

test("nothing goes before release(); then the queue goes in order; a failure shows as stalled until it goes", async () => {
  const sent: string[] = [];
  let ok = false;
  const s = new TurnSender("e1", () => ({ kind: "snapshot", state: "idle", loops: [], waiting: [], agents: [] }), async (p) => {
    sent.push(p.kind);
    return ok;
  });
  s.ordered({ kind: "tool", toolUseId: "tu1", agent: "main", turn: null });
  s.changed();
  await settle();
  expect(sent).toEqual([]);
  s.release();
  await settle();
  expect(sent).toEqual(["tool"]);
  expect(s.stalled).toBe(true);
  ok = true;
  s.resend();
  await settle();
  expect(sent).toEqual(["tool", "tool", "snapshot"]);
  expect(s.stalled).toBe(false);
});
