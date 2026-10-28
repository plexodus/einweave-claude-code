/**
 * What the einweave mod draws (plan 2026-10-25-terminal-ui.md, Phase 2 PR 1): one snapshot of
 * this session's state, built from the server's module state and served two ways -- the
 * `ui_state` tool (structuredContent) and the control socket's `watch` op, which pushes a new
 * snapshot whenever it changes (ctl-protocol.ts).
 *
 * The builder is pure: server.ts hands it what it holds, so the shape is tested without a socket.
 */

export type UiConnection = "connected" | "standby" | "disconnected" | "idle";

export interface UiWaitingItem {
  threadId: string;
  title: string;
  channel: string;
  why: "addressed" | "participant" | "channel";
  hold: "unheld" | "parked" | "held";
}

export interface UiWaiting {
  /** Exact, all pages (server counts); null from a server that predates them. */
  forYou: number | null;
  channel: number | null;
  /** The first page had a next page: `top` is not everything. */
  more: boolean;
  top: UiWaitingItem[];
}

export interface UiState {
  v: 1;
  connection: { state: UiConnection; detail: string | null };
  session: { agent: string | null; label: string | null; kind: string | null; scope: unknown };
  /** Thread ids this session holds. */
  holds: string[];
  /** Unheld work this session could take; null until first read, or while not connected. */
  waiting: UiWaiting | null;
  version: string;
  staleSince: string | null;
}

export interface UiInputs {
  authenticated: boolean;
  /** A Session exists (connect was asked for); false: idle. */
  hasSession: boolean;
  standby: boolean;
  /** connectionState()'s text, shown as the detail when not connected. */
  stateText: string;
  agent: string | null;
  label: string | null;
  kind: string | null;
  scope: unknown;
  holds: readonly string[];
  waiting: UiWaiting | null;
  version: string;
  staleSince: string | null;
}

export function buildUiState(i: UiInputs): UiState {
  const state: UiConnection = i.authenticated ? "connected" : i.standby ? "standby" : i.hasSession ? "disconnected" : "idle";
  return {
    v: 1,
    connection: { state, detail: state === "connected" ? null : i.stateText || null },
    session: { agent: i.agent, label: i.label, kind: i.kind, scope: i.authenticated ? (i.scope ?? null) : null },
    holds: i.authenticated ? [...i.holds] : [],
    waiting: i.authenticated ? i.waiting : null,
    version: i.version,
    staleSince: i.staleSince,
  };
}

/**
 * The current snapshot and its revision. `set` bumps `rev` and tells subscribers ONLY when the
 * snapshot differs from the last one, so a caller may set as often as it likes.
 */
export class UiWatch {
  private json = "";
  private snapshot: UiState | null = null;
  private revision = 0;
  private readonly subs = new Set<(rev: number, state: UiState) => void>();

  set(state: UiState): boolean {
    const json = JSON.stringify(state);
    if (json === this.json) return false;
    this.json = json;
    this.snapshot = state;
    this.revision++;
    for (const fn of [...this.subs]) {
      try {
        fn(this.revision, state);
      } catch {}
    }
    return true;
  }

  current(): { rev: number; state: UiState } | null {
    return this.snapshot ? { rev: this.revision, state: this.snapshot } : null;
  }

  subscribe(fn: (rev: number, state: UiState) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  subscribers(): number {
    return this.subs.size;
  }
}

/** needSomeone's raw rows, shaped down to what the mod draws. */
export function toWaiting(r: {
  rows: ReadonlyArray<{ thread: { id: string; title: string }; channel: { name: string }; why: UiWaitingItem["why"]; hold: { state: UiWaitingItem["hold"] } }>;
  more: boolean;
  counts: { forYou: number; channel: number } | null;
}, limit = 5): UiWaiting {
  return {
    forYou: r.counts?.forYou ?? null,
    channel: r.counts?.channel ?? null,
    more: r.more,
    top: r.rows
      .filter((x) => x.hold.state !== "held")
      .slice(0, limit)
      .map((x) => ({ threadId: x.thread.id, title: x.thread.title, channel: x.channel.name, why: x.why, hold: x.hold.state })),
  };
}
