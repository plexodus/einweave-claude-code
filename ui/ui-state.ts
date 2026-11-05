/**
 * What the einweave mod draws (plan 2026-10-25-terminal-ui.md, Phase 2 PR 1): one snapshot of
 * this session's state, built from the server's module state and served two ways -- the
 * `ui_state` tool (structuredContent) and the control socket's `watch` op, which pushes a new
 * snapshot whenever it changes (ctl-protocol.ts).
 *
 * The builder is pure: server.ts hands it what it holds, so the shape is tested without a socket.
 */

export type UiConnection = "connected" | "superseded" | "standby" | "disconnected" | "idle";

export interface UiWaitingItem {
  threadId: string;
  title: string;
  channel: string;
  why: "addressed" | "participant" | "channel";
  hold: "unheld" | "parked" | "held";
  /** The thread's last activity (ISO): how long it has been quiet. Null from a server that does not send it. */
  quietSince: string | null;
}

export interface UiWaiting {
  /** Exact, all pages (server counts); null from a server that predates them. */
  forYou: number | null;
  channel: number | null;
  /** `top` is not everything: rows were cut, or the server had pages not read. */
  more: boolean;
  top: UiWaitingItem[];
}

/** The agent's gateway (RFC-028 D2), for board Unowned's line: online, it routes unheld work; off, that work waits for a take. */
export interface UiGateway {
  online: boolean;
  /** The gateway session's name; null when none is online. */
  label: string | null;
}

export interface UiHeld {
  threadId: string;
  title: string | null;
  /** The rest is the server's held list (`?held=1`); null until it is read. */
  channel: string | null;
  /** The thread's last activity (ISO). */
  quietSince: string | null;
  /** Posts pushed to this window that its model has not confirmed. */
  unseenByModel: number | null;
  /** Who posted last: `@handle`, else the name. */
  lastBy: string | null;
}

/** Another session of this agent, a Hand over target (observers excluded). */
export interface UiSession {
  id: string;
  label: string;
  online: boolean;
  /** Its own name (a rename); null = derived. */
  name: string | null;
  /** Where it works and on what branch (the label's parts); null = not reported. */
  folder: string | null;
  branch: string | null;
  /** What its model is doing and since when; null while offline or when its client reports none. */
  activity: { state: "working" | "needs_you" | "idle"; since: string } | null;
  /** The first held thread the agent may read, by title, and how many it holds in all. */
  holds: { title: string | null; count: number };
}

/** One held thread as the server lists it, before it meets the live set of held ids. */
export interface HeldInfo {
  title: string;
  channel: string;
  quietSince: string | null;
  unseenByModel: number | null;
  lastBy: string | null;
}

export interface UiState {
  v: 1;
  connection: { state: UiConnection; detail: string | null };
  session: { agent: string | null; label: string | null; kind: string | null; scope: unknown };
  /** Threads this session holds, newest activity first; one the list has not caught up with last, its fields null. */
  holds: UiHeld[];
  /** This agent's other sessions, online first; null until read. */
  sessions: UiSession[] | null;
  /** Unheld work this session could take; null until first read, or while not connected. */
  waiting: UiWaiting | null;
  /** Null until first read, while not connected, or when the sessions list cannot be read. */
  gateway: UiGateway | null;
  version: string;
  staleSince: string | null;
  /** The pane's data socket (ui/ui-server.ts); null when it is not open: the mod reads over MCP. */
  uiSocket: string | null;
}

export interface UiInputs {
  authenticated: boolean;
  /** A Session exists (connect was asked for); false: idle. */
  hasSession: boolean;
  /** Another window took this session over (D3): nothing reconnects until a person takes it back. */
  superseded: boolean;
  standby: boolean;
  /** connectionState()'s text, shown as the detail when not connected. */
  stateText: string;
  /** The process that has this session when superseded or standing by, as far as it is known. */
  holder: { pid: number; termProgram?: string; tty?: string } | null;
  agent: string | null;
  label: string | null;
  kind: string | null;
  scope: unknown;
  /** The live set of held ids (hello + hold_update): which threads are listed. */
  holds: readonly string[];
  /** The server's held list, by thread id: what each is drawn with. */
  held: ReadonlyMap<string, HeldInfo>;
  sessions: UiSession[] | null;
  waiting: UiWaiting | null;
  gateway: UiGateway | null;
  version: string;
  staleSince: string | null;
  uiSocket?: string | null;
}

/** Which window has the session, for a person to find it; the close code and the tool advice stay in `status`. */
function holderDetail(h: UiInputs["holder"]): string | null {
  if (!h) return null;
  return `that window: ${[`pid ${h.pid}`, h.termProgram, h.tty && h.tty !== "??" ? h.tty : null].filter(Boolean).join(" · ")}`;
}

/** Idle already says "not connected": keep only why the last connection closed, if it said. */
function idleDetail(stateText: string): string | null {
  const why = stateText.indexOf(" — ");
  return why >= 0 ? stateText.slice(why + 3) || null : null;
}

export function buildUiState(i: UiInputs): UiState {
  const state: UiConnection = i.authenticated ? "connected" : i.superseded ? "superseded" : i.standby ? "standby" : i.hasSession ? "disconnected" : "idle";
  const detail =
    state === "connected" ? null : state === "superseded" || state === "standby" ? holderDetail(i.holder) : state === "idle" ? idleDetail(i.stateText) : i.stateText || null;
  return {
    v: 1,
    connection: { state, detail },
    session: { agent: i.agent, label: i.label, kind: i.kind, scope: i.authenticated ? (i.scope ?? null) : null },
    holds: i.authenticated ? heldRows(i.holds, i.held) : [],
    sessions: i.authenticated ? i.sessions : null,
    waiting: i.authenticated ? i.waiting : null,
    gateway: i.authenticated ? i.gateway : null,
    version: i.version,
    staleSince: i.staleSince,
    uiSocket: i.uiSocket ?? null,
  };
}

/**
 * The held ids (live: the socket says at once when one comes or goes) drawn with the server's list (read on
 * change): newest activity first, an id the list has not caught up with last, in hold order.
 */
function heldRows(ids: readonly string[], held: ReadonlyMap<string, HeldInfo>): UiHeld[] {
  const at = (h: HeldInfo | undefined) => {
    const t = h?.quietSince ? Date.parse(h.quietSince) : NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...new Set(ids)]
    .map((threadId, n) => ({ threadId, n, h: held.get(threadId) }))
    .sort((a, b) => at(b.h) - at(a.h) || a.n - b.n)
    .map(({ threadId, h }) => ({
      threadId,
      title: h?.title || null,
      channel: h?.channel ?? null,
      quietSince: h?.quietSince ?? null,
      unseenByModel: h?.unseenByModel ?? null,
      lastBy: h?.lastBy ?? null,
    }));
}

/** The server's held rows (holds.held), keyed for `heldRows`. */
export function toHeld(rows: ReadonlyArray<{
  thread: { id: string; title: string; lastActivityAt?: string; unseenByModel?: number; last?: { sender: { name: string | null; handle: string | null } } | null };
  channel: { name: string };
}>): Map<string, HeldInfo> {
  return new Map(
    rows.map((r) => {
      const s = r.thread.last?.sender;
      return [
        r.thread.id,
        {
          title: r.thread.title,
          channel: r.channel.name,
          quietSince: r.thread.lastActivityAt ?? null,
          unseenByModel: typeof r.thread.unseenByModel === "number" ? r.thread.unseenByModel : null,
          lastBy: s?.handle ? `@${s.handle}` : (s?.name ?? null),
        },
      ];
    })
  );
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

/**
 * One refresh's reads, merged: each keeps its last good value when only its read failed, so a failing
 * sessions list never blanks what waits, nor the reverse.
 */
export function mergeRefresh<T extends Record<string, unknown>>(prev: T, next: { [K in keyof T]: PromiseSettledResult<T[K]> }): T {
  const out = { ...prev };
  for (const k of Object.keys(next) as (keyof T)[]) {
    const r = next[k];
    if (r.status === "fulfilled") out[k] = r.value;
  }
  return out;
}

/** The mod's Inbox lists this many, picked from up to UI_WAITING_PAGES pages of UI_WAITING_PAGE (the server's max). */
export const UI_WAITING_LIMIT = 20;
export const UI_WAITING_PAGE = 50;
export const UI_WAITING_PAGES = 4;

/**
 * needSomeone's raw rows, shaped down to what the mod draws: held ones dropped, For you (addressed,
 * taken part in) before Open (the channel tier), each newest first (Jörgen 2026-11-03: newest first,
 * scroll and search, no "Older" fold); a row without a time last in each. Sorted BEFORE the cut, so
 * the cut drops the oldest of each, which the Inbox search still finds.
 */
export function toWaiting(r: {
  rows: ReadonlyArray<{ thread: { id: string; title: string; lastActivityAt?: string }; channel: { name: string }; why: UiWaitingItem["why"]; hold: { state: UiWaitingItem["hold"] } }>;
  more: boolean;
  counts: { forYou: number; channel: number } | null;
}, limit = UI_WAITING_LIMIT): UiWaiting {
  const at = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const open = r.rows
    .filter((x) => x.hold.state !== "held")
    .map((x) => ({ x, tier: x.why === "channel" ? 1 : 0, t: at(x.thread.lastActivityAt) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.t === b.t) return 0;
      if (a.t === Number.POSITIVE_INFINITY || b.t === Number.POSITIVE_INFINITY) return a.t === Number.POSITIVE_INFINITY ? 1 : -1;
      return a.t < b.t ? 1 : -1;
    });
  return {
    forYou: r.counts?.forYou ?? null,
    channel: r.counts?.channel ?? null,
    more: r.more || open.length > limit,
    top: open
      .slice(0, limit)
      .map(({ x }) => ({ threadId: x.thread.id, title: x.thread.title, channel: x.channel.name, why: x.why, hold: x.hold.state, quietSince: x.thread.lastActivityAt ?? null })),
  };
}
