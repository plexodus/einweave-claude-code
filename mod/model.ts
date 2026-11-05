/**
 * The einweave mod's rules, kept free of the mods API so the plugin's own `bun test` covers them
 * (test/mod-model.test.ts): what a relay line means, which state the indicator shows, and what each
 * `/einweave` verb calls. mod/register.tsx only wires these to `$`.
 */
import type { ChannelCounts, ChannelsView, ChannelThread, ChannelView, OpenTab, PaneTabs, SearchHit, SearchRefused, SearchSort, SearchState, ThreadMessage, PaneScroll, ThreadView, ThreadWork, UiHeld, UiSnapshot, UiWaitingItem, View } from '../types'
import { cellWidth, docLines, plainLines, type Line } from './text'

/**
 * The design canvas's colours (https://claude.ai/artifact/4JomhfdVJR8goTtoaaqHNR, every board).
 * Accents only: body text and dim text follow the person's theme, so a light terminal stays legible.
 */
export const PALETTE = { brand: '#4cc3ad', amber: '#e8b04a', blue: '#7ab4ff', red: '#f07a7a', pillBg: '#e4e4e4', pillFg: '#121212' } as const

/**
 * Other senders' name colours: none of PALETTE's, which already mean you, new/held, status or error.
 * A shared colour costs only distinction: the name is right there (Jörgen 2026-11-01).
 * Light cyan, not violet: any violet collapses into PALETTE.blue (you) for one red-weak type; cyan stays
 * apart for all three (bridge plan 2026-11-01-mentions.md D2, CVD-simulated).
 */
export const SENDER_HUES = ['#9ce0e8', '#f29ac6', '#a8d672', '#f5a97f'] as const

/** A sender's colour, stable per id (FNV-1a, as the web's agentColor); no id, no colour. */
export function senderColor(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  return SENDER_HUES[h % SENDER_HUES.length]
}

/**
 * The oldest Claude Code that draws this mod. 2.1.299 added `Text`'s `weight` (its changelog: "Added
 * `size`, `weight`, `mono` and `tabular` to a mod's `Text`"); an older engine refuses every tree that
 * names it and draws its own, an empty pane and no band (seen on 2.1.296, 2026-11-03). Raise it when the
 * mod starts using a prop or noun a later release added.
 */
export const MIN_CLAUDE_CODE = '2.1.299'

/**
 * Whether `version` (`$.session.version()`'s `base`, or its `version`) is older than MIN_CLAUDE_CODE.
 * Unknown (absent, or not `x.y.z`) counts as old: the engine that cannot say its version predates the
 * call, and the notice is the one drawing every engine shows.
 */
export function claudeCodeTooOld(version: string | null | undefined): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)
  const have = version ? parse(version) : undefined
  if (!have) return true
  const need = parse(MIN_CLAUDE_CODE)!
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! < need[i]!
  return false
}

/** A run's colour by meaning: an accent, or `dim` (the theme's dim text). */
export type Tone = 'brand' | 'amber' | 'blue' | 'red' | 'dim'

/** One run of a line, in its tone and weight (the canvas: 700 labels and headings, 600 thread titles). */
export interface Seg {
  text: string
  tone?: Tone
  weight?: 'semibold' | 'bold'
}

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
  if (r.ok === true && typeof r.rev === 'number' && isSnapshot(r.state)) return { rev: r.rev, snap: socketChecked(r.state) }
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
  return typeof rev === 'number' && isSnapshot(rest) ? { rev, snap: socketChecked(rest) } : null
}

/** `uiSocket` is a path or nothing: anything else (a plugin that sent junk) reads as no socket, never as a path to fetch. */
function socketChecked(s: UiSnapshot): UiSnapshot {
  return s.uiSocket === undefined || (typeof s.uiSocket === 'string' && s.uiSocket !== '') ? s : { ...s, uiSocket: null }
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

/**
 * The band's and the pane header's state after the `einweave` label (boards Main, Indicator,
 * ConnectFlow): what waits when connected, amber for what is aimed at the person, red when
 * messages are not arriving.
 */
export function stateLine(v: View, now: number): Seg[] {
  const i = indicator(v, now)
  switch (i.kind) {
    case 'connected': {
      const s = v.snap!
      const out: Seg[] = [{ text: `holds ${s.holds.length}` }]
      const w = s.waiting
      if (w?.forYou) out.push({ text: ' · ', tone: 'dim' }, { text: `${w.forYou} for you`, tone: 'amber' })
      if (w?.channel) out.push({ text: ' · ', tone: 'dim' }, { text: `${w.channel} unowned` })
      return out
    }
    case 'reconnecting':
      return [{ text: '↻ reconnecting', tone: 'amber' }]
    case 'disconnected':
      return [{ text: '○ disconnected · messages are not arriving', tone: 'red' }]
    case 'superseded':
      return [{ text: '○ moved to another window · messages arrive there', tone: 'red' }]
    case 'standby':
      return [{ text: 'standby · another window has this session', tone: 'amber' }]
    case 'idle':
      return [{ text: '○ not connected', tone: 'dim' }]
    case 'no-answer':
      return [{ text: 'not answering', tone: 'red' }]
    case 'starting':
      return [{ text: 'starting', tone: 'dim' }]
  }
}

export type Action =
  | { kind: 'pane' }
  | { kind: 'bind'; chord?: string }
  | { kind: 'unbind' }
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'connect' }
  | { kind: 'status'; full: boolean }
  | { kind: 'usage'; text: string }
  | { kind: 'take'; ref: string }
  | { kind: 'search'; words: string }

export const USAGE = [
  '/einweave                       open or close the pane',
  '/einweave bind [chord] | unbind a key that puts the keyboard in the pane, past the band (ctrl+x p)',
  '/einweave status [full]         connection, session and what waits (full: every field)',
  '/einweave connect | disconnect  join or leave einweave in this session',
  '/einweave rename <name>         rename this session ("" clears)',
  '/einweave scope [#a #b|all|none] which unheld work reaches this session',
  '/einweave held                  the threads this session holds, numbered',
  '/einweave release [N|all]       let go of a thread',
  '/einweave handover [N] [to]     move a thread to another session of this agent',
  '/einweave take [N|id]           take a thread for this session (no ref: the numbered list)',
  '/einweave search <words>        search threads and messages (filters: in:#ch from:@who is:open …)',
].join('\n')

/**
 * The engine action a pane Button answers from the prompt. Claude Code has no action that focuses a pane and
 * ctrl+x tab stops at every band Button first (live 2026-11-05); a Button's `action` is pressed by the chord the
 * person bound to it, and that press may give the pane the keyboard. `pane:next` has no default key; inside a
 * pane the engine's own handler takes it, which hands the keyboard back: a toggle.
 */
export const PANE_ACTION = 'pane:next'
/** What `/einweave bind` binds: ctrl+x, as the band's ctrl+x ctrl+a; no default binding has it. */
export const PANE_CHORD = 'ctrl+x p'
/** The keybinding contexts the prompt hears. */
const PROMPT_CONTEXTS: readonly string[] = ['Chat', 'Global']
const KEYS_HEAD = { $schema: 'https://www.schemastore.org/claude-code-keybindings.json', $docs: 'https://code.claude.com/docs/en/keybindings' }

type KeyBlock = { context?: unknown; bindings?: unknown }
type KeyFile = Record<string, unknown> & { bindings?: unknown }

/** keybindings.json's text → its object; null when it is not one Claude Code would read. Absent or blank: an empty one. */
function keyFile(text: string | null): KeyFile | null {
  if (text == null || !text.trim()) return { ...KEYS_HEAD, bindings: [] }
  try {
    const o: unknown = JSON.parse(text)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const f = o as KeyFile
    return f.bindings === undefined || Array.isArray(f.bindings) ? f : null
  } catch {
    return null
  }
}

const promptBlock = (b: unknown): b is { context: string; bindings: Record<string, unknown> } =>
  !!b && typeof b === 'object' && PROMPT_CONTEXTS.includes(String((b as KeyBlock).context)) &&
  !!(b as KeyBlock).bindings && typeof (b as KeyBlock).bindings === 'object' && !Array.isArray((b as KeyBlock).bindings)

/** The chord the person bound to PANE_ACTION where the prompt hears it; null when none (or the file is unreadable). */
export function paneChord(text: string | null): string | null {
  const f = keyFile(text)
  let chord: string | null = null
  for (const b of (f?.bindings as unknown[] | undefined) ?? []) {
    if (!promptBlock(b)) continue
    for (const [k, v] of Object.entries(b.bindings)) if (v === PANE_ACTION) chord = k
  }
  return chord
}

export type KeysEdit =
  | { kind: 'write'; text: string; was: string | null }
  | { kind: 'same'; chord: string | null }
  | { kind: 'taken'; action: string }
  | { kind: 'bad'; why: string }
  | { kind: 'unreadable' }

/** A chord as the person typed it → as keybindings.json spells it: lower case, one space between keystrokes. */
export function normChord(chord: string): string {
  return chord.trim().toLowerCase().split(/\s+/).join(' ')
}

const MODS = new Set(['ctrl', 'control', 'alt', 'opt', 'option', 'meta', 'shift', 'cmd', 'command', 'super', 'win'])
const HOLDS = new Set(['ctrl', 'control', 'alt', 'opt', 'option', 'meta', 'cmd', 'command', 'super', 'win'])
/** Keys a terminal cannot tell apart from another, or that Claude Code keeps (its keybindings docs). */
const RESERVED = new Set(['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+[', 'ctrl+i', 'ctrl+h', 'ctrl+z', 'ctrl+\\'])
/**
 * Claude Code's default keys where the prompt hears them (Global, Chat), from its keybindings list (2.1.318).
 * A bind over one would take that action away; the person's own file is checked as well.
 */
const PROMPT_DEFAULTS: Readonly<Record<string, string>> = {
  'ctrl+t': 'app:toggleTodos', 'ctrl+o': 'app:toggleTranscript', 'ctrl+shift+b': 'app:toggleBrief', 'ctrl+up': 'app:diffFileListUp',
  'meta+up': 'app:diffFileListUp', 'ctrl+down': 'app:diffFileListDown', 'meta+down': 'app:diffFileListDown', 'ctrl+]': 'app:openArtifact',
  'ctrl+r': 'history:search', 'ctrl+x ctrl+k': 'chat:killAgents', 'meta+p': 'chat:modelPicker', 'meta+o': 'chat:fastMode',
  'ctrl+y': 'chat:defaultToNewerModel', 'meta+t': 'chat:thinkingToggle', 'meta+w': 'chat:workflowKeywordToggle', 'ctrl+x enter': 'chat:queueSubmit',
  'ctrl+x ctrl+s': 'chat:sendNow', 'ctrl+enter': 'chat:sendNow', 'ctrl+j': 'chat:newline', 'ctrl+_': 'chat:undo', 'ctrl+-': 'chat:undo',
  'ctrl+shift+-': 'chat:undo', 'ctrl+shift+_': 'chat:undo', 'ctrl+x ctrl+e': 'chat:externalEditor', 'ctrl+g': 'chat:externalEditor',
  'ctrl+s': 'chat:stash', 'ctrl+v': 'chat:imagePaste', 'ctrl+l': 'chat:clearInput', 'cmd+k': 'chat:clearScreen',
  'ctrl+x ctrl+a': 'abovePrompt:toggle', 'ctrl+x tab': 'abovePrompt:focus', 'ctrl+x b': 'app:cycleDiffBase', 'ctrl+x x': 'pane:close',
}

/** Why `chord` cannot be the pane's key; null when it can. Its first keystroke holds a modifier (a bare key types). */
export function chordProblem(chord: string): string | null {
  const strokes = chord.split(' ')
  if (!chord || strokes.length > 2) return 'a key is one or two keystrokes, e.g. ctrl+x p'
  for (const k of strokes) {
    const parts = k.split('+')
    const key = parts.pop()
    if (!key || parts.some(m => !MODS.has(m))) return `"${k}" is not a key: modifiers are ctrl, alt, meta, shift, cmd`
  }
  if (!strokes[0]!.split('+').slice(0, -1).some(m => HOLDS.has(m))) return 'its first keystroke needs ctrl, alt, meta or cmd (a bare key would be typed)'
  if (RESERVED.has(strokes[0]!) && strokes.length === 1) return `${chord} is kept by the terminal or Claude Code`
  if (strokes.length === 1 && Object.keys(PROMPT_DEFAULTS).some(d => d.startsWith(`${chord} `))) return `${chord} starts Claude Code's own chords (${chord} …)`
  return null
}

/**
 * `/einweave bind [chord]`: keybindings.json with `chord` → PANE_ACTION in its Chat block, any earlier one taken
 * out, the rest kept. No chord: PANE_CHORD, unless a key is bound already (the person's choice stands).
 */
export function bindKeys(text: string | null, asked?: string): KeysEdit {
  const chord = asked ?? PANE_CHORD
  const why = chordProblem(chord)
  if (why) return { kind: 'bad', why }
  const f = keyFile(text)
  if (!f) return { kind: 'unreadable' }
  const was = paneChord(text)
  if (was && (was === chord || asked === undefined)) return { kind: 'same', chord: was }
  const blocks = (f.bindings as unknown[] | undefined) ?? []
  for (const b of blocks) if (promptBlock(b) && chord in b.bindings && b.bindings[chord] !== PANE_ACTION && b.bindings[chord] !== null) return { kind: 'taken', action: String(b.bindings[chord]) }
  const unset = blocks.some(b => promptBlock(b) && chord in b.bindings && b.bindings[chord] === null)
  if (PROMPT_DEFAULTS[chord] && !unset) return { kind: 'taken', action: PROMPT_DEFAULTS[chord]! }
  const kept = blocks.map(b => (promptBlock(b) ? { ...b, bindings: Object.fromEntries(Object.entries(b.bindings).filter(([, v]) => v !== PANE_ACTION)) } : b))
  const chat = kept.find(b => promptBlock(b) && b.context === 'Chat')
  const next = chat
    ? kept.map(b => (b === chat ? { ...(b as object), bindings: { ...(b as { bindings: object }).bindings, [chord]: PANE_ACTION } } : b))
    : [...kept, { context: 'Chat', bindings: { [chord]: PANE_ACTION } }]
  return { kind: 'write', text: JSON.stringify({ ...f, bindings: next }, null, 2) + '\n', was }
}

/** `/einweave unbind`: keybindings.json with every prompt chord bound to PANE_ACTION taken out, everything else kept. */
export function unbindKeys(text: string | null): KeysEdit {
  const f = keyFile(text)
  if (!f) return { kind: 'unreadable' }
  if (!paneChord(text)) return { kind: 'same', chord: null }
  const blocks = (f.bindings as unknown[]).map(b =>
    promptBlock(b) ? { ...b, bindings: Object.fromEntries(Object.entries(b.bindings).filter(([, v]) => v !== PANE_ACTION)) } : b,
  )
  return { kind: 'write', text: JSON.stringify({ ...f, bindings: blocks }, null, 2) + '\n', was: paneChord(text) }
}

/** `/einweave <verb> <rest>` → what to do. Every tool named here is the plugin's own. */
export function parseCommand(args: string): Action {
  const trimmed = args.trim()
  const sp = trimmed.search(/\s/)
  const verb = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase()
  const rest = sp < 0 ? '' : trimmed.slice(sp + 1).trim()
  switch (verb) {
    case '':
      return { kind: 'pane' }
    case 'bind':
      return rest ? { kind: 'bind', chord: normChord(rest) } : { kind: 'bind' }
    case 'unbind':
      return { kind: 'unbind' }
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
    case 'search':
      if (!rest) return { kind: 'usage', text: 'Usage: /einweave search <words>' }
      return { kind: 'search', words: rest }
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
  // The canvas's units: `20 s`, `25 min`, `2 h`.
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86_400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86_400)} d`
}

export interface InboxRow {
  threadId: string
  /** Addressed to the person: the band lists only these (board Indicator: "only while something needs you"). */
  aimed: boolean
  title: string
  channel: string
  /** `addressed to you · unheld`, `you took part · holder offline` ... */
  meta: string
  /** `3h`: since the thread's last post; null when the server sent no time. */
  age: string | null
  /** Quiet longer than OLD_MS (the channel tab's "Older" fold; the Inbox has none). */
  old: boolean
  /** Quiet STALE_MS or longer: its age is drawn amber. */
  stale: boolean
  /** Active within BAND_MS: an aimed row only reaches the band while fresh, so old asks stay in the pane. */
  fresh: boolean
}

const WHY: Record<UiWaitingItem['why'], string> = { addressed: 'addressed to you', participant: 'you took part', channel: 'new posts' }
const HOLD: Record<UiWaitingItem['hold'], string> = { unheld: 'unheld', parked: 'holder offline', held: 'held' }

/** Quiet this long, a waiting thread's age is drawn amber (board Unowned: `1 h 10 min` amber, `25 min` not). */
export const STALE_MS = 3_600_000

/** Quiet less than this, a thread aimed at the person shows in the band (Jörgen 2026-10-31; unread replaces it once takeable rows carry it). */
export const BAND_MS = 86_400_000

/** A thread quiet this long folds under "Older (n)". */
export const OLD_MS = 7 * 86_400_000

/** How long since `iso`, and whether that is past OLD_MS; an absent or unreadable time is neither. */
export function quietFor(iso: string | null | undefined, now: number): { age: string | null; old: boolean; stale: boolean } {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? { age: ago(now - t), old: now - t > OLD_MS, stale: now - t >= STALE_MS } : { age: null, old: false, stale: false }
}

/**
 * The Inbox tab: For you (addressed, or taken part in) and Open (new posts in a followed channel),
 * in the snapshot's order -- each newest first, sorted where the rows are cut (ui/ui-state.ts toWaiting).
 */
export function inbox(waiting: UiSnapshot['waiting'], now: number): { forYou: InboxRow[]; open: InboxRow[] } {
  const rows = waiting?.top ?? []
  const row = (w: UiWaitingItem): InboxRow => {
    const t = w.quietSince ? Date.parse(w.quietSince) : NaN
    return { threadId: w.threadId, aimed: w.why === 'addressed', title: w.title, channel: w.channel, meta: `${WHY[w.why]} · ${HOLD[w.hold]}`, ...quietFor(w.quietSince, now), fresh: Number.isFinite(t) && now - t < BAND_MS }
  }
  return { forYou: rows.filter(w => w.why !== 'channel').map(row), open: rows.filter(w => w.why === 'channel').map(row) }
}

/** A Held tab row: as an Inbox row (`#channel Title`), its meta `N new · last @x · age`. */
export interface HeldRowView {
  threadId: string
  title: string
  channel: string | null
  meta: Seg[]
}

/**
 * The Held tab (Jörgen 2026-11-03: as the Inbox): `N new` is what this window was pushed and its model has
 * not confirmed (the server's `unseenByModel`, never the read cursor), brand while there is any; then who
 * posted last; then the age, amber once stale. A row the server's list has not caught up with is its id alone.
 */
export function heldRow(h: UiHeld, now: number): HeldRowView {
  const q = quietFor(h.quietSince, now)
  const parts: Seg[][] = []
  if (h.unseenByModel) parts.push([{ text: `${h.unseenByModel} new`, tone: 'brand', weight: 'semibold' }])
  if (h.lastBy) parts.push([{ text: `last ${h.lastBy}`, tone: 'dim' }])
  if (q.age) parts.push([q.stale ? { text: q.age, tone: 'amber', weight: 'semibold' } : { text: q.age, tone: 'dim' }])
  const meta = parts.flatMap((p, n) => (n ? [{ text: ' · ', tone: 'dim' as const }, ...p] : p))
  return { threadId: h.threadId, title: h.title ?? h.threadId, channel: h.channel ?? null, meta }
}

/** What a window's model is doing, as einweave's `turn` frame says it. */
export type TurnState = 'working' | 'needs_you' | 'idle'

/** Tools that run until the person answers: while one runs, the window waits on its person. */
export const WAITS_ON_PERSON: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** A Claude Code lifecycle event, as the turn state reads it (main loop only for `start` / `end`). */
export type TurnEvent = { kind: 'start' } | { kind: 'end' } | { kind: 'ask' } | { kind: 'tool' } | { kind: 'notification'; type: string }

/**
 * The next turn state, or null for no change. A turn starts working and ends idle (an Esc included);
 * a dialog shown to the person (`permission_prompt`, `elicitation_dialog`) or a tool that waits on them
 * makes it `needs_you`; the next tool call ends that wait. `idle_prompt` (Claude Code: about 60 s after
 * a turn ended, nothing typed) settles idle even when the end was missed.
 */
export function nextTurn(cur: TurnState | null, ev: TurnEvent): TurnState | null {
  switch (ev.kind) {
    case 'start':
      return 'working'
    case 'end':
      return 'idle'
    case 'ask':
      return 'needs_you'
    case 'tool':
      // A tool runs: whatever waited on the person was answered. Idle stays idle: a background subagent's call is not this window's turn.
      return cur === 'needs_you' || cur === null ? 'working' : null
    case 'notification':
      return ev.type === 'permission_prompt' || ev.type === 'elicitation_dialog' ? 'needs_you' : ev.type === 'idle_prompt' ? 'idle' : null
  }
}

/** One window in the Hand over picker (option B, Jörgen 2026-11-05): where it works, what it is doing, what it holds. */
export interface PickerRow {
  id: string
  /** Its own name, else `folder · branch` (a branch equal to its folder dropped), else its label. */
  place: string
  /** What its model is doing (`needs you`, `working`, `idle 12 min`); null when its client reports none. */
  state: Seg | null
  /** `holds <title>` (`+N` for more), else `#<id> · holds nothing`. */
  holds: string
}

type PickerSession = NonNullable<UiSnapshot['sessions']>[number]

/** Under this long idle, the word alone: `idle 20 s` reads as noise. */
const IDLE_BARE_MS = 60_000

const TURN_RANK: Record<string, number> = { needs_you: 0, working: 1, idle: 2 }

/**
 * The Hand over picker's windows: online only (a thread handed to a closed window waits there unanswered;
 * New window covers that), the offline ones counted. Ordered by what each is doing, the way agent dashboards
 * do (Claude Code agent view, iTerm2): needs you, then working, then idle (the shortest idle first), then
 * those that report nothing, in the server's order. Never a heartbeat age: an online window is here now.
 */
export function pickerRows(sessions: UiSnapshot['sessions'], now: number): { rows: PickerRow[]; offline: number } {
  const all = sessions ?? []
  const online = all.filter(s => s.online)
  const rank = (s: PickerSession) => TURN_RANK[s.activity?.state ?? ''] ?? 3
  const since = (s: PickerSession) => {
    const t = s.activity ? Date.parse(s.activity.since) : NaN
    return Number.isFinite(t) ? t : -Infinity
  }
  const ordered = online
    .map((s, n) => ({ s, n }))
    .sort((a, b) => rank(a.s) - rank(b.s) || (rank(a.s) < 3 ? since(b.s) - since(a.s) : 0) || a.n - b.n)
    .map(({ s }) => s)
  return { rows: ordered.map(s => pickerRow(s, now)), offline: all.length - online.length }
}

function pickerRow(s: PickerSession, now: number): PickerRow {
  const place = s.name || (s.folder ? (s.branch && s.branch !== s.folder ? `${s.folder} · ${s.branch}` : s.folder) : s.label)
  const a = s.activity
  const t = a ? Date.parse(a.since) : NaN
  const state: Seg | null = !a
    ? null
    : a.state === 'needs_you'
      ? { text: 'needs you', tone: 'amber', weight: 'semibold' }
      : a.state === 'working'
        ? { text: 'working', tone: 'brand' }
        : { text: Number.isFinite(t) && now - t >= IDLE_BARE_MS ? `idle ${ago(now - t)}` : 'idle', tone: 'dim' }
  const h = s.holds ?? { title: null, count: 0 }
  const short = `#${s.id.slice(-4)}`
  const holds = h.title
    ? `holds ${h.title}${h.count > 1 ? ` +${h.count - 1}` : ''}`
    : h.count > 0
      ? `${short} · holds ${h.count} thread${h.count === 1 ? '' : 's'}`
      : `${short} · holds nothing`
  return { id: s.id, place, state, holds }
}

/** A list split for drawing: the recent rows in their order, then those under the "Older" fold. */
export function fold<T extends { old: boolean }>(rows: T[]): { recent: T[]; older: T[] } {
  return { recent: rows.filter(r => !r.old), older: rows.filter(r => r.old) }
}

/** The record a pane element belongs to: `mark:<id>`, `open:<id>`, `take:<id>` ... → `<id>`; '' for any other element. */
export function recordOf(element: string | undefined): string {
  const m = element && /^(mark|open|take|new|release|join|handover):(.+)$/.exec(element)
  return m ? m[2]! : ''
}

/**
 * Where the pane's focus ring lands. Records' marks (and the "Older" folds between them) are its only
 * stops: a record's title and actions are pressable by the pointer but no stop. The ring moves linearly
 * like Tab, so a move onto a record's title or action goes on to the stop after that record when it came
 * from that record (moving down) and back to the record's own mark otherwise (moving up). After the last
 * stop they are left as they are: past them the ring goes on to what follows the list (the footer).
 * `stops` are the stop keys drawn, top to bottom; `last` where the ring was.
 */
export function focusTarget(stops: readonly string[], last: string, element: string | undefined): string | undefined {
  // The Inbox search field's filler (a click target, never a stop): from the field the move was
  // forward, on to the first record; from anywhere else it was back, into the field (live check 2026-11-03).
  if (element === SEARCH_FILL) return last === SEARCH_FIELD ? (stops[0] ?? SEARCH_FIELD) : SEARCH_FIELD
  const m = element && /^(open|take|new|release|join|handover):(.+)$/.exec(element)
  if (!m) return element
  const id = m[2]!
  const at = stops.indexOf(`mark:${id}`)
  if (at < 0) return element
  if (recordOf(last) !== id) return `mark:${id}`
  return stops[at + 1] ?? element
}

/**
 * Where an arrow key (`by` ±1) takes the pane's focus ring on a list: the stop before or after the one the
 * keyboard is on (a record's action counts as its mark), or down onto the first from the Inbox search field or nowhere.
 * `undefined` means the arrow scrolls a row as before: a tab with no stops (the thread tab, read, not picked
 * from), the keyboard off the stops (the footer), or past the first or last stop (the rows beyond stay reachable).
 */
export function arrowTarget(stops: readonly string[], last: string, by: number): string | undefined {
  if (!stops.length) return undefined
  if (!last || last === SEARCH_FIELD) return by > 0 ? stops[0] : undefined
  const id = recordOf(last)
  const at = stops.indexOf(id ? `mark:${id}` : last)
  if (at < 0) return undefined
  return stops[at + Math.sign(by)]
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
    const o = JSON.parse(text) as { thread?: { title?: string | null; status?: string | null; work?: ThreadWork | null }; channel?: string | null; messages?: ThreadView['messages']; has_older?: boolean; older_count?: number | null }
    if (!o || !Array.isArray(o.messages)) throw new Error('no messages')
    const older = o.has_older !== true ? 0 : typeof o.older_count === 'number' ? o.older_count : null
    const work = o.thread?.work && typeof o.thread.work === 'object' && Array.isArray(o.thread.work.fields) ? { work: o.thread.work } : {}
    return { title: o.thread?.title ?? null, channel: o.channel ?? null, status: o.thread?.status ?? null, messages: o.messages, ...work, older, error: null, loading: false }
  } catch {
    return { title: null, status: null, messages: [], older: 0, error: text || 'ui_thread answered nothing', loading: false }
  }
}

/**
 * A post's lines: the server's doc when `ui_thread` handed one over, else its `content` as typed (G11).
 * `links` false: the terminal draws no OSC 8 links (links.ts), so URLs go in rows of their own.
 */
export function threadLines(m: ThreadMessage, width: number, links = true): Line[] {
  return Array.isArray(m.doc) ? docLines(m.doc, width, { links }) : plainLines(m.content, width)
}

/** A post shows this many lines until it is opened (Thread tab, layout A, decision 2026-10-31). */
export const POST_CAP = 6
/** Replies one Load older brings. */
export const OLDER_PAGE = 20

/** A post's stable name across reads: its seq, or the root. */
export function postKey(m: ThreadMessage, n: number): string {
  return m.root ? 'root' : m.seq != null ? `s${m.seq}` : `i${n}`
}

/**
 * One post as drawn: its lines (cut at the cap unless opened), how many the cap hid, and its rows from the top.
 * A work item's root draws its header first as blocks of their own (RFC-029 D2): `filed` (who filed it, when),
 * then a block per field under its label, then the missing ones; absent `head`, a post under its sender row.
 */
export interface PostBlock {
  key: string
  n: number
  head?: 'filed' | { label: string; missing?: true }
  /** A blank row above it: between posts, never inside an item's header. */
  space: boolean
  lines: Line[]
  /** Every line, the cap ignored: what a surface that scrolls itself (a desktop) draws. */
  all: Line[]
  more: number
  top: number
  rows: number
}

/** A thread's posts laid out at a width, row by row, so the pane can scroll them itself. */
export interface ThreadLayout {
  blocks: PostBlock[]
  /** The "older replies" row under the root, where Load older brings them; null with none. */
  gap: { top: number; rows: number } | null
  total: number
}

/**
 * Posts in chat order (oldest first): a blank row between posts, the sender row, the lines (POST_CAP
 * of them unless `open`), and a "N more lines" row where the cap cut. With replies older than those
 * read, the gap row sits under the root, a blank row above it.
 */
export function threadLayout(messages: readonly ThreadMessage[], width: number, open: Record<string, true>, older: number | null, links = true, work: ThreadWork | null = null): ThreadLayout {
  const blocks: PostBlock[] = []
  let gap: ThreadLayout['gap'] = null
  let row = 0
  const add = (key: string, n: number, all: Line[], space: boolean, head?: PostBlock['head']) => {
    const cut = !open[key] && all.length > POST_CAP + 1
    const lines = cut ? all.slice(0, POST_CAP) : all
    const more = cut ? all.length - POST_CAP : 0
    const rows = (space ? 1 : 0) + 1 + lines.length + (more ? 1 : 0)
    blocks.push({ key, n, ...(head ? { head } : {}), space, lines, all, more, top: row, rows })
    row += rows
  }
  messages.forEach((m, n) => {
    const key = postKey(m, n)
    const all = threadLines(m, width, links)
    if (m.root && work) {
      // As the web: the header, then the root. Fields are plain text with their line breaks, each capped as a post.
      add('filed', n, [], blocks.length > 0, 'filed')
      for (const f of work.fields) add(`f:${f.key}`, n, plainLines(f.value, width), false, { label: f.label })
      if (work.missing.length) add('missing', n, [], false, { label: `Missing: ${work.missing.join(', ')}`, missing: true })
      // An empty root is not a post: `filed` names its author and time.
      if (all.length) add(key, n, all, true)
    } else add(key, n, all, blocks.length > 0)
    if (m.root && older !== 0 && n < messages.length - 1) {
      gap = { top: row, rows: 2 }
      row += 2
    }
  })
  return { blocks, gap, total: row }
}

/**
 * THE PANE'S ONE WINDOW (every tab, plan 2026-11-04-mod-pinned-every-tab-plan.md). A tab's body is a stack
 * of blocks of known rows; the pane shows `room` of them under its pinned head, over its pinned key bar.
 * `off` counts rows up from the stack's END (0: the end shows), as the thread tab always did: rows added
 * above the window then never move it. A thread lands at its first new post (chat: anchored at the end);
 * a list lands at its top and, while there, follows it as rows arrive (anchored at the top).
 */
export interface StackBlock {
  key: string
  top: number
  rows: number
  /** A keyboard stop (a record, a button). */
  stop?: boolean
  /** A section's heading ("For you", "Unowned", "Similar titles"): revealed with its first record. */
  section?: boolean
  /** A blank row on top of the block (counted in `rows`). */
  space?: boolean
}
export interface Stack {
  blocks: readonly StackBlock[]
  total: number
}
export type Anchor = 'top' | 'end'

/** Blocks one under another, each `rows` tall: their tops and the stack's height. */
export function stack<B extends { key: string; rows: number }>(blocks: readonly B[]): { blocks: (B & { top: number })[]; total: number } {
  let row = 0
  const out = blocks.map(b => {
    const top = row
    row += b.rows
    return { ...b, top }
  })
  return { blocks: out, total: row }
}

/** The window's highest offset: rows up from the end at which the top shows. */
const maxOff = (l: Stack, room: number) => Math.max(0, l.total - room)

/** Where a thread tab first opens: its first new post at the top of the window, else the newest. */
export function landOff(l: ThreadLayout, messages: readonly ThreadMessage[], room: number): number {
  const first = l.blocks.find(b => messages[b.n]?.new)
  if (!first) return 0
  // Its blank row above it stays out of view.
  const top = first.top + (first.space ? 1 : 0)
  return Math.min(maxOff(l, room), Math.max(0, l.total - room - top))
}

/**
 * The window now, on any tab: where it lands while the person has not moved it (`land`; a list's is its
 * top); a list scrolled to its top stays there as rows arrive; else their place, kept when blocks came after
 * the one that was last (a live thread), clamped to what fits.
 */
export function windowOff(sc: PaneScroll | undefined, l: Stack, room: number, land: number, anchor: Anchor): number {
  const max = maxOff(l, room)
  if (!sc) return Math.min(max, Math.max(0, land))
  if (anchor === 'top' && sc.top) return max
  let off = sc.off
  if (off > 0) {
    const at = l.blocks.findIndex(b => b.key === sc.newest)
    if (at >= 0) off += l.blocks.slice(at + 1).reduce((a, b) => a + b.rows, 0)
  }
  return Math.min(max, Math.max(0, off))
}

/** The window moved `by` rows (negative toward the top), and whether it now shows the top. */
export function scrollBy(off: number, by: number, l: Stack, room: number): { off: number; atTop: boolean } {
  const max = maxOff(l, room)
  const next = Math.min(max, Math.max(0, off - by))
  return { off: next, atTop: next >= max }
}

/**
 * The heading of the section block `key` opens: up from it over rows that are no stop (Unowned's gateway
 * line) to a `section` block. None when a stop comes first (not the section's first record) or none is there.
 */
export function leadOf(l: Stack, key: string): StackBlock | undefined {
  const at = l.blocks.findIndex(b => b.key === key)
  for (let n = at - 1; n >= 0; n--) {
    const b = l.blocks[n]!
    if (b.section) return b
    if (b.stop) return undefined
  }
  return undefined
}

/**
 * The smallest move that shows block `key` whole (its top, when taller than the window); `off` when it shows
 * or is not there. A section's first record brings its heading along when both fit (the heading says which
 * list the record is in; Jörgen 2026-11-04); when they do not, the record alone, as any other.
 */
export function revealOff(l: Stack, key: string, off: number, room: number): number {
  const b = l.blocks.find(x => x.key === key)
  if (!b) return off
  const first = l.total - room - off
  const lead = leadOf(l, key)
  // The heading's own blank row above it stays out of view.
  const withLead = lead ? lead.top + (lead.space ? 1 : 0) : undefined
  const top = withLead !== undefined && b.top + b.rows - withLead <= room ? withLead : b.top
  const bottom = b.top + Math.min(b.rows, room)
  const next = top < first ? l.total - room - top : bottom > first + room ? l.total - bottom : off
  return Math.min(maxOff(l, room), Math.max(0, next))
}

/** Rows hidden above and below the window: the key bar's `↑ n · ↓ n`. */
export function hidden(l: Stack, off: number, room: number): { above: number; below: number } {
  if (l.total <= room) return { above: 0, below: 0 }
  return { above: Math.max(0, l.total - room - off), below: Math.max(0, off) }
}

/** The key bar's scroll cue: only the sides that hide rows; '' when everything shows. */
export function cueText(h: { above: number; below: number }): string {
  return [h.above ? `↑ ${h.above}` : '', h.below ? `↓ ${h.below}` : ''].filter(Boolean).join(' · ')
}

/** The last block's key, what PaneScroll.newest records. */
export const newestKey = (l: Stack) => l.blocks.at(-1)?.key ?? ''

/**
 * Rows a wrapping row takes at `width`: each item `widths[n]` cells, `gap` cells between, greedy as
 * flex-wrap lays them out (the tabs, the pane's header, a row of suggestions).
 */
export function tabRows(widths: readonly number[], width: number, gap = 1): number {
  let rows = 1
  let x = 0
  for (const w of widths) {
    if (x > 0 && x + gap + w > width) {
      rows++
      x = w
    } else x += (x > 0 ? gap : 0) + w
  }
  return rows
}

/** A tab's label cut as the tab row draws it. */
export const tabLabel = (title: string) => (title.length > 18 ? `${title.slice(0, 17)}…` : title)

/** Cells a tab takes in the row: its label padded a cell each side, an opened tab's `× ` after it (shown or not). */
export const tabWidth = (label: string, closable: boolean) => cellWidth(label) + 2 + (closable ? 2 : 0)

/**
 * An opened tab's hover on the terminal, on its label and its × alike: one group per tab, so the pointer on
 * either draws both as the pointer draws a fixed tab (inverse, full strength) and the × reads as the tab's own.
 * Their dim is the Texts', never the Buttons': a dimColor Button keeps its lit Text grey (live 2026-11-03).
 */
export const tabLit = (id: string) => ({ scope: `tab:${id}`, inverse: true, dimColor: false }) as const

/** Prepend an older page's replies (the root dropped: the tab has it) to what the tab shows. */
export function withOlder(t: ThreadView, page: ThreadView): ThreadView {
  const have = new Set(t.messages.map(m => m.seq).filter(s => s != null))
  const older = page.messages.filter(m => !m.root && !(m.seq != null && have.has(m.seq)))
  const root = t.messages[0]?.root ? [t.messages[0]] : []
  const rest = root.length ? t.messages.slice(1) : t.messages
  return { ...t, messages: [...root, ...older, ...rest], older: page.older, loadingOlder: false }
}

/**
 * A fresh read (the newest page) over what the tab shows: the older pages loaded before are kept
 * under it, so a held thread's live read does not undo Load older.
 */
export function refreshed(t: ThreadView | undefined, page: ThreadView): ThreadView {
  const first = olderCursor(page)
  if (!t || page.error || first === null) return page
  const kept = t.messages.filter(m => !m.root && m.seq != null && m.seq < first)
  if (!kept.length) return page
  const root = page.messages[0]?.root ? [page.messages[0]] : []
  return { ...page, messages: [...root, ...kept, ...page.messages.slice(root.length)], older: t.older }
}

/** The seq Load older pages back from: the oldest reply shown. */
export const olderCursor = (t: ThreadView) => t.messages.find(m => !m.root && m.seq != null)?.seq ?? null

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

/** A channel row's meta: `2 waiting · oldest 3h · 4 open`; "counts unknown" when the server did not say (never 0). */
export function channelMeta(c: ChannelCounts | undefined, now: number): string {
  if (!c) return 'counts unknown'
  // Board ChannelsTab: `12 open · 2 unowned · oldest waiting 2 h`.
  const parts = [`${c.open} open`]
  const w = waitingIn(c)
  if (w) parts.push(`${w} unowned`)
  if (w && c.oldestWaitingAt && Number.isFinite(Date.parse(c.oldestWaitingAt))) parts.push(`oldest waiting ${ago(now - Date.parse(c.oldestWaitingAt))}`)
  return parts.join(' · ')
}

/** Who holds a thread, for its row: here, another session (online or not), or nobody. Absent hold (older server): null. */
export function holdBadge(hold: ChannelThread['hold'], heldHere: boolean): { text: string; tone: Tone | undefined; asks: boolean } | null {
  // Board ChannelsTab: brand for yours, amber for nobody's, dim for another session's.
  if (heldHere) return { text: 'held by you', tone: 'brand', asks: false }
  if (!hold) return null
  const who = hold.holder?.label ?? 'another session'
  if (hold.state === 'unheld') return { text: 'unheld', tone: 'amber', asks: false }
  if (hold.state === 'parked' || !hold.holder?.online) return { text: `held by ${who} · offline`, tone: 'dim', asks: false }
  // From an online holder, Take asks the person first: the button says so.
  return { text: `held by ${who} · online`, tone: 'dim', asks: true }
}

/** A channel tab shows at most this many threads; the web app has the rest. */
export const CHANNEL_CAP = 50

/** A channel tab's rows: open threads first, then resolved, each in the server's order; cut at the cap. */
export function channelRows(threads: ChannelThread[]): { rows: (ChannelThread & { resolved: boolean })[]; more: number } {
  const marked = threads.map(t => ({ ...t, resolved: t.status === 'resolved' }))
  const ordered = [...marked.filter(t => !t.resolved), ...marked.filter(t => t.resolved)]
  return { rows: ordered.slice(0, CHANNEL_CAP), more: Math.max(0, ordered.length - CHANNEL_CAP) }
}

/** One search hit as the plugin's `/search` route answers it (server.ts `searchPage`): a thread row, or a message row (`message_id` + `thread_title`). */
export type { SearchHit, SearchRefused, SearchSort, SearchState, SearchType } from '../types'

export const NO_SEARCH: SearchState = { q: '', type: 'threads', sort: 'relevance', seq: 0, loading: false, rows: [], total: null, next: null, refused: null, error: null, applied: null }

/** The `/search` route's answer (or the `ui_search` tool's) as state: a page, a refusal, or the error text it was. */
export function searchAnswer(raw: string): Pick<SearchState, 'rows' | 'total' | 'next' | 'refused' | 'error' | 'applied'> {
  const none = { rows: [], total: null, next: null, refused: null, applied: null }
  let page: { refused?: SearchRefused; results?: SearchHit[]; total?: { count: number; capped: boolean }; next?: string | null; query?: { text?: string; sort?: string } }
  try {
    page = JSON.parse(raw)
  } catch {
    return { ...none, error: raw.trim() || 'search answered nothing' }
  }
  if (page.refused) return { ...none, refused: page.refused, error: null }
  const applied = page.query ? { sort: (page.query.sort === 'newest' ? 'newest' : 'relevance') as SearchSort, words: !!page.query.text?.trim() } : null
  return { rows: page.results ?? [], total: page.total ?? null, next: page.next ?? null, refused: null, error: null, applied }
}

/** A suggestion pressed (`in:#ops` for the refused `in:#opz`): the query with that token replaced, or the suggestion added. */
export function applySuggestion(q: string, token: string | null, suggestion: string): string {
  if (token && q.includes(token)) return q.replace(token, suggestion)
  return `${q.trim()} ${suggestion}`.trim()
}

/**
 * The search field's placeholder, padded with no-break spaces to `width` columns: an Input is as
 * wide as its text, and only the field itself takes a click from anywhere (a button's focus request
 * waits while the pane does not hold the keyboard — measured live 2026-11-04). So the empty field
 * IS the whole box. No-break spaces: trailing plain ones may be trimmed.
 */
export const SEARCH_HINT = 'words, "a phrase", in:#channel, from:@person, is:open'
export function searchPlaceholder(width: number): string {
  return SEARCH_HINT + '\u00A0'.repeat(Math.max(0, width - SEARCH_HINT.length))
}

/** The Inbox search field's key, and the blank after it that makes the whole box a click target. */
export const SEARCH_FIELD = 'search'
export const SEARCH_FILL = 'search-fill'

/** A snippet's runs on one line: newlines and runs of spaces from the message become one space each. */
export function oneLine(parts: { text: string; hit: boolean }[]): { text: string; hit: boolean }[] {
  const out = parts.map(p => ({ ...p, text: p.text.replace(/\s+/g, ' ') })).filter(p => p.text !== '')
  if (out.length) {
    out[0] = { ...out[0]!, text: out[0]!.text.trimStart() }
    out[out.length - 1] = { ...out[out.length - 1]!, text: out[out.length - 1]!.text.trimEnd() }
  }
  return out.filter(p => p.text !== '')
}

/**
 * A snippet's runs cut to `width` columns, the first hit always in view: up to a third of the width
 * of context before it ("…" where text was cut), then as much as fits ("…" at the end if cut).
 *
 * WHY HERE, not the layout's clipping: a row of styled runs wider than the pane was drawn with each
 * later run starting early, over the end of the one before ("is being deployed" read "is
 * deploye"; live check 2026-11-04, twice). A line that already fits is drawn right.
 * Width is counted in code points: one column each for the sv/en text this carries.
 */
export function fitSnippet(parts: { text: string; hit: boolean }[], width: number): { text: string; hit: boolean }[] {
  // One entry per code point, so a window can start and end anywhere.
  const cells = parts.flatMap(p => [...p.text].map(ch => ({ ch, hit: p.hit })))
  if (width < 3 || cells.length <= width) return parts
  const firstHit = Math.max(0, cells.findIndex(c => c.hit))
  // Start a third of the width before the first hit, never past the point where the rest just fits;
  // then forward to the next word's start (never past the hit), so the line opens on a whole word.
  let start = Math.max(0, Math.min(firstHit - Math.floor(width / 3), cells.length - width))
  if (start > 0 && cells[start - 1]!.ch !== ' ') {
    let w = start
    while (w < firstHit && cells[w]!.ch !== ' ') w++
    if (w < firstHit) start = w + 1
  }
  const cutStart = start > 0
  const end = Math.min(cells.length, start + width - (cutStart ? 1 : 0))
  const cutEnd = end < cells.length
  const window = cells.slice(start, cutEnd ? end - 1 : end)
  const out: { text: string; hit: boolean }[] = []
  for (const c of window) {
    const last = out[out.length - 1]
    if (last && last.hit === c.hit) last.text += c.ch
    else out.push({ text: c.ch, hit: c.hit })
  }
  if (cutStart) out.unshift({ text: '…', hit: false })
  if (cutEnd) out.push({ text: '…', hit: false })
  return out
}

/** Seconds of quiet before a typed query is sent: a pause, not every key. */
export const SEARCH_DEBOUNCE_MS = 250

/**
 * `/einweave search <words>`: the `/search` page (RFC-031) as text: one line per thread with where it
 * matched, its id to take it by. A refusal is its own sentence; a non-JSON answer (an error) passes
 * through. Text, not a list to number: `take N` keeps meaning the takeable list.
 */
export function searchText(raw: string, words: string): string {
  let page: { refused?: { message?: string }; results?: SearchHit[]; total?: { count: number; capped: boolean } }
  try {
    page = JSON.parse(raw)
  } catch {
    return raw
  }
  if (page.refused) return page.refused.message ?? 'Search refused.'
  const rows = page.results ?? []
  if (!rows.length) return `Nothing matches "${words}". Try fewer words, or drop a filter.`
  const n = page.total ? `${page.total.count}${page.total.capped ? '+' : ''}` : String(rows.length)
  const lines = rows.map(r => {
    const snippet = r.snippet_parts.map(p => p.text).join('').replace(/\s+/g, ' ').trim()
    const where = r.similar_title ? 'similar title' : r.matching_replies ? `${r.matching_replies} ${r.matching_replies === 1 ? 'reply matches' : 'replies match'}` : ''
    const head = `${r.channel ? `#${r.channel} · ` : ''}${r.title ?? '(untitled)'}`
    const tail = [snippet && snippet !== r.title ? `"${snippet}"` : '', where].filter(Boolean).join(' · ')
    return `${head}${tail ? ` — ${tail}` : ''}\n   ${r.thread_id}`
  })
  return `${n} for "${words}":\n${lines.join('\n')}\nTake one with /einweave take <id>.`
}

/** The command a second window starts with to take this thread there. */
export function newSessionCommand(threadId: string): string {
  return `claude "/einweave:take ${threadId}"`
}
