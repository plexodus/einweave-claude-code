/**
 * RFC-038 D3 — what the mod posts to its MCP server (`POST /turn` on the UI socket), one post per request,
 * through ONE ordered sender. Shared by the mod (`mod/turn-loops.ts`) and the server (`turn/list.ts`).
 *
 * `epoch` is random per mod module instance (a reload, a new window); `seq` counts within it. The server
 * keeps the highest `seq` of the current epoch: a lower or equal one is a duplicate or stale.
 */

export type TurnStateWord = 'working' | 'needs_you' | 'idle'

/** A loop: `"main"` or a subagent's `agentId`. */
export type LoopName = string

/**
 * What a loop's turn carries: an einweave entry the model was given (`id`), or a subagent's hand-back
 * (`agent`, the child whose report the turn reads).
 */
export type TurnEntry = { id: string } | { agent: string }

export interface TurnLoopView {
  agent: LoopName
  /** Claude Code's `turnId` of the loop's open turn; null for a loop seeded at load until an event names it. */
  turn: string | null
  /** Entries the loop's open turn has read (lit). */
  inTurn: TurnEntry[]
  /** Entries that entered and wait for the loop's next model request (never lit; sent to pin their ids). */
  pending: TurnEntry[]
}

export type TurnPost =
  | {
      kind: 'snapshot'
      epoch: string
      seq: number
      state: TurnStateWord
      /** Every OPEN loop. A loop not listed is closed. */
      loops: TurnLoopView[]
      /**
       * Entries waiting in a CLOSED loop (main idle, an entered prompt with no turn after it yet). Never lit,
       * never an open loop: sent so their ids stay pinned and a hand-back among them is not forgotten.
       */
      waiting: { agent: LoopName; pending: TurnEntry[] }[]
      /** The ids `$.agent.list()` named at the mod's last reconcile point. */
      agents: string[]
    }
  | { kind: 'tool'; epoch: string; seq: number; toolUseId: string; agent: LoopName; turn: string | null }
  | { kind: 'spawn'; epoch: string; seq: number; agent: string; from: { agent: LoopName; turn: string | null } }
  | { kind: 'report'; epoch: string; seq: number; agent: string; to: LoopName }
