/**
 * The einweave mod (plan 2026-10-25-terminal-ui.md, Phase 2): a band above the prompt (what waits, or
 * what went wrong, and Show / Hide), the pane (inbox, held threads, channels, session) and one command, `/einweave [verb]`.
 *
 * Data: this plugin's own MCP server is the single source. ui/ctl-watch.ts, started here for the
 * session's life, relays the control socket's `watch` stream (a snapshot per change); `ui_state`
 * answers the first draw, a re-read after /clear, and every minute while the relay is down.
 * Every action calls one of the plugin's tools: no model turn, no tokens.
 */
import { atom, read, update } from 'claude-code'
import type { ButtonProps, EngineInterface, Register } from 'claude-code'

import type { ChannelView, OpenTab, ThreadMessage, ThreadScroll, ThreadView, UiSnapshot } from '../types'
import {
  applySnapshot, channelMeta, claudeCodeTooOld, MIN_CLAUDE_CODE, channelRows, channelsView, channelView, closeTab, EMPTY_TABS, EMPTY_VIEW, findInList, focusTarget, fold, fromTool, holdBadge, inbox,
  indicator, needsBand, newestKey, newSessionCommand, NO_CHANNELS, OLDER_PAGE, olderCursor, openTab, PALETTE, parseCommand, parseLine, quietFor, recordOf, refreshed, scopeText, senderColor,
  scrollBy, shownTab, stateLine, statusSummary, tabLabel, tabRows, tabWidth, takeOutcome, textOf, threadLayout, threadOff, threadView, withOlder, BAND_GRACE_MS,
  type InboxRow, type Seg, type ThreadLayout, type Tone,
} from './model'
import type { Line } from './text'
import { hyperlinks } from './links'

const SERVER = 'plugin:einweave:einweave'
const PANE = 'einweave'
const RELAY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000]
const POLL_MS = 60_000
const SETTLE_MS = 10_000
const SETTLE_STEP_MS = 500
/** A held thread's open tab reads again this often: replies to it come to this session, so the tab is live. */
const HELD_TAB_MS = 15_000
/** The band lists at most this many threads aimed at the person; the pane has the rest. */
const BAND_ROWS = 3

const view = atom({ plugin: 'einweave', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-1' })
const tabs = atom({ plugin: 'einweave', key: 'tabs' } as const, EMPTY_TABS, { shape: 'tabs-2' })
const threads = atom({ plugin: 'einweave', key: 'threads' } as const, {} as Record<string, ThreadView>, { shape: 'threads-1' })
const channels = atom({ plugin: 'einweave', key: 'channels' } as const, NO_CHANNELS, { shape: 'channels-1' })
const channel = atom({ plugin: 'einweave', key: 'channel' } as const, {} as Record<string, ChannelView>, { shape: 'channel-1' })
/** Which record the keyboard is on (or was, when Escape handed the keyboard back): its mark, its title lit, its actions in the footer. */
const focused = atom({ plugin: 'einweave', key: 'focused' } as const, '', { shape: 'focused-1' })
/** Set as the pane opens or closes, so the band redraws; its Show / Hide reads the engine's own record. */
const paneUp = atom({ plugin: 'einweave', key: 'paneUp' } as const, false, { shape: 'pane-up-1' })
/** The "Older" folds opened, by list. */
const unfolded = atom({ plugin: 'einweave', key: 'unfolded' } as const, {} as Record<string, boolean>, { shape: 'unfolded-1' })
/** Each thread tab's own window over its posts, once the person moved it, and the posts opened past the cap. */
const scrolls = atom({ plugin: 'einweave', key: 'scrolls' } as const, {} as Record<string, ThreadScroll>, { shape: 'scrolls-1' })
/** A record's dim meta under the pointer: a shade lighter, its only background the pane's. */
const META_LIT = '#b8b8b8'
/** The pane's subtle rules: under the tabs, over the footer. */
const RULE = '#3a3d40'
/** The pane's side margin, a column each side: the band's own inside its border (Jörgen 2026-10-31). */
const PANE_PAD = 1
/** The mark left on the record the keyboard was on once Escape handed the keyboard back: where it lands on return. */
const MARK_AWAY = '#4a4a4a'
const NO_THREAD: ThreadView = { title: null, status: null, messages: [], older: 0, error: null, loading: true }
const NO_CHANNEL: ChannelView = { threads: [], error: null, loading: true }

/** A run's Text props for its tone: an accent from the canvas, or the theme's dim. */
const paint = (tone: Tone | undefined) => (tone === 'dim' ? { dimColor: true } : tone ? { color: PALETTE[tone] } : {})

/**
 * One of the pane's reads, as the MCP tool's result. Over the plugin's UI socket when the snapshot names one
 * (`$.http.fetch` with `socketPath`, whole): the host cuts a tool result at its MODEL-facing output limit, and a long
 * thread page came back as an error (88,741 chars, 2026-11-03). A refusal of the fetch itself (no socket any more,
 * a policy) falls back to the MCP tool for that call, which keeps its size budget; an answer, even an error, stands.
 * `ui_state` itself stays MCP: small, the call that tells the mod the socket's path, and the probe that the plugin process is up.
 */
async function uiRead($: EngineInterface, path: string, query: Record<string, number>, tool: string, args: Record<string, string | number>) {
  const socketPath = (await read($, view)).snap?.uiSocket
  if (socketPath) {
    try {
      const qs = Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&')
      const r = await $.http.fetch(`http://einweave${path}${qs ? `?${qs}` : ''}`, { socketPath })
      if (r.ok) return { isError: false, content: [{ type: 'text' as const, text: r.text }] }
      let error = ''
      try {
        error = String((JSON.parse(r.text) as { error?: unknown }).error ?? '')
      } catch {}
      return { isError: true, content: [{ type: 'text' as const, text: error || `${tool} failed (HTTP ${r.status})` }] }
    } catch {}
  }
  return $.mcp.call(SERVER, tool, args)
}

/** Take a snapshot into the view; a drop that starts now redraws once its grace period has passed. */
async function take($: EngineInterface, got: { rev: number; snap: UiSnapshot }, restart: boolean, live?: boolean): Promise<void> {
  const now = await $.clock.now()
  const wasDown = (await read($, view)).downSince !== null
  await update($, view, v => ({ ...applySnapshot(v, got.rev, got.snap, now, restart), ...(live === undefined ? {} : { live }) }))
  if (!wasDown && got.snap.connection.state === 'disconnected') $.clock.after(BAND_GRACE_MS + 50, () => void update($, view, v => ({ ...v })))
}

/** Read ui_state once: first draw, after /clear, and while the relay is down. */
async function poll($: EngineInterface, restart = false): Promise<void> {
  try {
    // The first draw runs while the server is still starting: wait for it, or the read fails and says "not answering".
    const c = await $.mcp.connect('einweave')
    if (!c.isConnected) return void (await update($, view, v => ({ ...v, error: c.message })))
    const r = await $.mcp.call(c.server, 'ui_state', {})
    const got = r.isError ? null : fromTool(r)
    if (got) await take($, got, restart)
    else await update($, view, v => ({ ...v, error: r.isError ? textOf(r) || 'ui_state failed' : 'ui_state answered no snapshot' }))
  } catch (err) {
    await update($, view, v => ({ ...v, error: String(err).slice(0, 200) }))
  }
}

async function connect($: EngineInterface): Promise<string> {
  const r = await $.mcp.call(SERVER, 'connect', {})
  let text = textOf(r)
  await poll($)
  if ((await read($, view)).snap?.connection.state === 'standby') {
    let answer = 'Leave it'
    try {
      answer = await $.ui.ask('Another window has this einweave session. Take it over here?', ['Take it over', 'Leave it'])
    } catch {}
    if (answer === 'Take it over') text = textOf(await $.mcp.call(SERVER, 'connect', { takeover: 'lock' }))
  }
  return text.startsWith('connecting') ? settled($) : text
}

/** Opens the pane, or closes it while it is the one shown: `/einweave` and the band's button. */
async function togglePane($: EngineInterface): Promise<{ isPlaced: boolean } | null> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isShown) {
    await $.ui.close({ id: PANE })
    // The plugin's own close does not come back through its own ui.close hook: say it here.
    await update($, paneUp, () => false)
    return null
  }
  const opened = await $.ui.open({ id: PANE, title: 'einweave' })
  await update($, paneUp, () => true)
  return opened
}

/** Take this session back from the window that took it over: the person pressed for it, so no question. */
async function takeBack($: EngineInterface): Promise<string> {
  const text = textOf(await $.mcp.call(SERVER, 'connect', { takeover: 'lock' }))
  return text.startsWith('connecting') ? settled($) : text
}

/** `connect` answers before the socket has signed in ("connecting"): wait for the state to settle, then say that. */
async function settled($: EngineInterface): Promise<string> {
  for (let waited = 0; ; waited += SETTLE_STEP_MS) {
    await poll($)
    const v = await read($, view)
    // Claude Code prints the reply after "einweave:", so the indicator's own prefix goes.
    if (v.snap?.connection.state !== 'disconnected') {
      const i = indicator(v, await $.clock.now())
      const said = i.text.replace(/^einweave · /, '')
      return i.kind === 'connected' ? `connected · ${said}` : said
    }
    if (waited >= SETTLE_MS) return 'still connecting (the hint line shows when it is done)'
    await $.clock.sleep(SETTLE_STEP_MS)
  }
}

/**
 * Take a thread for this session. From a holder who is online the tool asks first: put its question to
 * the person, and only on their yes take it with confirm (by id: a number cannot carry a confirmation).
 */
async function takeThread($: EngineInterface, ref: string): Promise<string> {
  const first = textOf(await $.mcp.call(SERVER, 'take', { ref }))
  const o = takeOutcome(first)
  if (o.kind !== 'ask') {
    await poll($)
    return first
  }
  let answer = 'Leave it'
  try {
    answer = await $.ui.ask(o.question, ['Take it', 'Leave it'])
  } catch {}
  if (answer !== 'Take it') return 'Nothing was taken.'
  const text = textOf(await $.mcp.call(SERVER, 'take', { ref: o.id, confirm: true }))
  await poll($)
  return text
}

/** Read a thread tab's content with `ui_thread`: the person's view, which neither marks read nor acks. */
async function loadThread($: EngineInterface, id: string): Promise<void> {
  await update($, threads, m => ({ ...m, [id]: { ...(m[id] ?? NO_THREAD), loading: true } }))
  let got: ThreadView
  try {
    const r = await uiRead($, `/thread/${encodeURIComponent(id)}`, {}, 'ui_thread', { thread_id: id })
    got = r.isError ? { ...NO_THREAD, loading: false, error: textOf(r) || 'ui_thread failed' } : threadView(textOf(r))
  } catch (err) {
    got = { ...NO_THREAD, loading: false, error: String(err).slice(0, 200) }
  }
  // Closed (×) while it loaded: the tab is gone, so its content must not come back.
  if (!(await read($, tabs)).open.some(x => x.id === id)) return
  const at = await $.clock.now()
  // The newest page again; older pages loaded meanwhile stay under it.
  await update($, threads, m => ({ ...m, [id]: { ...refreshed(m[id], got), at } }))
}

/** Load older (its row, or the top edge): the page of replies before the oldest shown, put under the root. */
async function loadOlder($: EngineInterface, id: string): Promise<void> {
  const th = (await read($, threads))[id]
  const before = th ? olderCursor(th) : null
  if (!th || th.loadingOlder || th.older === 0 || before === null) return
  await update($, threads, m => ({ ...m, [id]: { ...m[id]!, loadingOlder: true } }))
  let page: ThreadView
  try {
    const r = await uiRead($, `/thread/${encodeURIComponent(id)}`, { before_seq: before, limit: OLDER_PAGE }, 'ui_thread', { thread_id: id, before_seq: before, limit: OLDER_PAGE })
    page = r.isError ? { ...NO_THREAD, loading: false, error: textOf(r) || 'ui_thread failed' } : threadView(textOf(r))
  } catch (err) {
    page = { ...NO_THREAD, loading: false, error: String(err).slice(0, 200) }
  }
  if (!(await read($, tabs)).open.some(x => x.id === id)) return
  if (page.error) {
    $.ui.toast(`Older replies did not load: ${page.error.split('\n')[0]}`)
    return void (await update($, threads, m => (m[id] ? { ...m, [id]: { ...m[id]!, loadingOlder: false } } : m)))
  }
  await update($, threads, m => (m[id] ? { ...m, [id]: withOlder(m[id]!, page) } : m))
}

async function viewThread($: EngineInterface, id: string, title: string): Promise<void> {
  await update($, tabs, t => openTab(t, 'thread', id, title))
  await loadThread($, id)
}

/** The band's View: the pane up (opened if it was not), on the thread's tab. */
async function showThread($: EngineInterface, id: string, title: string): Promise<void> {
  if (!(await $.ui.panes()).some(p => p.id === PANE && p.isShown)) {
    await $.ui.open({ id: PANE, title: 'einweave' })
    await update($, paneUp, () => true)
  }
  await viewThread($, id, title)
}

/** Read the Channels tab with `ui_channels`: GET only, nothing marked. */
async function loadChannels($: EngineInterface): Promise<void> {
  await update($, channels, c => ({ ...c, loading: true }))
  let got
  try {
    const r = await uiRead($, '/channels', {}, 'ui_channels', {})
    got = r.isError ? { ...NO_CHANNELS, loading: false, error: textOf(r) || 'ui_channels failed' } : channelsView(textOf(r))
  } catch (err) {
    got = { ...NO_CHANNELS, loading: false, error: String(err).slice(0, 200) }
  }
  await update($, channels, () => got)
}

/** Read a channel tab with `ui_channel`: its threads and their holds, nothing marked. */
async function loadChannel($: EngineInterface, id: string): Promise<void> {
  await update($, channel, m => ({ ...m, [id]: { ...(m[id] ?? NO_CHANNEL), loading: true } }))
  let got: ChannelView
  try {
    const r = await uiRead($, `/channel/${encodeURIComponent(id)}`, {}, 'ui_channel', { channel_id: id })
    got = r.isError ? { ...NO_CHANNEL, loading: false, error: textOf(r) || 'ui_channel failed' } : channelView(textOf(r))
  } catch (err) {
    got = { ...NO_CHANNEL, loading: false, error: String(err).slice(0, 200) }
  }
  // Closed (×) while it loaded, as a thread tab.
  if (!(await read($, tabs)).open.some(x => x.id === id)) return
  await update($, channel, m => ({ ...m, [id]: got }))
}

async function viewChannel($: EngineInterface, id: string, name: string): Promise<void> {
  await update($, tabs, t => openTab(t, 'channel', id, `#${name}`))
  await loadChannel($, id)
}

/** The first line of a tool's answer, as a toast. */
// The engine's version, asked once per load (a reload starts the module over): one older than
// MIN_CLAUDE_CODE refuses the band's and the pane's trees whole (a prop it lacks) and draws an empty
// frame, so they draw the oldWords notice instead.
let engineAge: Promise<string | null> | undefined

/** The version to name when this Claude Code is too old for the mod, else null. One with no `$.session.version` is old. */
async function tooOld($: EngineInterface): Promise<string | null> {
  engineAge ??= (async () => {
    try {
      const v = await $.session.version()
      return claudeCodeTooOld(v.base ?? v.version) ? v.version || 'an older version' : null
    } catch {
      return 'an older version'
    }
  })()
  return engineAge
}

// Does this terminal draw OSC 8 links? Claude Code's own answer (links.ts), asked once per load: where
// it is no, the kit's Link prints its URL after its text, uncounted, and every row overflowed.
let linking: Promise<boolean> | undefined

async function terminalLinks($: EngineInterface): Promise<boolean> {
  linking ??= (async () => {
    try {
      const [setting, ...v] = await Promise.all([
        $.settings.read({ key: 'hyperlinks' }).catch(() => undefined),
        $.env.get('FORCE_HYPERLINK'), $.env.get('NETLIFY'), $.env.get('WT_SESSION'), $.env.get('CI'), $.env.get('TEAMCITY_VERSION'),
        $.env.get('TERM_PROGRAM'), $.env.get('TERM_PROGRAM_VERSION'), $.env.get('VTE_VERSION'), $.env.get('TERM'),
        $.env.get('TERMINAL_EMULATOR'), $.env.get('TMUX'), $.env.get('LC_TERMINAL'),
      ])
      const [FORCE_HYPERLINK, NETLIFY, WT_SESSION, CI, TEAMCITY_VERSION, TERM_PROGRAM, TERM_PROGRAM_VERSION, VTE_VERSION, TERM, TERMINAL_EMULATOR, TMUX, LC_TERMINAL] = v
      return hyperlinks({ FORCE_HYPERLINK, NETLIFY, WT_SESSION, CI, TEAMCITY_VERSION, TERM_PROGRAM, TERM_PROGRAM_VERSION, VTE_VERSION, TERM, TERMINAL_EMULATOR, TMUX, LC_TERMINAL }, setting)
    } catch {
      // Unknown: URLs as text never overflow a row; a Link the kit cannot draw does.
      return false
    }
  })()
  return linking
}

const toastFirst = ($: EngineInterface) => (t: string) => $.ui.toast(t.split('\n')[0] || 'Done.')

/** The relay to the control socket's `watch`, for the session's life; ends with the module, which also kills the child. */
async function runRelay($: EngineInterface): Promise<void> {
  for (let failures = 0; ; ) {
    let buf = ''
    let answered = false
    try {
      // Its parent is this Claude Code, so it finds the socket by its ppid. A CLAUDE_PID inherited from
      // an outer Claude (launched from one's shell) names THAT session's socket: blank it.
      for await (const { stream, text } of $.process.spawn({ argv: ['bun', `${$.plugin.root}/ui/ctl-watch.ts`], env: { CLAUDE_PID: '' } })) {
        if (stream !== 'stdout') continue
        buf += text
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const got = parseLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          if (!got) continue
          if ('error' in got) {
            await update($, view, v => ({ ...v, live: false, error: got.error }))
            continue
          }
          // The relay's first line is a fresh stream: a restarted plugin counts revisions from 1 again.
          await take($, got, !answered, true)
          answered = true
          failures = 0
        }
      }
    } catch (err) {
      await update($, view, v => ({ ...v, error: String(err).slice(0, 200) }))
    }
    await update($, view, v => ({ ...v, live: false }))
    // The first retry is the shortest: at startup the socket opens just after the relay first looks.
    const wait = RELAY_BACKOFF_MS[Math.min(failures, RELAY_BACKOFF_MS.length - 1)]!
    if (!answered) failures++
    await $.clock.sleep(wait)
  }
}

type Press = Parameters<NonNullable<ButtonProps['onPress']>>[0]

/** One action of a record: drawn on hover, and in the footer, on its hotkey, while the keyboard is on the record. */
interface Act {
  key: 'take' | 'new' | 'release' | 'join'
  label: string
  hotkey: string
  onPress: (press: Press) => void
}

/** The thread tab drawn last with its own window: what ui.scroll moves, at the room and width it was drawn at. */
interface ThreadWindow {
  id: string
  layout: ThreadLayout
  messages: readonly ThreadMessage[]
  room: number
  older: boolean
}

export const register: Register = on => {
  // The stops the pane's records drew last, top to bottom, and where the ring was: ui.focus reads both.
  let stops: string[] = []
  let last = ''
  let win: ThreadWindow | null = null
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The command first: a reload runs this again while the plugin's server may be slow to answer,
    // and nothing here may wait on it. Drawings redraw when the first snapshot lands.
    try {
      await $.command.register({
        name: 'einweave',
        description: 'einweave: open or close the pane, or status | connect | disconnect | rename | scope | held | release | handover',
        argumentHint: '[verb] [args]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`/einweave not registered: ${String(err)}`, { to: 'debug' })
    }
    void poll($)
    // The relay ends when the module unloads (its sleep or spawn is aborted): nothing to report then.
    void runRelay($).catch(() => {})
    $.clock.every(POLL_MS, () => {
      void read($, view).then(v => (v.live ? undefined : poll($))).catch(() => {})
    })
    // Board ThreadTab: a held thread's tab is live. Read it again while it is the one shown.
    $.clock.every(HELD_TAB_MS, () => {
      void (async () => {
        const [t, v] = [await read($, tabs), await read($, view)]
        const shown = shownTab(t)
        if (t.open.some(o => o.id === shown && o.kind === 'thread') && v.snap?.holds.some(h => h.threadId === shown)) await loadThread($, shown)
      })().catch(() => {})
    })
    return started
  })

  // /clear, /resume and /branch reset $.state and do not run session.start again: read the snapshot
  // anew. classic.SessionStart does not run where the built-in guard loads, so session.end backs it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    void poll($, true)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    $.clock.after(1_000, () => void poll($, true))
    return next(e)
  })

  on('command.run', { command: 'einweave' }, async ($, e) => {
    const action = parseCommand(e.args)
    switch (action.kind) {
      case 'pane': {
        const opened = await togglePane($)
        return !opened || opened.isPlaced ? {} : { text: `The pane waits for a wider terminal. ${indicator(await read($, view), await $.clock.now()).text}` }
      }
      case 'usage':
        return { text: action.text }
      case 'connect':
        return { text: await connect($) }
      case 'status': {
        const r = await $.mcp.call(SERVER, 'status', {})
        const text = textOf(r)
        return { text: action.full || r.isError ? text : statusSummary(text, (await read($, view)).snap?.waiting ?? null) }
      }
      case 'tool': {
        const r = await $.mcp.call(SERVER, action.tool, action.args)
        return { text: textOf(r) || (r.isError ? `${action.tool} failed` : 'Done.') }
      }
      case 'take':
        return { text: await takeThread($, action.ref) }
      case 'find': {
        const r = await $.mcp.call(SERVER, 'list_threads', { takeable: true, limit: 50 })
        return { text: r.isError ? textOf(r) || 'list_threads failed' : findInList(textOf(r), action.words) }
      }
    }
  })

  // Closed by the person (its ×) or an unload: the band redraws and says Show again.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await update($, paneUp, () => false)
    return r
  })

  // A thread tab scrolls its posts itself, under a pinned header (layout A): the wheel and keys move its
  // window; the engine's is held at row 0, its two spare rows below, so the arrows fire both ways and a
  // fast wheel never shows the engine a row off the tree last drawn (a flicker, Jörgen 2026-11-01).
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const w = win
    if (!w) return next(e)
    // The engine's window kept, never committed (as the engine's own docked mods do): a commit, even to
    // row 0, still let it show its window a row or two off the tree drawn (live 2026-11-01). The move
    // reads the place inside update, so ticks crowding in each add to the last.
    let atTop = false
    void update($, scrolls, m => {
      const sc = m[w.id]
      const moved = scrollBy(threadOff(sc, w.layout, w.messages, w.room), e.by, w.layout, w.room)
      atTop = moved.atTop
      return { ...m, [w.id]: { off: moved.off, newest: newestKey(w.layout), open: sc?.open ?? {} } }
    }).then(() => {
      if (atTop && e.by < 0 && w.older) void loadOlder($, w.id)
    })
    return {}
  })

  // Marks are the records' only keyboard stops (focusTarget); the footer keeps the record it acts on.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = focusTarget(stops, last, e.element)
    last = element ?? ''
    if (!element?.startsWith('foot:')) await update($, focused, () => recordOf(element))
    return next(element === e.element ? e : { ...e, element })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const now = await $.clock.now()
    const i = indicator(v, now)
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const old = await tooOld($)
    if (old) {
      const [need, fix] = oldWords(old)
      return (
        <Box key="old" flexDirection="row" columnGap={1}>
          <Text color={PALETTE.amber}>{need}</Text>
          <Text dimColor>{fix}</Text>
        </Box>
      )
    }
    // Read for the redraw it brings; the engine's record says what is up, a pane kept over a reload too.
    await read($, paneUp)
    const up = (await $.ui.panes()).some(p => p.id === PANE && p.isShown)
    const warn = needsBand(i)
    // The way back whenever this window is not connected and not already retrying (Jörgen 2026-10-31).
    const back = warn || i.kind === 'idle' || i.kind === 'standby'
    const s = v.snap
    // Board Main / Indicator: what is aimed at the person (addressed, not only taken part in) and active in the last day,
    // newest first, one row each, under the state line. An older ask waits in the pane, not here for good.
    const forYou = s?.connection.state === 'connected' ? inbox(s.waiting, now).forYou.filter(r => r.aimed && r.fresh) : []
    const runs = (key: string, segs: Seg[]) => segs.map((g, n) => <Text key={`${key}:${n}`} {...paint(g.tone)} weight={g.weight}>{g.text}</Text>)
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" columnGap={1}>
          {/* The name is the status light: brand while connected, dim otherwise (Jörgen 2026-10-31). */}
          <Text {...(s?.connection.state === 'connected' ? { color: PALETTE.brand } : { dimColor: true })} weight="bold">einweave</Text>
          <Box key="state" flexDirection="row">{runs('state', stateLine(v, now))}</Box>
          {warn && s?.connection.detail ? <Text dimColor wrap="truncate-end">{s.connection.detail}</Text> : null}
          {/* No hotkey: a bare digit in an empty composer would press it, and taking back evicts the other window's live session.
              Plain, its brackets drawn in the brand too: the pointer's inversion is then one colour, not two. */}
          {!back ? null : i.kind === 'superseded' ? (
            <Button key="take-back" plain label="Take it back" onPress={() => void takeBack($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))}>
              <Text color={PALETTE.brand} weight="bold">[ Take it back ]</Text>
            </Button>
          ) : (
            <Button key="connect" plain label="Connect" onPress={() => void connect($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))}>
              <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
            </Button>
          )}
          <Box flexGrow={1} />
          {/* No hotkey: a bare letter in an empty composer would press it. */}
          <Button key="pane" label={up ? '[ Hide pane ]' : '[ Show pane ]'} plain dimColor onPress={() => void togglePane($)} />
        </Box>
        {forYou.slice(0, BAND_ROWS).map(r => (
          <Box key={`band:${r.threadId}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
            <Text color={PALETTE.brand}>{`#${r.channel}`}</Text>
            <Text dimColor>↳</Text>
            <Box flexShrink={1} flexGrow={1} overflow="hidden">
              <Text weight="semibold" wrap="truncate-end">{r.title}</Text>
            </Box>
            <Text color={PALETTE.amber}>{r.meta}</Text>
            <Button key={`band-view:${r.threadId}`} label="View" onPress={() => void showThread($, r.threadId, r.title)} />
            <Button key={`band-take:${r.threadId}`} label="Take" onPress={() => void takeThread($, r.threadId).then(toastFirst($))} />
          </Box>
        ))}
        {forYou.length > BAND_ROWS ? <Text dimColor>{`${forYou.length - BAND_ROWS} more aimed at you in the pane`}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Link } = els
    const old = await tooOld($)
    if (old) {
      const [need, fix] = oldWords(old)
      return (
        <Box key="old" flexDirection="column" paddingX={PANE_PAD}>
          <Text color={PALETTE.amber}>{need}</Text>
          <Text dimColor>{fix}</Text>
        </Box>
      )
    }
    // The mobile surface has no fields (its table lacks them; drawn there they are empty): there the
    // name and scope are shown, not edited.
    const fields = e.surface !== 'mobile'
    const Input = fields && 'Input' in els ? els.Input : null
    const Select = fields && 'Select' in els ? els.Select : null
    const v = await read($, view)
    const now = await $.clock.now()
    const i = indicator(v, now)
    const s = v.snap
    const t = await read($, tabs)
    const runs = (key: string, segs: Seg[]) => segs.map((g, n) => <Text key={`${key}:${n}`} {...paint(g.tone)} weight={g.weight}>{g.text}</Text>)
    const act = (tool: string, args: Record<string, unknown>) => () =>
      void $.mcp.call(SERVER, tool, args).then(
        r => $.ui.toast(textOf(r).split('\n')[0] || (r.isError ? `${tool} failed` : 'Done.')),
        err => $.ui.toast(`${tool} failed: ${String(err).slice(0, 120)}`),
      )
    const take = (ref: string, after?: () => Promise<void>) => () =>
      void takeThread($, ref)
        .then(async t => {
          toastFirst($)(t)
          await after?.()
        })
        .catch(err => $.ui.toast(`take failed: ${String(err).slice(0, 120)}`))
    const connected = s?.connection.state === 'connected'
    const box = connected ? inbox(s.waiting, now) : { forYou: [], open: [] }
    const waiting = box.forYou.length + box.open.length
    // The tab counts what waits (the server's exact counts), not the rows drawn: those stop at 20.
    const total = s?.waiting?.forYou != null && s.waiting.channel != null ? `${s.waiting.forYou + s.waiting.channel}` : `${waiting}${s?.waiting?.more ? '+' : ''}`
    // Each Inbox heading counts what waits in it the same way, so the headings add up to the tab.
    const forYouCount = s?.waiting?.forYou ?? box.forYou.length
    const openCount = s?.waiting?.channel ?? box.open.length
    // Not connected (save a drop still retrying): the pane is this window's einweave, so only the Session
    // tab, the way back, shows; the tabs opened stay in state and return on connecting (Jörgen 2026-10-31).
    const gated = !!s && !connected && i.kind !== 'reconnecting'
    const tab = gated ? 'session' : shownTab(t)
    const show = (to: string) => () => void update($, tabs, x => ({ ...x, tab: to }))
    // Channels and channel tabs load each time they are shown: nothing pushes them.
    const showChannels = () => void update($, tabs, x => ({ ...x, tab: 'channels' })).then(() => loadChannels($))
    const showOpen = (o: OpenTab) => () => void update($, tabs, x => ({ ...x, tab: o.id })).then(() => (o.kind === 'channel' ? loadChannel($, o.id) : loadThread($, o.id)))
    const ch = await read($, channels)

    // Escape hands the keyboard back without a ui.focus: the record stays, drawn as where the keyboard was.
    const f = await read($, focused)
    const keys = e.props.isFocused
    let footActs: Act[] = []
    // The keyboard is on a record: the footer is drawn, its actions or none (a channel has none, enter still opens it).
    let footOn = false
    const open = await read($, unfolded)
    const drawn: string[] = []
    const newSession = (id: string) => (press: Press) => {
      const cmd = newSessionCommand(id)
      void $.ui.copy({ text: cmd, surface: press.surface }).then(c => $.ui.toast(c.isCopied ? `Copied: ${cmd} (paste it in a new terminal)` : `Not copied (${c.reason}): ${cmd}`))
    }
    const takeAct = (id: string, after?: () => Promise<void>, asks = false): Act => ({ key: 'take', label: asks ? 'Ask to take' : 'Take', hotkey: 't', onPress: take(id, after) })
    const newAct = (id: string): Act => ({ key: 'new', label: 'New session', hotkey: 'n', onPress: newSession(id) })

    // A desktop draws every Button as its native button, `plain` or not, and draws no hover (both seen in
    // VS Code): there a title is a link and a record's actions live in the tab it opens.
    const desk = e.surface !== 'terminal'

    /**
     * A record: a one-cell mark, its title (opens it) on the first line, `meta` on a second. The mark is
     * the keyboard's stop: the engine's focus inversion fills that cell, a bar, and leaves the title's
     * colours alone (Jörgen 2026-10-31). Under the keyboard the title is drawn as under the pointer (bright,
     * bold, `inverse: false`: not the pointer's inversion) and its dim meta a shade lighter, as under the
     * pointer (Jörgen 2026-10-31). The pointer reveals the actions at the end of the
     * last line; the keyboard's record has them in the footer instead, on hotkeys. Escape leaves a grey
     * mark where the keyboard will land again. `label` names it (the link, the button's address); `title`
     * is how it is drawn, in the canvas's colours.
     * THE STANDARD (as Inbox, Jörgen 2026-10-31): at rest a brand `#name` is regular weight and only a
     * record's own text is semibold; bold is the pointer's and the keyboard's. Bold at rest leaves the
     * hover nothing to change (Channels drew `#name` 600 and its hover showed nothing).
     */
    const record = (r: { id: string; label: string; title?: Seg[]; dim?: boolean; onOpen: () => void; meta?: Seg[]; acts: Act[] }) => {
      if (desk) return deskRecord(r)
      drawn.push(`mark:${r.id}`)
      const hot = keys && f === r.id
      const away = !keys && f === r.id
      if (hot) {
        footActs = r.acts
        footOn = true
      }
      const title = r.title ?? [{ text: r.label, weight: 'semibold' as const }]
      return (
        <Box key={`rec:${r.id}`} flexDirection="column">
          <Box flexDirection="row" height={1} overflow="hidden">
            {/* Never shrunk: a long title would take the mark's column (seen 2026-10-31). */}
            <Box flexShrink={0} flexDirection="row">
              <Button key={`mark:${r.id}`} plain label={r.label} onPress={r.onOpen}>
                {away ? <Text backgroundColor={MARK_AWAY}> </Text> : ' '}
              </Button>
              <Text> </Text>
            </Box>
            <Button key={`open:${r.id}`} plain label={r.label} dimColor={r.dim} hover={{ inverse: false, bold: true, color: '#ffffff' }} onPress={r.onOpen}>
              {hot
                ? title.map((g, n) => (
                    <Text key={`t:${r.id}:${n}`} bold color={g.tone && g.tone !== 'dim' ? PALETTE[g.tone] : '#ffffff'}>
                      {g.text}
                    </Text>
                  ))
                : runs(`t:${r.id}`, r.dim ? title.map(g => ({ text: g.text, weight: g.weight })) : title)}
            </Button>
          </Box>
          {r.meta ? (
            <Box flexDirection="row" height={1} overflow="hidden">
              <Text>  </Text>
              {r.meta.map((g, n) =>
                g.tone === 'dim' && hot ? (
                  <Text key={`m:${r.id}:${n}`} weight={g.weight} color={META_LIT}>
                    {g.text}
                  </Text>
                ) : g.tone === 'dim' ? (
                  <Text key={`m:${r.id}:${n}`} weight={g.weight} dimColor hover={{ dimColor: false, color: META_LIT }}>
                    {g.text}
                  </Text>
                ) : (
                  <Text key={`m:${r.id}:${n}`} {...paint(g.tone)} weight={g.weight}>
                    {g.text}
                  </Text>
                ),
              )}
            </Box>
          ) : null}
          {r.acts.length ? (
            <Box position="absolute" top={r.meta ? 1 : 0} right={0} flexDirection="row" display="none" hover={{ display: 'flex' }}>
              {r.acts.map(a => (
                <Box key={`act:${a.key}:${r.id}`} flexDirection="row">
                  {/* A space as text, not a gap: columnGap's cells let the record show through. */}
                  <Text> </Text>
                  <Button key={`${a.key}:${r.id}`} label={a.label} onPress={a.onPress} />
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }

    /** A record on a desktop: the title a link that opens it, the meta under it, no actions. */
    const deskRecord = (r: Parameters<typeof record>[0]) => {
      const href = recordHref(r.id)
      return (
        <Box key={`rec:${r.id}`} flexDirection="column">
          <Markdown key={`open:${r.id}`} text={`[${mdText(r.label)}](${href})`} dimColor={r.dim} pressableLinks={[href]} onLinkPress={() => r.onOpen()} />
          {r.meta ? <Box flexDirection="row">{runs(`m:${r.id}`, r.meta)}</Box> : null}
        </Box>
      )
    }

    /** A list's records, those quiet over a week under an "Older (n)" fold that opens in place. */
    const folded = <T extends { old: boolean }>(name: string, rows: T[], draw: (r: T) => ReturnType<typeof record>) => {
      const { recent, older } = fold(rows)
      const shown = recent.map(draw)
      if (!older.length) return shown
      const key = `fold:${name}`
      drawn.push(key)
      const isOpen = !!open[name]
      return [
        ...shown,
        <Button key={key} plain dimColor label={`${isOpen ? '▾' : '▸'} Older (${older.length})`} onPress={() => void update($, unfolded, u => ({ ...u, [name]: !isOpen }))} />,
        ...(isOpen ? older.map(draw) : []),
      ]
    }

    /** Board Unowned: `#channel` and the title, then why and the hold, the age amber once it is stale. */
    const inboxRecord = (r: InboxRow) =>
      record({
        id: r.threadId,
        label: r.title,
        title: [{ text: `#${r.channel}`, tone: 'brand' }, { text: ' ' }, { text: r.title, weight: 'semibold' }],
        onOpen: () => void viewThread($, r.threadId, r.title),
        meta: [{ text: r.meta, tone: 'dim' }, ...(r.age ? [{ text: ' · ', tone: 'dim' as const }, r.stale ? { text: r.age, tone: 'amber' as const, weight: 'semibold' as const } : { text: r.age, tone: 'dim' as const }] : [])],
        acts: [takeAct(r.threadId), newAct(r.threadId)],
      })

    /** A section's heading: bold, its count, and a dim note (boards FindTake, Unowned). */
    const heading = (key: string, title: string, note: string) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Text weight="bold">{title}</Text>
        <Text dimColor wrap="truncate-end">{note}</Text>
      </Box>
    )

    // Board Main: the pane's own name in the brand colour, what went wrong beside it and the way back at
    // the line's right end (wrapping when the pane is narrow); the detail under it.
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {/* The name is the status light: brand while connected, dim otherwise (Jörgen 2026-10-31). */}
          <Text key="name" {...(connected ? { color: PALETTE.brand } : { dimColor: true })} weight="bold">einweave</Text>
          {!s || !connected ? <Box key="state" flexDirection="row">{runs('state', stateLine(v, now))}</Box> : null}
          {/* The way back on the right edge. */}
          <Box flexGrow={1} />
          {s && !connected ? (
            i.kind === 'superseded' ? (
              <Button key="take-back" plain label="Take it back" onPress={() => void takeBack($).then(toastFirst($))}>
                <Text color={PALETTE.brand} weight="bold">[ Take it back ]</Text>
              </Button>
            ) : (
              <Button key="connect" plain label="Connect" onPress={() => void connect($).then(toastFirst($))}>
                <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
              </Button>
            )
          ) : null}
        </Box>
        {s && !connected && s.connection.detail ? <Text dimColor>{s.connection.detail}</Text> : null}
        {!s && v.error ? <Text dimColor>{v.error}</Text> : null}
      </Box>
    )
    if (!s) return <Box key="pane" flexDirection="column" paddingX={PANE_PAD}>{header}</Box>

    // Tabs (board Main): the shown one a filled pill, bold; the rest dim. A desktop draws its own
    // buttons and no fill, so there dimness alone says which is shown (decision E3).
    const tabButton = (key: string, label: string, id: string, onPress: () => void) =>
      tab === id ? (
        // No pointer inversion: it would turn the filled pill dark, a change on the tab already shown (Jörgen 2026-10-31).
        <Button key={key} label={label} plain hover={{ inverse: false }} onPress={onPress}>
          <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillFg} weight="bold">{` ${label} `}</Text>
        </Button>
      ) : (
        <Button key={key} label={` ${label} `} plain dimColor onPress={onPress} />
      )

    // A blank row between the pane's name and its tabs (Jörgen 2026-11-03): the name cannot move up onto the
    // close mark's row, which a dock keeps for the engine.
    const gap = <Box key="gap:tabs" height={1} flexShrink={0} />

    const tabRow = gated ? (
      <Box flexDirection="row" columnGap={1}>
        {tabButton('tab:session', 'Session', 'session', show('session'))}
      </Box>
    ) : (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {tabButton('tab:inbox', `Inbox ${connected ? total : 0}`, 'inbox', show('inbox'))}
        {tabButton('tab:held', `Held ${s.holds.length}`, 'held', show('held'))}
        {tabButton('tab:channels', 'Channels', 'channels', showChannels)}
        {tabButton('tab:session', 'Session', 'session', show('session'))}
        {t.open.map(o => {
          const label = tabLabel(o.title)
          return (
            <Box key={`tabbox:${o.id}`} flexDirection="row">
              {tabButton(`tab:${o.id}`, label, o.id, showOpen(o))}
              {/* The shown tab's × sits inside its pill, drawn as the pill (Jörgen 2026-10-31); the rest dim. A desktop
                  draws no fill, so there it stays dim: full strength is the shown tab's and the one thing to do. */}
              <Button
                key={`close:${o.id}`}
                label="×"
                plain
                {...(tab === o.id && !desk ? { hover: { inverse: false } } : { dimColor: true })}
                onPress={() => {
                  void update($, tabs, x => closeTab(x, o.id))
                  if (o.kind === 'channel') void update($, channel, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id)))
                  else void update($, threads, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id)))
                  // Its place goes too: View opens it again where it lands (first new, else newest), not where it was
                  // left (Jörgen 2026-11-01).
                  void update($, scrolls, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id)))
                }}
              >
                {tab === o.id && !desk ? <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillFg} weight="bold">{'× '}</Text> : undefined}
              </Button>
            </Box>
          )
        })}
      </Box>
    )

    let body
    // The thread tab scrolls its own posts (set there); every other tab leaves the window to the engine.
    let own = false
    win = null
    if (tab === 'inbox') {
      body = !connected ? (
        <Text dimColor>Not connected: what waits shows once this session is.</Text>
      ) : waiting === 0 ? (
        <Text dimColor>Nothing waits for this session.</Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {box.forYou.length ? heading('h:forYou', `For you ${forYouCount}`, 'questions and messages aimed at you') : null}
          {folded('forYou', box.forYou, inboxRecord)}
          {box.open.length ? heading('h:open', `Unowned ${openCount}`, 'nobody holds these · oldest first') : null}
          {/* Board Unowned: whether the gateway routes these, brand when it does, amber while they wait for a take. */}
          {box.open.length && s.gateway ? (
            s.gateway.online ? (
              <Text key="gateway" color={PALETTE.brand} wrap="truncate-end">{`● gateway ${s.gateway.label ?? ''} online · routing, usually picked within a minute`}</Text>
            ) : (
              <Text key="gateway" color={PALETTE.amber} wrap="truncate-end">○ no gateway online · unheld work goes to sessions in scope, or waits for a take</Text>
            )
          ) : null}
          {folded('open', box.open, inboxRecord)}
          {s.waiting?.more ? <Text dimColor>More wait than shown: /einweave take lists them all.</Text> : null}
          {box.open.length ? (
            <Box key="unowned-notes" flexDirection="column">
              <Text dimColor>{`Every session of ${s.session.agent ? `@${s.session.agent}` : 'this agent'} sees this list. The band stays for things aimed at you.`}</Text>
              <Text dimColor>Take brings it here. New session copies a command that starts another window and takes it there.</Text>
            </Box>
          ) : null}
        </Box>
      )
    } else if (tab === 'held') {
      body = !connected ? (
        <Text dimColor>Not connected.</Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {s.holds.length === 0 ? <Text dimColor>None. Take one from the Inbox.</Text> : null}
          {s.holds.map(held =>
            record({
              id: held.threadId,
              label: held.title ?? held.threadId,
              onOpen: () => void viewThread($, held.threadId, held.title ?? held.threadId),
              acts: [{ key: 'release', label: 'Release', hotkey: 'r', onPress: act('release', { ref: held.threadId }) }],
            }),
          )}
          {s.holds.length > 0 ? <Text dimColor>{'Hand one over: /einweave handover N <session>'}</Text> : null}
        </Box>
      )
    } else if (tab === 'channels') {
      const who = ch.agent ? `@${ch.agent}` : 'This agent'
      body = (
        <Box flexDirection="column" rowGap={1}>
          {ch.error ? <Text color={PALETTE.red}>{ch.error}</Text> : null}
          {ch.loading && !ch.channels.length ? <Text dimColor>Loading…</Text> : null}
          {!ch.loading && !ch.error && !ch.channels.length ? <Text dimColor>{`${who} isn't in any channels · set up in the web app`}</Text> : null}
          {ch.channels.length ? <Text dimColor>{`${who} is in ${ch.channels.length} ${ch.channels.length === 1 ? 'channel' : 'channels'}. Every session of the agent shares them.`}</Text> : null}
          {ch.channels.map(c =>
            record({
              id: `ch:${c.id}`,
              label: `#${c.name}`,
              title: [{ text: `#${c.name}`, tone: 'brand' }],
              onOpen: () => void viewChannel($, c.id, c.name),
              meta: [{ text: [channelMeta(c.threads, now), c.role ? null : 'following, not a member'].filter(Boolean).join(' · '), tone: 'dim' }],
              acts: [],
            }),
          )}
          <Text dimColor>Join, leave and private channels: in the web app.</Text>
        </Box>
      )
    } else if (tab === 'session') {
      const sess = s.session
      // Board Main: a label / value grid, the labels dim.
      const row = (key: string, label: string, value: ReturnType<typeof Text> | ReturnType<typeof Text>[] | null) => (
        <Box key={`row:${key}`} flexDirection="row">
          <Box width={10} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1}>
            {value}
          </Box>
        </Box>
      )
      body = (
        <Box flexDirection="column" rowGap={1}>
          {gated ? <Text key="gate" dimColor>Connect to see the Inbox, held threads and channels.</Text> : null}
          <Box flexDirection="column">
            {row('state', 'State', connected ? <Text color={PALETTE.brand}>● connected</Text> : runs('state', stateLine(v, now)))}
            {row('agent', 'Agent', <Text>{sess.agent ? `@${sess.agent}` : '-'}</Text>)}
            {Input && connected
              ? row('label', 'Session', <Input key="label" value={sess.label ?? ''} placeholder="this session's name" submitLabel="Rename" onSubmit={(label: string) => act('set_session_label', { label })()} />)
              : row('label', 'Session', <Text>{sess.label ?? '-'}</Text>)}
            {row('kind', 'Kind', <Text>{sess.kind ?? 'session'}</Text>)}
            {sess.scope && Select
              ? row(
                  'scope',
                  'Scope',
                  <Select
                    key="scope"
                    value={sess.scope.mode}
                    options={[
                      { value: 'none', label: scopeText({ mode: 'none', channelIds: [] }) },
                      { value: 'all', label: scopeText({ mode: 'all', channelIds: [] }) },
                      ...(sess.scope.mode === 'channels' ? [{ value: 'channels', label: scopeText(sess.scope) }] : []),
                    ]}
                    onSelect={(mode: string) => {
                      if (mode !== 'channels') act('scope', { channels: mode })()
                    }}
                  />,
                )
              : sess.scope
                ? row('scope', 'Scope', <Text>{scopeText(sess.scope)}</Text>)
                : null}
            {row(
              'plugin',
              'Plugin',
              s.staleSince ? [<Text key="v">{s.version}</Text>, <Text key="st" color={PALETTE.amber}>· updated on disk: restart Claude Code to use it</Text>] : <Text>{s.version}</Text>,
            )}
          </Box>
          {/* Said once here, not on every thread tab (Jörgen 2026-11-01). */}
          <Text dimColor>Thread tabs are read-only and cost no tokens. new stays new until it reaches Claude.</Text>
          <Box flexDirection="row" columnGap={1}>
            {connected ? (
              <Button key="disconnect" label="Disconnect" onPress={act('disconnect', {})} />
            ) : (
              // The header's way back, drawn the same: plain, bold brand brackets (Jörgen 2026-10-31).
              <Button key="connect-s" plain label="Connect" onPress={() => void connect($).then(toastFirst($))}>
                <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
              </Button>
            )}
            <Button key="logout" label="Sign out" dimColor onPress={act('logout', {})} />
          </Box>
        </Box>
      )
    } else if (t.open.find(x => x.id === tab)?.kind === 'channel') {
      const id = tab
      const cv = (await read($, channel))[id] ?? NO_CHANNEL
      const row = ch.channels.find(c => c.id === id)
      // Take is refused outside membership; a row not (yet) in the Channels list is not judged here.
      const member = row ? row.role !== null : true
      const { rows, more } = channelRows(cv.threads)
      body = (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color={PALETTE.brand} weight="bold" wrap="truncate-end">{t.open.find(x => x.id === id)?.title ?? id}</Text>
            {row?.threads ? <Text dimColor>{`${row.threads.open} open`}</Text> : null}
          </Box>
          <Text dimColor>{member ? 'Open threads, latest activity first.' : 'Following, not a member: join in the web app to take.'}</Text>
          {cv.error ? <Text color={PALETTE.red}>{cv.error}</Text> : null}
          {cv.loading && !cv.threads.length ? <Text dimColor>Loading…</Text> : null}
          {!cv.loading && !cv.error && !cv.threads.length ? <Text dimColor>No threads yet.</Text> : null}
          <Box flexDirection="column" rowGap={1} marginTop={1}>
            {folded(
              `ch:${id}`,
              rows.map(th => ({ ...th, ...quietFor(th.lastActivityAt, now) })),
              th => {
                const here = s.holds.some(h => h.threadId === th.id)
                const badge = holdBadge(th.hold, here)
                // `open` is every live thread's status: only the others are said.
                const status = th.resolved ? 'resolved' : th.status === 'open' ? null : th.status
                const rest = [status, th.kind, th.age].filter(Boolean).join(' · ')
                return record({
                  id: th.id,
                  label: th.title || th.id,
                  dim: th.resolved,
                  onOpen: () => void viewThread($, th.id, th.title || th.id),
                  meta: [
                    ...(badge ? [{ text: badge.text, tone: th.resolved ? ('dim' as const) : badge.tone }] : []),
                    ...(badge && rest ? [{ text: ' · ', tone: 'dim' as const }] : []),
                    ...(rest ? [{ text: rest, tone: 'dim' as const }] : []),
                  ],
                  acts: here || !member || th.resolved ? [newAct(th.id)] : [takeAct(th.id, () => loadChannel($, id), badge?.asks), newAct(th.id)],
                })
              },
            )}
          </Box>
          {more ? <Text dimColor>{`${more} more in the web app.`}</Text> : null}
          <Box marginTop={1}>
            <Text dimColor>View opens the Thread tab. Take from an online holder asks first.</Text>
          </Box>
        </Box>
      )
    } else {
      const id = tab
      const th = (await read($, threads))[id] ?? NO_THREAD
      const title = th.title ?? t.open.find(x => x.id === id)?.title ?? id
      const held = s.holds.some(h => h.threadId === id)
      // Board ThreadTab, layout A: header and footer pinned, the posts in chat order scrolled between them
      // by the mod itself (docked in a terminal, where the window is known to the row). Elsewhere the
      // frame fits the tree, so the posts flow and the surface scrolls.
      own = e.surface === 'terminal' && e.props.placement === 'dock'
      const width = Math.max(10, e.props.bodyColumns - 2 * PANE_PAD)
      const sc = (await read($, scrolls))[id]
      // A desktop draws links itself; a terminal only when it draws OSC 8.
      const layout = threadLayout(th.messages, width, sc?.open ?? {}, th.older, desk || (await terminalLinks($)))
      // Rows the pinned parts take: the pane's header (+ the detail under it while down), the gap, the tabs, the
      // rule, the thread's own header (title, hold line, rule) and its key bar under a rule.
      const tabsW = [`Inbox ${connected ? total : 0}`, `Held ${s.holds.length}`, 'Channels', 'Session'].map(l => tabWidth(l, false))
      const openW = t.open.map(o => tabWidth(tabLabel(o.title), o.id === tab ? 'shown' : 'rest'))
      const pinned = 1 + (!connected && s.connection.detail ? 1 : 0) + 1 + tabRows([...tabsW, ...openW], width) + 1 + 3 + 2
      // A desktop has no hotkeys: there the key bar is labels alone.
      const hot = (key: string) => (desk ? {} : { hotkey: key })
      const threadRule = (key: string) => (
        <Box key={key} height={1} flexShrink={0}>
          <Text color={RULE}>{'─'.repeat(width)}</Text>
        </Box>
      )
      const room = Math.max(3, e.props.scroll.bodyRows - pinned)
      const off = own ? threadOff(sc, layout, th.messages, room) : 0
      win = own ? { id, layout, messages: th.messages, room, older: th.older !== 0 && !th.loadingOlder } : null
      const expand = (key: string, more: number) => () =>
        void update($, scrolls, m => {
          const was = m[id]
          // Opened in place: the rows it gains push what is under it down, so its first line stays where it was.
          const from = was ? threadOff(was, layout, th.messages, room) : off
          return { ...m, [id]: { off: from + (from > 0 ? more - 1 : 0), newest: newestKey(layout), open: { ...(was?.open ?? {}), [key]: true as const } } }
        })
      const line = (key: string, l: Line) => (
        <Box key={key} flexDirection="row" height={1} overflow="hidden">
          {l.length
            ? l.map((r, n) => (
                <Text
                  key={`${key}:${n}`}
                  wrap="truncate-end"
                  {...(r.href ? { color: PALETTE.blue, underline: true } : r.mention === 'active' ? { color: PALETTE.brand } : r.dim ? { dimColor: true } : {})}
                  {...(r.code ? { backgroundColor: RULE } : {})}
                  {...(r.bold ? { weight: 'bold' as const } : {})}
                  {...(r.italic ? { italic: true } : {})}
                  {...(r.strike ? { strikethrough: true } : {})}
                >
                  {/* The kit's Link: an OSC 8 link in a terminal, an anchor on a desktop. doc-view.ts checked the URL (G8). */}
                  {r.href ? <Link href={r.href}>{r.text}</Link> : r.text}
                </Text>
              ))
            : <Text> </Text>}
        </Box>
      )
      // Docked, only what meets the window: a long thread drawn whole made each wheel tick slow enough for
      // the engine to show its own window a row or two off the tree meanwhile (a flicker, live 2026-11-01).
      const foot = layout.total - off
      const meets = (top: number, rows: number) => !own || (top < foot && top + rows > foot - room)
      const shown = layout.blocks.filter(b => meets(b.top, b.rows))
      const post = (b: (typeof layout.blocks)[number]) => {
        const m = th.messages[b.n]!
        const tint = m.own ? PALETTE.blue : senderColor(m.senderId)
        return (
          <Box key={`post:${id}:${b.key}`} flexDirection="column" flexShrink={0} marginTop={b.top ? 1 : 0}>
            <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
              <Text weight="bold" {...(tint ? { color: tint } : {})}>{`${m.sender ?? '?'}${m.own ? ' (you)' : ''}`}</Text>
              {m.ts ? <Text dimColor>{timeOf(m.ts)}</Text> : null}
              {m.type !== 'text' ? <Text color={PALETTE.amber}>{m.type}</Text> : null}
              <Box flexGrow={1} />
              {m.new ? <Text color={PALETTE.brand} weight="bold">new</Text> : null}
            </Box>
            {/* Every surface draws the server's doc as these lines (RFC-034 D6): no Markdown parsed here. A desktop
                shows the whole post (its surface scrolls), so no cap there. */}
            {(desk && !own ? b.all : b.lines).map((l, n) => line(`ln:${id}:${b.key}:${n}`, l))}
            {b.more && !(desk && !own) ? (
              <Button key={`more:${id}:${b.key}`} plain dimColor label={`▸ ${b.more} more ${b.more === 1 ? 'line' : 'lines'}`} onPress={expand(b.key, b.more)} />
            ) : null}
          </Box>
        )
      }
      // Under the root: how many older replies the tab has not read, and the way to them.
      const gap = layout.gap && meets(layout.gap.top, layout.gap.rows) ? (
        <Box key={`gap:${id}`} flexDirection="row" columnGap={1} marginTop={1} height={1} overflow="hidden" flexShrink={0}>
          <Text dimColor>{`${th.older ?? 'Some'} older ${th.older === 1 ? 'reply' : 'replies'}`}</Text>
          {th.loadingOlder ? (
            <Text dimColor>Loading…</Text>
          ) : (
            <Button key={`older:${id}`} plain dimColor label={`Load ${OLDER_PAGE} older ↑`} onPress={() => void loadOlder($, id)} />
          )}
        </Box>
      ) : null
      const flow = [...shown.slice(0, 1).map(post), ...(gap ? [gap] : []), ...shown.slice(1).map(post)]
      // The rows under the last one drawn, as one empty box: the window's foot stays `off` rows up.
      const last = Math.max(0, ...shown.map(b => b.top + b.rows), gap && layout.gap ? layout.gap.top + layout.gap.rows : 0)
      const tail = own && shown.length ? layout.total - last : 0
      const notes = [
        th.error ? <Text key="err" color={PALETTE.red} wrap="truncate-end">{th.error}</Text> : null,
        th.loading && !th.messages.length ? <Text key="loading" dimColor>Loading…</Text> : null,
      ]
      body = (
        <Box flexDirection="column">
          {/* Board ThreadTab, chrome A (Jörgen 2026-11-01): #channel and title, how fresh at the right; the hold
              line; a rule, so the posts start below the header, not under its buttons. */}
          <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
            {th.channel ? <Text key="ch" color={PALETTE.brand}>{`#${th.channel}`}</Text> : null}
            <Box flexShrink={1} overflow="hidden">
              <Text weight="bold" wrap="truncate-end">{title}</Text>
            </Box>
            <Box flexGrow={1} />
            {held ? <Text key="stamp" dimColor>● live</Text> : th.at !== undefined ? <Text key="stamp" dimColor>{`Updated ${clockOf(th.at)}`}</Text> : null}
          </Box>
          {held ? (
            <Text color={PALETTE.brand} wrap="truncate-end">held by you · replies come here</Text>
          ) : (
            <Text color={PALETTE.amber} wrap="truncate-end">not held here · Claude has not seen it · Take brings it here</Text>
          )}
          {threadRule('rule:head')}
          {own ? (
            // Bottom-anchored: the newest at the window's foot; `off` rows up from it.
            <Box key={`posts:${id}`} flexDirection="column" height={room} overflow="hidden" justifyContent="flex-end" flexShrink={0}>
              <Box flexDirection="column" marginBottom={-off} flexShrink={0}>
                {notes}
                {flow}
                {tail ? <Box key={`tail:${id}`} height={tail} flexShrink={0} /> : null}
              </Box>
            </Box>
          ) : (
            <Box key={`posts:${id}`} flexDirection="column">
              {notes}
              {flow}
            </Box>
          )}
          {threadRule('rule:foot')}
          {/* The key bar: the thread's actions on their keys (`t: Take`), drawn as the pane's footer for a record. */}
          <Box key={`keys:${id}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
            {held ? (
              <Button key={`release:${id}`} plain {...hot('r')} label="Release" dimColor onPress={act('release', { ref: id })} />
            ) : (
              <Button key={`take:${id}`} plain {...hot('t')} label="Take" onPress={take(id)} />
            )}
            <Text dimColor>·</Text>
            <Button key={`new:${id}`} plain {...hot('n')} label="New session" dimColor onPress={newSession(id)} />
            {held ? null : <Text key="sep:refresh" dimColor>·</Text>}
            {held ? null : <Button key={`refresh:${id}`} plain label="↻ Refresh" dimColor onPress={() => void loadThread($, id)} />}
            <Box flexGrow={1} />
            <Text dimColor>read-only</Text>
          </Box>
        </Box>
      )
    }

    stops = drawn
    const rule = (key: string) => <Text key={key} color={RULE}>{'─'.repeat(Math.max(1, e.props.bodyColumns - 2 * PANE_PAD))}</Text>
    // The keyboard's record's actions, on their hotkeys: one place to look, as a TUI's key bar.
    const footer = footOn ? (
      <Box key="footer" flexDirection="row">
        {footActs.map((a, n) => (
          <Box key={`footact:${a.key}`} flexDirection="row">
            {n ? <Text dimColor> · </Text> : null}
            <Button key={`foot:${a.key}`} plain hotkey={a.hotkey} label={a.label} onPress={a.onPress} />
          </Box>
        ))}
        <Text dimColor>{`${footActs.length ? ' · ' : ''}enter open · esc back`}</Text>
      </Box>
    ) : null
    // Spacer rows above as many as the engine's window is down, the rest below: at row 0, where ui.scroll
    // holds it, both below; on a row the engine reached itself (a clamp from a longer tab) it still shows
    // exactly the pane. A fixed top spacer showed until the first scroll (Jörgen 2026-11-01).
    const lead = Math.min(2, Math.max(0, e.props.scroll.offset))
    if (own)
      return (
        // Exactly the window and two spacer rows: the engine always has rows to scroll, so its wheel and
        // arrows fire (live 2026-11-01: at row 0, up and down).
        <Box key="pane" flexDirection="column" paddingX={PANE_PAD} height={e.props.scroll.bodyRows + 2}>
          {lead ? <Box key="spacer:top" height={lead} flexShrink={0} /> : null}
          {header}
          {gap}
          {tabRow}
          {rule('rule:tabs')}
          <Box flexDirection="column" flexShrink={0}>
            {body}
          </Box>
          {lead < 2 ? <Box key="spacer:end" height={2 - lead} flexShrink={0} /> : null}
        </Box>
      )
    return (
      // Docked, at least the pane's height, the body growing into it: the footer sits on the pane's last
      // row. Inline the frame fits the tree, so there it would only take rows from the transcript.
      <Box key="pane" flexDirection="column" paddingX={PANE_PAD} minHeight={e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined}>
        {header}
        {gap}
        {tabRow}
        {rule('rule:tabs')}
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
        {footer ? rule('rule:footer') : null}
        {footer}
      </Box>
    )
  })
}

/**
 * What the band and the pane say on a Claude Code older than MIN_CLAUDE_CODE, drawn with props every
 * engine that runs mods takes (no `weight`), so the person learns why instead of seeing an empty frame.
 */
function oldWords(version: string): [need: string, fix: string] {
  return [`einweave needs Claude Code ${MIN_CLAUDE_CODE} or later (this is ${version}).`, 'Run `claude update`, then restart Claude Code.']
}

/**
 * A desktop title link's target. Its press is the mod's (pressableLinks), so nothing opens it; the
 * mod knows no web app address, so it points nowhere real: `.invalid` is reserved never to resolve.
 */
function recordHref(id: string): string {
  return `https://einweave.invalid/${encodeURIComponent(id)}`
}

/** A title as Markdown link text: what Markdown would read as markup, escaped. */
function mdText(title: string): string {
  return title.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, c => `\\${c}`)
}

/** A local clock time, `HH:MM`. */
function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A message's local time, `HH:MM`, or its date when not today. */
function timeOf(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toISOString().slice(0, 10)} ${hm}`
}
