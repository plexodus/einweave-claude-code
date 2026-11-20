/**
 * RFC-038 D3 — the MCP server owns the list of threads this window's turn serves.
 *
 * Pure: no I/O, no clock, no timers. The mod tells it, IN ORDER, which loops are open and which entries
 * each open turn has read (`TurnPost`); the server joins that with what only it knows: which entries THIS
 * process pushed and to which thread (`pushed`), which thread a tool call named (`toolCall`), and when a
 * thread's work left this session (`drop`) or the conversation was re-keyed (`rekey`).
 *
 * The list = over every open loop: the threads of its `inTurn` entries ∪ the threads it touched ∪ its
 * inherited set (a subagent's: the threads of the turn that spawned it). Newest first. Nothing is derived
 * from time: every removal is an event.
 */
import type { LoopName, TurnEntry, TurnLoopView, TurnPost, TurnStateWord } from "../types/turn";

/** Push records kept beyond the ids the latest snapshot names (those are pinned). */
export const PUSHED_KEPT = 1024;
/** Tool joins waiting for their other half. */
export const WAITERS_KEPT = 256;

type TurnRef = { agent: LoopName; turn: string | null };
interface Touch extends TurnRef {
  thread: string;
}
interface Inherit {
  /** Spawning turns still open: the set follows them (a reply made after the spawn counts too). */
  refs: TurnRef[];
  /** Threads of spawning turns that have ended, frozen then. */
  frozen: Set<string>;
  /** The child's loop has been seen open (until then it is not forgotten for lack of a loop). */
  seen: boolean;
}
interface HandBack {
  to: LoopName;
  frozen: Set<string>;
}

export interface TurnListView {
  state: TurnStateWord;
  threads: string[];
}

const turnMatches = (a: string | null, b: string | null) => a === null || b === null || a === b;

export class TurnList {
  private epoch: string | null = null;
  private seq = -1;
  /** The seq of the latest snapshot applied (a late tool join compares against it). */
  private snapSeq = -1;
  /** A new epoch whose first snapshot has not arrived: what it carries over is decided by that snapshot. */
  private epochFresh = false;
  private state: TurnStateWord = "idle";
  private loops = new Map<LoopName, TurnLoopView>();
  /** Pending entries of closed loops (never lit; pinned, and they name hand-backs). */
  private waitingOf = new Map<LoopName, TurnEntry[]>();
  private agents = new Set<string>();

  /** Entry id → thread, for entries THIS process pushed (insertion order = age). */
  private readonly pushedIds = new Map<string, string>();
  /** Pushed ids whose thread's work left, or whose conversation was re-keyed: they light nothing. ⊆ pushedIds. */
  private readonly tombs = new Set<string>();
  private touches: Touch[] = [];
  private readonly toolPosts = new Map<string, TurnRef & { seq: number }>();
  private readonly toolCalls = new Map<string, string[]>();
  private readonly inherited = new Map<string, Inherit>();
  private readonly handbacks = new Map<string, HandBack>();

  /** Recency of each listed thread (higher = newer), so the list is newest first. */
  private readonly order = new Map<string, number>();
  private stamp = 0;

  // ---------------------------------------------------------------- inputs

  /** This process pushed entry `id` (of `thread`) to the model's window. */
  pushed(id: string, thread: string): void {
    this.pushedIds.delete(id);
    this.tombs.delete(id);
    this.pushedIds.set(id, thread);
    this.boundPushed();
  }

  /** One post from the mod, in its sender's order. */
  post(p: TurnPost): void {
    if (p.epoch !== this.epoch) this.newEpoch(p.epoch);
    else if (p.seq <= this.seq) return;
    this.seq = p.seq;
    switch (p.kind) {
      case "snapshot":
        return this.snapshot(p);
      case "tool": {
        const ref = { agent: p.agent, turn: p.turn, seq: p.seq };
        const threads = this.toolCalls.get(p.toolUseId);
        if (threads) {
          this.toolCalls.delete(p.toolUseId);
          this.touch(ref, threads);
        } else this.wait(this.toolPosts, p.toolUseId, ref);
        return;
      }
      case "spawn": {
        // A spawn (or a resume) adds the spawning turn; it never replaces what the child had. A turn that is
        // not open (a resume while its loop is idle) freezes to nothing at the next snapshot.
        const inh = this.inheritOf(p.agent);
        if (!inh.refs.some((r) => r.agent === p.from.agent && r.turn === p.from.turn)) inh.refs.push({ ...p.from });
        return;
      }
      case "report":
        // Frozen NOW: the child's touches go at its own turn.complete, which comes after its report.
        this.handbacks.set(p.agent, { to: p.to, frozen: this.agentThreads(p.agent) });
        return;
    }
  }

  /**
   * A tool call of this window's model named these threads (after the tool resolved them). `toolUseId` is
   * Claude Code's `_meta["claudecode/toolUseId"]`; the mod's tool post says which loop's turn made it.
   */
  toolCall(toolUseId: string, threads: string[]): void {
    if (threads.length === 0) return;
    const ref = this.toolPosts.get(toolUseId);
    if (ref) {
      this.toolPosts.delete(toolUseId);
      this.touch(ref, threads);
    } else this.wait(this.toolCalls, toolUseId, [...threads]);
  }

  /** The thread's work left this session (release, handover, a hold moved away): its evidence goes. */
  drop(thread: string): void {
    this.touches = this.touches.filter((t) => t.thread !== thread);
    for (const [id, t] of this.pushedIds) if (t === thread) this.tombs.add(id);
    for (const inh of this.inherited.values()) inh.frozen.delete(thread);
    for (const hb of this.handbacks.values()) hb.frozen.delete(thread);
    for (const [id, threads] of this.toolCalls) {
      const rest = threads.filter((t) => t !== thread);
      if (rest.length) this.toolCalls.set(id, rest);
      else this.toolCalls.delete(id);
    }
  }

  /**
   * The conversation was re-keyed (`/clear`, `/resume`, `/branch`): the MAIN loop's evidence goes, the
   * subagent loops' stays (they keep working and hand back into the new conversation). Whether or not the
   * mod saw it: a snapshot that still names main's old entries lights nothing.
   */
  rekey(): void {
    const main = this.loops.get("main");
    const waitingMain = this.waitingOf.get("main") ?? [];
    for (const e of [...(main?.inTurn ?? []), ...(main?.pending ?? []), ...waitingMain]) {
      if ("id" in e) {
        if (this.pushedIds.has(e.id)) this.tombs.add(e.id);
      } else this.handbacks.delete(e.agent);
    }
    this.touches = this.touches.filter((t) => t.agent !== "main");
    for (const [id, ref] of this.toolPosts) if (ref.agent === "main") this.toolPosts.delete(id);
  }

  // ---------------------------------------------------------------- output

  /** The state and the threads to report, newest first (the SDK keeps the first 32). */
  view(): TurnListView {
    const now = new Set<string>();
    if (this.state !== "idle") for (const loop of this.loops.values()) for (const t of this.turnThreads(loop, new Set())) now.add(t);
    for (const t of [...this.order.keys()]) if (!now.has(t)) this.order.delete(t);
    for (const t of now) if (!this.order.has(t)) this.order.set(t, ++this.stamp);
    const threads = [...now].sort((a, b) => this.order.get(b)! - this.order.get(a)!);
    return { state: this.state, threads };
  }

  // ---------------------------------------------------------------- internals

  private newEpoch(epoch: string): void {
    this.epoch = epoch;
    this.seq = -1;
    this.snapSeq = -1;
    this.epochFresh = true;
    this.toolPosts.clear();
    this.toolCalls.clear();
  }

  private snapshot(p: Extract<TurnPost, { kind: "snapshot" }>): void {
    const next = new Map<LoopName, TurnLoopView>();
    for (const l of p.loops) next.set(l.agent, l);
    const openIn = (ref: TurnRef, loops: Map<LoopName, TurnLoopView>) => {
      const l = loops.get(ref.agent);
      return !!l && turnMatches(l.turn, ref.turn);
    };

    if (this.epochFresh) {
      // A reload must not blank a subagent still working, nor lose the set of one that may yet resume.
      this.epochFresh = false;
      this.touches = this.touches.filter((t) => t.agent !== "main" && next.has(t.agent));
      const listed = new Set(p.agents);
      for (const k of [...this.inherited.keys()]) if (!listed.has(k) && !next.has(k)) this.inherited.delete(k);
      for (const k of [...this.handbacks.keys()]) if (!listed.has(k)) this.handbacks.delete(k);
    }

    // A spawning turn that ends here freezes its threads into the child's set, read BEFORE the turn's own
    // evidence goes.
    for (const inh of this.inherited.values()) {
      inh.refs = inh.refs.filter((ref) => {
        if (openIn(ref, next)) return true;
        for (const t of this.turnThreads(ref, new Set())) inh.frozen.add(t);
        return false;
      });
    }

    // A loop seeded with `turn: null` is named by its next event: its unnamed touches bind to that turn.
    for (const t of this.touches) if (t.turn === null) t.turn = next.get(t.agent)?.turn ?? null;
    for (const inh of this.inherited.values()) for (const r of inh.refs) if (r.turn === null) r.turn = next.get(r.agent)?.turn ?? null;
    // A touch goes with a snapshot in which its turn is closed. Only a newer snapshot gets here (seq), and the
    // mod builds each snapshot when it sends it, so none is older than a touch it carries.
    this.touches = this.touches.filter((t) => openIn(t, next));

    this.loops = next;
    this.waitingOf = new Map(p.waiting.map((w) => [w.agent, w.pending]));
    this.state = p.state;
    this.agents = new Set(p.agents);
    this.snapSeq = p.seq;
    for (const l of next.keys()) {
      const inh = this.inherited.get(l);
      if (inh) inh.seen = true;
    }
    if (p.state === "idle") {
      this.toolPosts.clear();
      this.toolCalls.clear();
    }
    this.forget();
    this.boundPushed();
  }

  private touch(ref: TurnRef & { seq: number }, threads: string[]): void {
    // A late join whose turn a newer snapshot already closed adds nothing.
    if (ref.seq < this.snapSeq && !this.isOpen(ref)) return;
    for (const thread of threads) {
      if (!this.touches.some((t) => t.thread === thread && t.agent === ref.agent && t.turn === ref.turn)) {
        this.touches.push({ agent: ref.agent, turn: ref.turn, thread });
      }
    }
  }

  private wait<V>(m: Map<string, V>, id: string, v: V): void {
    m.set(id, v);
    while (m.size > WAITERS_KEPT) m.delete(m.keys().next().value!);
  }

  private isOpen(ref: TurnRef): boolean {
    const l = this.loops.get(ref.agent);
    return !!l && turnMatches(l.turn, ref.turn);
  }

  private inheritOf(child: string): Inherit {
    let inh = this.inherited.get(child);
    if (!inh) this.inherited.set(child, (inh = { refs: [], frozen: new Set(), seen: this.loops.has(child) }));
    return inh;
  }

  /** The threads of one loop's turn: its read entries, its touches, its inherited set. */
  private turnThreads(ref: TurnRef, visiting: Set<string>): Set<string> {
    const out = new Set<string>();
    const loop = this.loops.get(ref.agent);
    if (loop && turnMatches(loop.turn, ref.turn)) for (const e of loop.inTurn) for (const t of this.entryThreads(e)) out.add(t);
    for (const t of this.touches) if (t.agent === ref.agent && turnMatches(t.turn, ref.turn)) out.add(t.thread);
    for (const t of this.inheritedThreads(ref.agent, visiting)) out.add(t);
    return out;
  }

  private entryThreads(e: TurnEntry): Iterable<string> {
    if ("id" in e) {
      const t = this.pushedIds.get(e.id);
      return t === undefined || this.tombs.has(e.id) ? [] : [t];
    }
    return this.handbacks.get(e.agent)?.frozen ?? [];
  }

  private inheritedThreads(agent: string, visiting: Set<string>): Set<string> {
    const out = new Set<string>();
    const inh = this.inherited.get(agent);
    if (!inh || visiting.has(agent)) return out;
    visiting.add(agent);
    for (const t of inh.frozen) out.add(t);
    for (const r of inh.refs) for (const t of this.turnThreads(r, visiting)) out.add(t);
    return out;
  }

  /** Everything a child's work is for, at its report: its inherited set and every thread it touched. */
  private agentThreads(agent: string): Set<string> {
    const out = this.inheritedThreads(agent, new Set());
    for (const t of this.touches) if (t.agent === agent) out.add(t.thread);
    return out;
  }

  /**
   * An agent's inherited set and armed hand-back go once nothing names it (no open loop, no hand-back armed
   * TO it, no entry) and it is not listed: listed-then-gone, or never listed (a workflow agent) with its
   * loop closed. A set whose child has not been seen open yet is kept (the spawn precedes the child's loop).
   */
  private forget(): void {
    const named = new Set<string>(this.loops.keys());
    for (const hb of this.handbacks.values()) named.add(hb.to);
    for (const e of this.entries()) if ("agent" in e) named.add(e.agent);
    const gone = (k: string) => !named.has(k) && !this.agents.has(k);
    for (const [k, inh] of this.inherited) if (inh.seen && gone(k)) this.inherited.delete(k);
    for (const k of [...this.handbacks.keys()]) if (gone(k) && !this.inherited.has(k)) this.handbacks.delete(k);
  }

  /** Every entry the latest snapshot names: open loops' read and pending ones, closed loops' waiting ones. */
  private *entries(): Iterable<TurnEntry> {
    for (const l of this.loops.values()) yield* [...l.inTurn, ...l.pending];
    for (const w of this.waitingOf.values()) yield* w;
  }

  private boundPushed(): void {
    if (this.pushedIds.size <= PUSHED_KEPT) return;
    const pinned = new Set<string>();
    for (const e of this.entries()) if ("id" in e) pinned.add(e.id);
    for (const id of this.pushedIds.keys()) {
      if (this.pushedIds.size <= PUSHED_KEPT) break;
      if (pinned.has(id)) continue;
      this.pushedIds.delete(id);
      this.tombs.delete(id);
    }
  }
}
