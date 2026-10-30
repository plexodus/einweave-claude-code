/**
 * The einweave mod's rules, kept free of the mods API so the plugin's own `bun test` covers them
 * (test/mod-model.test.ts): what a relay line means, which state the indicator shows, and what each
 * `/einweave` verb calls. mod/register.tsx only wires these to `$`.
 */
import type { UiSnapshot, View } from '../types'

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

export const USAGE = [
  '/einweave                       open the pane',
  '/einweave status [full]         connection, session and what waits (full: every field)',
  '/einweave connect | disconnect  join or leave einweave in this session',
  '/einweave rename <name>         rename this session ("" clears)',
  '/einweave scope [#a #b|all|none] which unheld work reaches this session',
  '/einweave held                  the threads this session holds, numbered',
  '/einweave release [N|all]       let go of a thread',
  '/einweave handover [N] [to]     move a thread to another session of this agent',
  'Take a thread with /einweave:take.',
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
