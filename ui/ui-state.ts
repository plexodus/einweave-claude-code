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

export interface UiHeld {
  threadId: string;
  title: string | null;
}

export interface UiState {
  v: 1;
  connection: { state: UiConnection; detail: string | null };
  session: { agent: string | null; label: string | null; kind: string | null; scope: unknown };
  /** Threads this session holds, in hold order; `title` null until read, or when it has none. */
  holds: UiHeld[];
  /** Unheld work this session could take; null until first read, or while not connected. */
  waiting: UiWaiting | null;
  version: string;
  staleSince: string | null;
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
  holds: readonly string[];
  /** Titles read so far (holds.titlesOf); a held id missing here is drawn without one. */
  titles: ReadonlyMap<string, string | null>;
  waiting: UiWaiting | null;
  version: string;
  staleSince: string | null;
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
    holds: i.authenticated ? i.holds.map((threadId) => ({ threadId, title: i.titles.get(threadId) ?? null })) : [],
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

/** The mod's Inbox lists this many, picked from up to UI_WAITING_PAGES pages of UI_WAITING_PAGE (the server's max). */
export const UI_WAITING_LIMIT = 20;
export const UI_WAITING_PAGE = 50;
export const UI_WAITING_PAGES = 4;

/**
 * needSomeone's raw rows, shaped down to what the mod draws: held ones dropped, For you (addressed,
 * taken part in) before Open (the channel tier), each quiet longest first, a row without a time last.
 * The server sends newest first, so this sorts BEFORE it cuts: cutting first would keep the newest.
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
    .sort((a, b) => a.tier - b.tier || (a.t === b.t ? 0 : a.t < b.t ? -1 : 1));
  return {
    forYou: r.counts?.forYou ?? null,
    channel: r.counts?.channel ?? null,
    more: r.more || open.length > limit,
    top: open
      .slice(0, limit)
      .map(({ x }) => ({ threadId: x.thread.id, title: x.thread.title, channel: x.channel.name, why: x.why, hold: x.hold.state, quietSince: x.thread.lastActivityAt ?? null })),
  };
}
