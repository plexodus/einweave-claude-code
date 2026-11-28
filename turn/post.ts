/**
 * RFC-038 D3 — a `POST /turn` body from the mod, checked before the turn list sees it. The mod server lives in
 * the plugin's private directory, so the sender is this window's own mod; the check keeps a malformed post (a
 * version skew, a bug) from corrupting the list, and it is all-or-nothing.
 */
import type { TurnEntry, TurnLoopView, TurnPost } from "../types/turn";

/** The most items any one list may carry (the mod keeps its newest: `mod/turn-loops.ts` LIST_MAX). */
export const MAX_ITEMS = 256;
const isStr = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isTurn = (v: unknown): v is string | null => v === null || isStr(v);
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const list = (v: unknown): unknown[] | null => (Array.isArray(v) && v.length <= MAX_ITEMS ? v : null);

function entry(v: unknown): TurnEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if ("id" in o) return isStr(o.id) ? { id: o.id } : null;
  if ("agent" in o) return isStr(o.agent) ? { agent: o.agent } : null;
  return null;
}

function entries(v: unknown): TurnEntry[] | null {
  const l = list(v);
  if (!l) return null;
  const out: TurnEntry[] = [];
  for (const x of l) {
    const e = entry(x);
    if (!e) return null;
    out.push(e);
  }
  return out;
}

/** The post, or null when any part of it is malformed. */
export function parseTurnPost(v: unknown): TurnPost | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.epoch) || !isSeq(o.seq)) return null;
  const base = { epoch: o.epoch, seq: o.seq };
  switch (o.kind) {
    case "snapshot": {
      if (o.state !== "working" && o.state !== "needs_you" && o.state !== "idle") return null;
      const loopsIn = list(o.loops);
      const waitingIn = list(o.waiting);
      const agentsIn = list(o.agents);
      if (!loopsIn || !waitingIn || !agentsIn || !agentsIn.every((a) => isStr(a))) return null;
      const loops: TurnLoopView[] = [];
      for (const x of loopsIn) {
        const l = x as Record<string, unknown> | null;
        if (!l || !isStr(l.agent) || !isTurn(l.turn)) return null;
        const inTurn = entries(l.inTurn);
        const pending = entries(l.pending);
        if (!inTurn || !pending) return null;
        loops.push({ agent: l.agent, turn: l.turn, inTurn, pending });
      }
      const waiting: { agent: string; pending: TurnEntry[] }[] = [];
      for (const x of waitingIn) {
        const w = x as Record<string, unknown> | null;
        const pending = w ? entries(w.pending) : null;
        if (!w || !isStr(w.agent) || !pending) return null;
        waiting.push({ agent: w.agent, pending });
      }
      return { kind: "snapshot", ...base, state: o.state, loops, waiting, agents: agentsIn as string[] };
    }
    case "tool":
      return isStr(o.toolUseId) && isStr(o.agent) && isTurn(o.turn) ? { kind: "tool", ...base, toolUseId: o.toolUseId, agent: o.agent, turn: o.turn } : null;
    case "spawn": {
      const f = o.from as Record<string, unknown> | null;
      return isStr(o.agent) && f && isStr(f.agent) && isTurn(f.turn) ? { kind: "spawn", ...base, agent: o.agent, from: { agent: f.agent, turn: f.turn } } : null;
    }
    case "report":
      return isStr(o.agent) && isStr(o.to) ? { kind: "report", ...base, agent: o.agent, to: o.to } : null;
    default:
      return null;
  }
}
