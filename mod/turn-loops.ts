/**
 * RFC-038 D3 — the mod's rule: which loops of this window are working, and which entries each open turn has
 * read. Pure: the register feeds it Claude Code's events IN ORDER and sends what it says (`turn-sender`).
 *
 * A loop is main or a subagent (`agentId`). Each has `pending` (entries that entered, waiting for the loop's
 * next model request) and, while open, `inTurn` (entries its turn's requests carried). An entry is an
 * einweave entry id or a subagent's hand-back:
 *   - an entry joins `pending` only once its prompt ENTERED (`prompt.submit`'s `next` resolved without
 *     `drop`); a blocked prompt joins nothing.
 *   - a loop's `turn.step` (its next model request) moves `pending` into `inTurn`: an entry lights from the
 *     first request that carries it, never earlier, never a turn early.
 *   - a loop's `turn.complete` closes it; `pending` is kept (an entry submitted inside an aborted turn
 *     belongs to the next one).
 * Measured on Claude Code 2.1.329: `.claude/plans/2026-11-20-rfc038-step3-measurements.md` (einweave repo).
 */
import type { LoopName, TurnEntry, TurnLoopView, TurnPost, TurnStateWord } from '../types/turn'

/** Tools that run until the person answers: while one runs, the window waits on its person. */
export const WAITS_ON_PERSON: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** `$.agent.list()` statuses that mean the agent's loop has no open turn (never `taskStatus`). */
const NOT_RUNNING: ReadonlySet<string> = new Set(['idle', 'completed', 'failed', 'killed'])

/** The fields of `$.agent.list()` this rule reads. */
export interface ListedAgent {
  id: string
  status: string
  model?: string
}

/** A post the sender keeps in order (a snapshot is built at send time instead: `snapshot()`). */
export type OrderedPost =
  | Omit<Extract<TurnPost, { kind: 'tool' }>, 'epoch' | 'seq'>
  | Omit<Extract<TurnPost, { kind: 'spawn' }>, 'epoch' | 'seq'>
  | Omit<Extract<TurnPost, { kind: 'report' }>, 'epoch' | 'seq'>

export type SnapshotBody = Omit<Extract<TurnPost, { kind: 'snapshot' }>, 'epoch' | 'seq'>

const MAIN = 'main'
const loopOf = (agentId: string | undefined): LoopName => agentId ?? MAIN

/**
 * The subagent a hand-back prompt names: `<agent-message from="<id>">` (origin `peer`) or
 * `<task-notification><task-id><id></task-id>` (origin `task-notification`). The LEADING tag only.
 */
export function handBackChild(text: string): string | null {
  const peer = /^\s*<agent-message from="([A-Za-z0-9_-]{1,64})"/.exec(text)
  if (peer) return peer[1] ?? null
  const task = /^\s*<task-notification>\s*<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/.exec(text)
  return task?.[1] ?? null
}

interface OpenLoop {
  turn: string | null
  inTurn: TurnEntry[]
}

export class TurnLoops {
  private readonly open = new Map<LoopName, OpenLoop>()
  private readonly pending = new Map<LoopName, TurnEntry[]>()
  /** Asking tool calls (AskUserQuestion, plan approval) open, by toolUseId → loop. */
  private readonly asks = new Map<string, LoopName>()
  /** Tool calls in flight, by toolUseId → loop: a dialog waits on one of those open when it showed. */
  private readonly inflight = new Map<string, LoopName>()
  /** A permission or MCP dialog shown: the calls in flight then (one of them asked). Ends when one returns. */
  private dialog: Set<string> | null = null
  /** Hand-backs armed by `agent.report`: child → the loop that will read it. */
  private readonly armed = new Map<string, LoopName>()
  private agents: string[] = []

  /** @param emit gets each ordered post (tool, spawn, report), in event order. */
  constructor(private readonly emit: (p: OrderedPost) => void) {}

  // ---------------------------------------------------------------- prompts

  /** An einweave entry's prompt ENTERED (its `next` resolved without `drop`): it waits for main's next request. */
  entered(id: string): void {
    this.pendingOf(MAIN).push({ id })
  }

  /** A hand-back prompt naming `child` entered: the armed hand-back joins its loop's `pending`. */
  handBackEntered(child: string): void {
    const to = this.armed.get(child)
    if (to === undefined) return
    this.armed.delete(child)
    this.pendingOf(to).push({ agent: child })
  }

  /** A hand-back prompt was dropped (a `UserPromptSubmit` hook blocked it): it lights nothing, ever. */
  handBackDropped(child: string): void {
    this.armed.delete(child)
  }

  // ---------------------------------------------------------------- turns

  turnStart(agentId: string | undefined, turnId: string): void {
    this.openLoop(loopOf(agentId), turnId)
  }

  turnStep(agentId: string | undefined, turnId: string): void {
    const name = loopOf(agentId)
    const loop = this.openLoop(name, turnId)
    const p = this.pending.get(name)
    if (p?.length) {
      loop.inTurn.push(...p)
      this.pending.delete(name)
    }
  }

  turnComplete(agentId: string | undefined, turnId: string): void {
    const name = loopOf(agentId)
    const loop = this.open.get(name)
    // A complete for a turn this loop is not on (an older one) closes nothing.
    if (!loop || (loop.turn !== null && loop.turn !== turnId)) return
    this.close(name)
  }

  /** Claude Code's `idle_prompt`: the MAIN loop waits for its person (its end was missed). */
  idlePrompt(): void {
    this.close(MAIN)
  }

  // ---------------------------------------------------------------- tools

  /**
   * A tool call starts. `ours`: one of this plugin's tools, whose thread the server attributes to this loop's
   * turn by `toolUseId`. A call of a loop with no open turn opens it (a reload never saw its `turn.start`).
   */
  toolCall(agentId: string | undefined, toolUseId: string, tool: string, ours: boolean): void {
    const name = loopOf(agentId)
    const loop = this.openLoop(name, null)
    this.inflight.set(toolUseId, name)
    if (WAITS_ON_PERSON.has(tool)) this.asks.set(toolUseId, name)
    if (ours) this.emit({ kind: 'tool', toolUseId, agent: name, turn: loop.turn })
  }

  /** The call returned (its `next` resolved): whatever it asked was answered. */
  toolDone(toolUseId: string): void {
    this.inflight.delete(toolUseId)
    this.asks.delete(toolUseId)
    if (this.dialog?.has(toolUseId)) this.dialog = null
  }

  /** A dialog shown to the person (`permission_prompt`, `elicitation_dialog`) blocks a call in flight. */
  dialogShown(): void {
    this.dialog = this.inflight.size ? new Set(this.inflight.keys()) : null
  }

  // ---------------------------------------------------------------- subagents

  /**
   * `agent.spawn` resolved with the child's id, inside the spawning loop's Agent call. A resume spawns too:
   * either way the child inherits the spawning loop's OPEN turn, and nothing when that loop has none.
   */
  spawned(child: string, parentAgentId: string | undefined): void {
    const from = loopOf(parentAgentId)
    const loop = this.open.get(from)
    if (!loop) return
    this.emit({ kind: 'spawn', agent: child, from: { agent: from, turn: loop.turn } })
  }

  /** `agent.report`: arms the hand-back for the loop that receives it (main when no parent). */
  reported(child: string, parentAgentId: string | undefined): void {
    const to = loopOf(parentAgentId)
    this.armed.set(child, to)
    this.emit({ kind: 'report', agent: child, to })
  }

  // ---------------------------------------------------------------- re-key, seed, reconcile

  /** `/clear`, `/resume`, `/branch`: the main loop's turn and entries go; subagent loops keep working. */
  rekey(): void {
    this.close(MAIN)
    this.pending.delete(MAIN)
  }

  /**
   * At load, from `$.agent.list()`: a subagent loop running now (`status: "running"` and a `model`: a
   * teammate in a terminal pane has none and runs no loop here) is open, its turn not yet named.
   */
  seed(list: readonly ListedAgent[]): void {
    for (const a of list) if (a.status === 'running' && a.model && !this.open.has(a.id)) this.open.set(a.id, { turn: null, inTurn: [] })
    this.agents = list.map(a => a.id)
  }

  /** The open subagent loops' turns as a reconcile read BEGINS (the read is async). */
  reconcileMark(): Map<string, string | null> {
    const marks = new Map<string, string | null>()
    for (const [name, loop] of this.open) if (name !== MAIN) marks.set(name, loop.turn)
    return marks
  }

  /**
   * After the read: close each open subagent loop the list reports not running, only if its turn is the one
   * marked (one that reopened meanwhile stays open). A loop the list does not name is never closed here.
   */
  reconcile(list: readonly ListedAgent[], marks: Map<string, string | null>): void {
    for (const a of list) {
      const loop = this.open.get(a.id)
      if (loop && NOT_RUNNING.has(a.status) && marks.has(a.id) && marks.get(a.id) === loop.turn) this.close(a.id)
    }
    this.agents = list.map(a => a.id)
  }

  // ---------------------------------------------------------------- output

  state(): TurnStateWord {
    if (this.open.size === 0) return 'idle'
    return this.asks.size > 0 || this.dialog !== null ? 'needs_you' : 'working'
  }

  /** Built when the sender SENDS it, so it is never older than an ordered post ahead of it. */
  snapshot(): SnapshotBody {
    const loops: TurnLoopView[] = []
    for (const [agent, l] of this.open) loops.push({ agent, turn: l.turn, inTurn: [...l.inTurn], pending: [...(this.pending.get(agent) ?? [])] })
    const waiting: { agent: LoopName; pending: TurnEntry[] }[] = []
    for (const [agent, p] of this.pending) if (!this.open.has(agent) && p.length) waiting.push({ agent, pending: [...p] })
    return { kind: 'snapshot', state: this.state(), loops, waiting, agents: [...this.agents] }
  }

  // ---------------------------------------------------------------- internals

  private pendingOf(name: LoopName): TurnEntry[] {
    let p = this.pending.get(name)
    if (!p) this.pending.set(name, (p = []))
    return p
  }

  /**
   * The loop's open turn: named by `turnId` (null = not yet known). Another turnId than the open one is a NEW
   * turn (a loop reopens under the same agentId): the old turn's entries go.
   */
  private openLoop(name: LoopName, turnId: string | null): OpenLoop {
    let loop = this.open.get(name)
    if (loop && turnId !== null && loop.turn !== null && loop.turn !== turnId) {
      this.close(name)
      loop = undefined
    }
    if (!loop) this.open.set(name, (loop = { turn: turnId, inTurn: [] }))
    else if (loop.turn === null && turnId !== null) loop.turn = turnId
    return loop
  }

  /** A closed loop waits on nothing: its asks and calls go (an aborted call's `tool.done` may never come). */
  private close(name: LoopName): void {
    this.open.delete(name)
    for (const [id, l] of this.asks) if (l === name) this.asks.delete(id)
    for (const [id, l] of this.inflight) {
      if (l !== name) continue
      this.inflight.delete(id)
      this.dialog?.delete(id)
    }
    if (this.dialog?.size === 0) this.dialog = null
  }
}
