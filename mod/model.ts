/**
 * The einweave mod's rules, kept free of the mods API so the plugin's own `bun test` covers them
 * (test/mod-model.test.ts): what a relay line means, which state the indicator shows, and what each
 * `/einweave` verb calls. mod/register.tsx only wires these to `$`.
 */
import type { ChannelCounts, ChannelsView, ChannelThread, ChannelView, OpenTab, PaneTabs, ThreadView, UiSnapshot, UiWaitingItem, View } from '../types'

/** A drop shorter than this shows as "reconnecting", not in the band (plan decision 5). */
export const BAND_GRACE_MS = 10_000

export const EMPTY_VIEW: View = { rev: 0, snap: null, live: false, error: null, downSince: null }

/** One line from ui/ctl-watch.ts: a snapshot, or why there is none. */
export function parseLine(line: string): { rev: number; snap: UiSnapshot } | { error: string } | null {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const r = o as { ok?: unknown; rev?: unknown; state?: unknown; error?: unknown }
  if (r.ok === false) return { error: typeof r.error === 'string' ? r.error : 'refused' }
  if (r.ok === true && typeof r.rev === 'number' && isSnapshot(r.state)) return { rev: r.rev, snap: r.state }
  return null
}

/**
 * `ui_state`'s answer: `{ rev, ...UiSnapshot }`, as structuredContent or, where the host leaves that
 * out (Claude Code's `$.mcp.call` did, measured 2026-10-29), as the JSON text block the server also writes.
 */
export function fromTool(r: { content?: ReadonlyArray<{ type: string; text?: string }>; structuredContent?: unknown }): { rev: number; snap: UiSnapshot } | null {
  return snapshotOf(r.structuredContent) ?? snapshotOf(jsonOf(r.content?.find(b => b.type === 'text')?.text))
}

function jsonOf(text: string | undefined): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function snapshotOf(o: unknown): { rev: number; snap: UiSnapshot } | null {
  if (!o || typeof o !== 'object') return null
  const { rev, ...rest } = o as { rev?: unknown }
  return typeof rev === 'number' && isSnapshot(rest) ? { rev, snap: rest } : null
}

function isSnapshot(s: unknown): s is UiSnapshot {
  const o = s as Partial<UiSnapshot> | null
  return !!o && o.v === 1 && typeof o.connection?.state === 'string' && Array.isArray(o.holds)
}

/**
 * The view after a snapshot. An older `rev` than the one held is ignored (a poll answered after a
 * push), except from a restarted plugin process, whose revisions start again at 1: `restart` says so.
 */
export function applySnapshot(v: View, rev: number, snap: UiSnapshot, now: number, restart = false): View {
  if (!restart && v.snap && rev < v.rev) return v
  const down = snap.connection.state === 'disconnected'
  return { ...v, rev, snap, error: null, downSince: down ? (v.downSince ?? now) : null }
}

export type IndicatorKind = 'starting' | 'no-answer' | 'idle' | 'superseded' | 'standby' | 'reconnecting' | 'disconnected' | 'connected'

export interface Indicator {
  kind: IndicatorKind
  /** One line, for the hint tail and the pane header. */
  text: string
}

export function indicator(v: View, now: number): Indicator {
  const s = v.snap
  if (!s) return v.error ? { kind: 'no-answer', text: 'einweave · not answering' } : { kind: 'starting', text: 'einweave · starting' }
  switch (s.connection.state) {
    case 'idle':
      return { kind: 'idle', text: 'einweave · not connected' }
    case 'superseded':
      return { kind: 'superseded', text: 'einweave · moved to another window' }
    case 'standby':
      return { kind: 'standby', text: 'einweave · standby (another window has this session)' }
    case 'disconnected': {
      const long = v.downSince !== null && now - v.downSince >= BAND_GRACE_MS
      return long ? { kind: 'disconnected', text: 'einweave · disconnected' } : { kind: 'reconnecting', text: 'einweave · reconnecting' }
    }
    case 'connected': {
      const parts = [`holds ${s.holds.length}`]
      const w = s.waiting
      if (w?.forYou) parts.push(`${w.forYou} for you`)
      if (w?.channel) parts.push(`${w.channel} open`)
      return { kind: 'connected', text: `einweave · ${parts.join(' · ')}` }
    }
  }
}

/** The band shows only while something needs the person: a lasting disconnect, or a takeover by another window. */
export function needsBand(i: Indicator): boolean {
  return i.kind === 'disconnected' || i.kind === 'superseded'
}

export type Action =
  | { kind: 'pane' }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'connect' }
  | { kind: 'status'; full: boolean }
  | { kind: 'usage'; text: string }
  | { kind: 'take'; ref: string }
  | { kind: 'find'; words: string }

export const USAGE = [
  '/einweave                       open the pane',
  '/einweave status [full]         connection, session and what waits (full: every field)',
  '/einweave connect | disconnect  join or leave einweave in this session',
  '/einweave rename <name>         rename this session ("" clears)',
  '/einweave scope [#a #b|all|none] which unheld work reaches this session',
  '/einweave held                  the threads this session holds, numbered',
  '/einweave release [N|all]       let go of a thread',
  '/einweave handover [N] [to]     move a thread to another session of this agent',
  '/einweave take [N|id]           take a thread for this session (no ref: the numbered list)',
  '/einweave find <words>          the takeable threads whose titles hold these words',
].join('\n')

/** `/einweave <verb> <rest>` → what to do. Every tool named here is the plugin's own. */
export function parseCommand(args: string): Action {
  const trimmed = args.trim()
  const sp = trimmed.search(/\s/)
  const verb = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase()
  const rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim()
  switch (verb) {
    case '':
      return { kind: 'pane' }
    case 'status':
      return { kind: 'status', full: rest.toLowerCase() === 'full' }
    case 'connect':
      return { kind: 'connect' }
    case 'disconnect':
      return { kind: 'tool', tool: 'disconnect', args: {} }
    case 'rename':
      if (!rest) return { kind: 'usage', text: 'Usage: /einweave rename <name>  ("" clears it)' }
      return { kind: 'tool', tool: 'set_session_label', args: { label: rest === '""' ? '' : rest } }
    case 'scope':
      return { kind: 'tool', tool: 'scope', args: rest ? { channels: rest } : {} }
    case 'held':
      // `release` with no ref lists the held threads and numbers them, so `release N` acts on that list.
      return { kind: 'tool', tool: 'release', args: {} }
    case 'release':
      return { kind: 'tool', tool: 'release', args: rest ? { ref: rest } : {} }
    case 'take':
      return rest ? { kind: 'take', ref: rest } : { kind: 'tool', tool: 'take', args: {} }
    case 'find':
      if (!rest) return { kind: 'usage', text: 'Usage: /einweave find <words>' }
      return { kind: 'find', words: rest }
    case 'handover': {
      if (!rest) return { kind: 'tool', tool: 'handover', args: {} }
      const s = rest.search(/\s/)
      return s < 0 ? { kind: 'tool', tool: 'handover', args: { ref: rest } } : { kind: 'tool', tool: 'handover', args: { ref: rest.slice(0, s), to: rest.slice(s + 1).trim() } }
    }
    default:
      return { kind: 'usage', text: `Unknown: ${verb}\n\n${USAGE}` }
  }
}

/** The scope as the pane shows it: a mode, or its channels by name (at most three, then a count of the rest). */
export function scopeText(scope: NonNullable<UiSnapshot['session']['scope']>): string {
  if (scope.mode === 'none') return 'none · only threads this session holds'
  if (scope.mode === 'all') return 'all · unheld work from every channel'
  const names = (scope.channelNames ?? []).filter((n): n is string => !!n).slice(0, 3).map(n => `#${n}`)
  if (!names.length) return `${scope.channelIds.length} channels`
  const rest = scope.channelIds.length - names.length
  return rest > 0 ? `${names.join(' ')} +${rest}` : names.join(' ')
}

/** The fields of `status`'s JSON the summary reads; everything else is for `status full`. */
interface StatusFields {
  websocket?: string
  agent?: string | null
  label?: string | null
  kind?: string
  scope?: { mode: string; channelIds?: string[] }
  holds?: unknown[]
  last_server_error?: string
  session_key?: string
  session_key_resumable?: boolean
  version?: string
  installed_version?: string | null
  stale_since?: string | null
  server_versions?: { minimum?: string; recommended?: string } | null
  advice?: string | null
  other_processes?: { pid: number; state: string; sessionKey: string; tty?: string }[]
  delivery?: { state?: string; hint?: string }
  configured?: boolean
  auth?: { profile?: string }
}

/**
 * `/einweave status`: the few lines a person acts on, from `status`'s JSON. Unreadable JSON
 * (an older plugin, an error) is handed back as it came.
 */
export function statusSummary(text: string, waiting: UiSnapshot['waiting'] = null): string {
  let s: StatusFields
  try {
    s = JSON.parse(text) as StatusFields
  } catch {
    return text
  }
  if (!s || typeof s !== 'object') return text
  if (s.configured === false) return 'not signed in on this machine: /einweave:login'
  const lines: string[] = []
  const who = [s.agent ? `agent ${s.agent}` : null, s.label ? `name ${s.label}` : null, s.kind && s.kind !== 'session' ? s.kind : null].filter(Boolean)
  lines.push([s.websocket ?? 'unknown', ...who].join(' · '))
  if (s.scope) lines.push(`scope ${s.scope.mode === 'channels' ? `${s.scope.channelIds?.length ?? 0} channels` : s.scope.mode}`)
  if (Array.isArray(s.holds)) {
    const w = waiting?.forYou ? ` · ${waiting.forYou}${waiting.more ? '+' : ''} for you (/einweave:take)` : ''
    lines.push(`holds ${s.holds.length}${w}`)
  }
  if (s.last_server_error) lines.push(`server said: ${s.last_server_error}`)
  if (s.delivery?.hint) lines.push(`delivery ${s.delivery.state ?? ''}: ${s.delivery.hint}`)
  const rec = s.server_versions?.recommended
  const ver = [`plugin ${s.version ?? '?'}`, rec && rec !== s.version ? `recommended ${rec}` : null, s.advice && s.advice !== 'ok' ? s.advice : null].filter(Boolean)
  lines.push(ver.join(' · '))
  if (s.stale_since) lines.push(`updated on disk to ${s.installed_version ?? 'a newer version'}: restart Claude Code to use it`)
  if (s.session_key) {
    const same = (s.other_processes ?? []).filter(p => p.sessionKey === s.session_key)
    lines.push(`session ${s.session_key}`)
    if (same.length) {
      lines.push(`also open in ${same.map(p => `pid ${p.pid} (${p.state})`).join(', ')}`)
      if (s.session_key_resumable) lines.push(`to make a window its own session: claude --resume ${s.session_key} --fork-session`)
    }
  }
  return lines.join('\n')
}

/** An MCP result's text blocks, joined. */
export function textOf(r: { content: readonly { type: string; text?: string }[] }): string {
  return r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n').trim()
}

export const EMPTY_TABS: PaneTabs = { tab: 'inbox', open: [] }

/** How long ago, in one short unit: `40s`, `12m`, `3h`, `2d`. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export interface InboxRow {
  threadId: string
  title: string
  channel: string
  /** `unheld · addressed to you`, `parked · you took part` ... */
  meta: string
  /** `quiet 3h`: since the thread's last post; null when the server sent no time. */
  quiet: string | null
}

const WHY: Record<UiWaitingItem['why'], string> = { addressed: 'addressed to you', participant: 'you took part', channel: 'new posts in your channel' }

/**
 * The Inbox tab: For you (addressed, or taken part in) and Open (new posts in a followed channel),
 * in the snapshot's order -- quiet longest first, sorted where the rows are cut (ui/ui-state.ts toWaiting).
 */
export function inbox(waiting: UiSnapshot['waiting'], now: number): { forYou: InboxRow[]; open: InboxRow[] } {
  const rows = waiting?.top ?? []
  const row = (w: UiWaitingItem): InboxRow => ({
    threadId: w.threadId,
    title: w.title,
    channel: w.channel,
    meta: `${w.hold} · ${WHY[w.why]}`,
    quiet: w.quietSince && Number.isFinite(Date.parse(w.quietSince)) ? `quiet ${ago(now - Date.parse(w.quietSince))}` : null,
  })
  return { forYou: rows.filter(w => w.why !== 'channel').map(row), open: rows.filter(w => w.why === 'channel').map(row) }
}

/** The opening of `take`'s answer when an online holder must be asked about first (holds.ts; pinned by test/mod-model.test.ts). */
export const TAKE_ASKS = 'is online and working on this. Take it anyway?'

/** What `take` answered: taken, a question to put to the person (with the id to confirm), or anything else (shown as is). */
export function takeOutcome(text: string): { kind: 'taken' } | { kind: 'ask'; question: string; id: string } | { kind: 'other' } {
  if (/^This session (now holds|already held) /.test(text)) return { kind: 'taken' }
  const ask = text.indexOf(TAKE_ASKS)
  const id = /ref "([0-9a-f-]{36})"/i.exec(text)?.[1]
  if (ask > 0 && id) return { kind: 'ask', question: text.slice(0, ask + TAKE_ASKS.length), id }
  return { kind: 'other' }
}

/** `ui_thread`'s JSON → a thread tab's content; anything else is an error to show. */
export function threadView(text: string): ThreadView {
  try {
    const o = JSON.parse(text) as { thread?: { title?: string | null; status?: string | null }; messages?: ThreadView['messages']; has_older?: boolean; older_count?: number | null }
    if (!o || !Array.isArray(o.messages)) throw new Error('no messages')
    const older = o.has_older !== true ? 0 : typeof o.older_count === 'number' ? o.older_count : null
    return { title: o.thread?.title ?? null, status: o.thread?.status ?? null, messages: o.messages, older, error: null, loading: false }
  } catch {
    return { title: null, status: null, messages: [], older: 0, error: text || 'ui_thread answered nothing', loading: false }
  }
}

/** Open a thread or channel tab (once) and show it. */
export function openTab(t: PaneTabs, kind: OpenTab['kind'], id: string, title: string): PaneTabs {
  return { tab: id, open: t.open.some(x => x.id === id) ? t.open : [...t.open, { kind, id, title }] }
}

const FIXED_TABS = ['inbox', 'held', 'channels', 'session']

/** The tab to draw: an opened tab that is gone from the list (closed meanwhile) falls back to the Inbox. */
export function shownTab(t: PaneTabs): string {
  return FIXED_TABS.includes(t.tab) || t.open.some(x => x.id === t.tab) ? t.tab : 'inbox'
}

/** Close an opened tab; the Inbox shows if it was the one showing. */
export function closeTab(t: PaneTabs, id: string): PaneTabs {
  return { tab: t.tab === id ? 'inbox' : t.tab, open: t.open.filter(x => x.id !== id) }
}

export const NO_CHANNELS: ChannelsView = { agent: null, channels: [], error: null, loading: true }

/** `ui_channels`' JSON → the Channels tab; anything else is an error to show. */
export function channelsView(text: string): ChannelsView {
  try {
    const o = JSON.parse(text) as { agent?: string | null; channels?: ChannelsView['channels'] }
    if (!o || !Array.isArray(o.channels)) throw new Error('no channels')
    return { agent: o.agent ?? null, channels: o.channels, error: null, loading: false }
  } catch {
    return { ...NO_CHANNELS, loading: false, error: text || 'ui_channels answered nothing' }
  }
}

/** `ui_channel`'s JSON → a channel tab; anything else is an error to show. */
export function channelView(text: string): ChannelView {
  try {
    const o = JSON.parse(text) as { threads?: ChannelThread[] }
    if (!o || !Array.isArray(o.threads)) throw new Error('no threads')
    return { threads: o.threads, error: null, loading: false }
  } catch {
    return { threads: [], error: text || 'ui_channel answered nothing', loading: false }
  }
}

/** Threads waiting for this agent in a channel: unheld or parked. */
export function waitingIn(c: ChannelCounts | undefined): number {
  return c ? c.unheld + c.parked : 0
}

/** A channel row's meta: `open 4 · waiting 2 · oldest 3h`; "counts unknown" when the server did not say (never 0). */
export function channelMeta(c: ChannelCounts | undefined, now: number): string {
  if (!c) return 'counts unknown'
  const parts = [`open ${c.open}`]
  const w = waitingIn(c)
  if (w) parts.push(`waiting ${w}`)
  if (w && c.oldestWaitingAt && Number.isFinite(Date.parse(c.oldestWaitingAt))) parts.push(`oldest ${ago(now - Date.parse(c.oldestWaitingAt))}`)
  return parts.join(' · ')
}

/** Who holds a thread, for its row: here, another session (online or not), or nobody. Absent hold (older server): null. */
export function holdBadge(hold: ChannelThread['hold'], heldHere: boolean): { text: string; color: 'cyan' | 'yellow' | undefined } | null {
  if (heldHere) return { text: 'held here', color: 'cyan' }
  if (!hold) return null
  const who = hold.holder?.label ?? 'another session'
  if (hold.state === 'unheld') return { text: 'unheld', color: 'yellow' }
  if (hold.state === 'parked') return { text: `parked, ${who} offline`, color: 'yellow' }
  return { text: `held by ${who} ${hold.holder?.online ? 'online' : 'offline'}`, color: undefined }
}

/** A channel tab shows at most this many threads; the web app has the rest. */
export const CHANNEL_CAP = 50

/** A channel tab's rows: open threads first, then resolved, each in the server's order; cut at the cap. */
export function channelRows(threads: ChannelThread[]): { rows: (ChannelThread & { resolved: boolean })[]; more: number } {
  const marked = threads.map(t => ({ ...t, resolved: t.status === 'resolved' }))
  const ordered = [...marked.filter(t => !t.resolved), ...marked.filter(t => t.resolved)]
  return { rows: ordered.slice(0, CHANNEL_CAP), more: Math.max(0, ordered.length - CHANNEL_CAP) }
}

/**
 * `/einweave find`: the lines of `list_threads(takeable)`'s numbered list whose text holds every word,
 * numbers kept -- they are the server-remembered list's, so `/einweave take N` acts on them.
 */
export function findInList(text: string, words: string): string {
  const want = words.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = text.split('\n').filter(l => /^\d+\. /.test(l) && want.every(w => l.toLowerCase().includes(w)))
  if (!/^\d+\. /m.test(text)) return text
  return hits.length ? `${hits.join('\n')}\nTake one with /einweave take N.` : `No takeable thread matches "${words}".`
}

/** The command a second window starts with to take this thread there. */
export function newSessionCommand(threadId: string): string {
  return `claude "/einweave:take ${threadId}"`
}
