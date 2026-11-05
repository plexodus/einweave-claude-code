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
import type { ButtonProps, EngineInterface, Register, RenderElement } from 'claude-code'

import type { ChannelView, OpenTab, PaneScroll, PaneTabs, ThreadView, UiSnapshot } from '../types'
import {
  applySnapshot, arrowTarget, bindKeys, channelMeta, paneChord, PANE_ACTION, PANE_CHORD, unbindKeys, claudeCodeTooOld, MIN_CLAUDE_CODE, channelRows, channelsView, channelView, closeTab, EMPTY_TABS, EMPTY_VIEW, searchText, focusTarget, fold, fromTool, holdBadge, inbox,
  indicator, needsBand, newestKey, newSessionCommand, NO_CHANNELS, OLDER_PAGE, olderCursor, openTab, PALETTE, parseCommand, parseLine, quietFor, recordOf, refreshed, scopeText, senderColor,
  scrollBy, shownTab, stateLine, statusSummary, tabLabel, tabLit, tabRows, tabWidth, takeOutcome, textOf, threadLayout, threadView, withOlder, BAND_GRACE_MS,
  cueText, hidden, landOff, revealOff, stack, windowOff, type Anchor, type Stack,
  applySuggestion, fitSnippet, NO_SEARCH, oneLine, SEARCH_DEBOUNCE_MS, searchPlaceholder, SEARCH_FIELD, SEARCH_FILL, searchAnswer,
  type InboxRow, type SearchHit, type SearchState, type Seg, type Tone,
  heldRow,
  pickerRows,
  refocusTarget,
  nextTurn,
  WAITS_ON_PERSON,
  type TurnState,
} from './model'
import { cellWidth, plainLines, type Line } from './text'
import { hyperlinks } from './links'

const SERVER = 'plugin:einweave:einweave'
const PANE = 'einweave'
/** The Inbox's search results: a list of their own, with their own window place. */
const SEARCH_TAB = 'inbox:search'
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
/**
 * The held thread whose Hand over picker is open (Held tab row or thread tab; '' when none), the tab it opened on,
 * and the windows it lists: the snapshot's as it opens, then read anew once (`GET /sessions`). Kept here so the
 * list does not reorder under the pointer while the picker is open (MRU lists that reshuffle mislead past two items).
 */
const NO_HANDOVER: { id: string; on: string; sessions: NonNullable<UiSnapshot['sessions']> | null } = { id: '', on: '', sessions: null }
const handover = atom({ plugin: 'einweave', key: 'handover' } as const, NO_HANDOVER, { shape: 'handover-4' })
/**
 * The thread this window last handed over, for its Undo (Jörgen 2026-11-05: an Undo, not a confirm; 10 s; the
 * Held row stays where it was, mockup https://claude.ai/artifact/3DAwHnMFimc6ujb8D3h6J9 option A): the row's
 * place in Held (`at`), its title and channel, the window it went to, and until when Undo is offered.
 */
const UNDO_MS = 10_000
const NO_HANDED = { threadId: '', title: '', channel: '', place: '', at: 0, until: 0 }
const handed = atom({ plugin: 'einweave', key: 'handed' } as const, NO_HANDED, { shape: 'handed-1' })
/** The Inbox search (board Search): the query, the current answer, and which edit it answers. */
// shape: bump when SearchState's form changes, so a pane reloaded mid-search drops the old state rather than
// drawing it without the new fields (search-2: `applied`, live check 2026-11-04).
const search = atom({ plugin: 'einweave', key: 'search' } as const, NO_SEARCH as SearchState, { shape: 'search-2' })
/** Each tab's own window over its body, once the person moved it, and a thread's posts opened past the cap. */
const scrolls = atom({ plugin: 'einweave', key: 'scrolls' } as const, {} as Record<string, PaneScroll>, { shape: 'scrolls-1' })
/** A record's dim meta under the pointer: a shade lighter, its only background the pane's. */
const META_LIT = '#b8b8b8'
/** The pane's subtle rules: under the tabs, over the footer. */
const RULE = '#3a3d40'
/** The fewest body rows the pane's own window shows; a pane shorter than its pinned parts and these flows instead. */
const MIN_ROOM = 3
/** The pane's side margin, a column each side: the band's own inside its border (Jörgen 2026-10-31). */
const PANE_PAD = 1
/** The mark left on the record the keyboard was on once Escape handed the keyboard back: where it lands on return. */
const MARK_AWAY = '#4a4a4a'
/**
 * The keyboard's and the pointer's mark: the terminal's own inversion, the bar the engine's focus ring draws
 * on the title row (TabStates board). A colour of our own drew the rows below a shade apart from that one
 * (#e4e4e4 against the terminal's text colour, Jörgen 2026-11-05): every row inverts, so all match in any theme.
 */
const MARK_ON = { inverse: true } as const
const NO_THREAD: ThreadView = { title: null, status: null, messages: [], older: 0, error: null, loading: true }
const NO_CHANNEL: ChannelView = { threads: [], error: null, loading: true }

/** A run's Text props for its tone: an accent from the canvas, or the theme's dim. */
const paint = (tone: Tone | undefined) => (tone === 'dim' ? { dimColor: true } : tone ? { color: PALETTE[tone] } : {})

/**
 * One of the pane's reads, as the MCP tool's result. Over the plugin's UI socket when the snapshot names one
 * (`$.http.fetch` with `socketPath`, whole): the host cuts a tool result at its MODEL-facing output limit, and a long
 * thread page came back as an error (88,741 chars, 2026-11-03). A refusal of the fetch itself (no socket any more,
 * a policy) falls back to the MCP tool for that call, which keeps its size budget; an answer, even an error, stands.
 * `ui_state` goes over MCP until a snapshot has named the socket (that read is how the mod learns its path).
 */
async function uiRead($: EngineInterface, path: string, query: Record<string, string | number>, tool: string, args: Record<string, string | number>, server = SERVER) {
  const socketPath = (await read($, view)).snap?.uiSocket
  if (socketPath) {
    try {
      // Encoded: a search query is free text (spaces, #, &, quotes).
      const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
      const r = await $.http.fetch(`http://einweave${path}${qs ? `?${qs}` : ''}`, { socketPath })
      if (r.ok) return { isError: false, content: [{ type: 'text' as const, text: r.text }] }
      let error = ''
      try {
        error = String((JSON.parse(r.text) as { error?: unknown }).error ?? '')
      } catch {}
      return { isError: true, content: [{ type: 'text' as const, text: error || `${tool} failed (HTTP ${r.status})` }] }
    } catch {}
  }
  return $.mcp.call(server, tool, args)
}

/**
 * A person's action (Take, Release, Connect, a `/einweave` command): the plugin's tool of that name, run over
 * the UI socket when the snapshot names one (`POST /tool/:name`, the same code as the MCP tool), so the
 * person's own action is not a model's tool call: not bound by its output limit nor seen by its tool hooks.
 * A refusal of the fetch itself falls back to the MCP tool; an answer, even an error, stands.
 */
async function uiTool($: EngineInterface, tool: string, args: Record<string, unknown>) {
  const socketPath = (await read($, view)).snap?.uiSocket
  if (socketPath) {
    try {
      const r = await $.http.fetch(`http://einweave/tool/${encodeURIComponent(tool)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), socketPath })
      let body: { content?: unknown; isError?: unknown; error?: unknown } = {}
      try {
        body = JSON.parse(r.text) as typeof body
      } catch {}
      if (r.ok && Array.isArray(body.content)) return { isError: body.isError === true, content: body.content as { type: 'text'; text: string }[] }
      return { isError: true, content: [{ type: 'text' as const, text: String(body.error ?? '') || `${tool} failed (HTTP ${r.status})` }] }
    } catch {}
  }
  return $.mcp.call(SERVER, tool, args)
}

/**
 * Work a press, a timer or a scroll starts runs on its own: nothing awaits it. Every loader keeps its own
 * errors in state; what is left is the module unloading under it (a reload, or the kit ending a test), when its
 * state calls are refused and there is nobody to tell. So a detached chain never ends as an unhandled
 * rejection (seen in the kit, 2026-11-04). Every fire-and-forget in this module goes through here.
 */
function detach(p: Promise<unknown>): void {
  p.catch(() => {})
}

/** Take a snapshot into the view; a drop that starts now redraws once its grace period has passed. */
async function take($: EngineInterface, got: { rev: number; snap: UiSnapshot }, restart: boolean, live?: boolean): Promise<void> {
  const now = await $.clock.now()
  const wasDown = (await read($, view)).downSince !== null
  // While the relay is live it is the truth (the plugin pushes every change on it): a poll's answer, however
  // late it lands, never overwrites it. A restarted plugin's relay counts from rev 1 under a higher polled rev.
  await update($, view, v => (live === undefined && v.live ? v : { ...applySnapshot(v, got.rev, got.snap, now, restart), ...(live === undefined ? {} : { live }) }))
  if (!wasDown && got.snap.connection.state === 'disconnected') $.clock.after(BAND_GRACE_MS + 50, () => detach(update($, view, v => ({ ...v }))))
}

/** Read ui_state once: first draw, after /clear, and while the relay is down. */
async function poll($: EngineInterface, restart = false): Promise<void> {
  try {
    // The first draw runs while the server is still starting: wait for it, or the read fails and says "not answering".
    const c = await $.mcp.connect('einweave')
    if (!c.isConnected) return void (await update($, view, v => ({ ...v, error: c.message })))
    const r = await uiRead($, '/state', {}, 'ui_state', {}, c.server)
    const got = r.isError ? null : fromTool(r)
    if (got) await take($, got, restart)
    else await update($, view, v => ({ ...v, error: r.isError ? textOf(r) || 'ui_state failed' : 'ui_state answered no snapshot' }))
  } catch (err) {
    // A read the module's unload aborted fails here too, and then the module's state is gone as well: nothing
    // to report. Every caller voids poll, so it must never reject (seen as an unhandled rejection in the kit,
    // a reload test whose server never answers, 2026-11-04).
    await update($, view, v => ({ ...v, error: String(err).slice(0, 200) })).catch(() => {})
  }
}

async function connect($: EngineInterface): Promise<string> {
  const r = await uiTool($, 'connect', {})
  let text = textOf(r)
  await poll($)
  if ((await read($, view)).snap?.connection.state === 'standby') {
    let answer = 'Leave it'
    try {
      answer = await $.ui.ask('Another window has this einweave session. Take it over here?', ['Take it over', 'Leave it'])
    } catch {}
    if (answer === 'Take it over') text = textOf(await uiTool($, 'connect', { takeover: 'lock' }))
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

/** Claude Code's keybindings.json: where the person binds the key that puts the keyboard in the pane. */
async function keysPath($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '~'}/.claude`
  return `${dir.replace(/[\\/]+$/, '')}/keybindings.json`
}

async function readKeys($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
}

/** The chord bound to PANE_ACTION, read again only when the file changed (each pane draw asks). */
let chordSeen: { path: string; mtime: number; chord: string | null } | null = null
async function boundChord($: EngineInterface): Promise<string | null> {
  try {
    const path = await keysPath($)
    const mtime = (await $.fs.exists(path)) ? (await $.fs.stat(path)).mtimeMs : -1
    if (chordSeen?.path === path && chordSeen.mtime === mtime) return chordSeen.chord
    const chord = mtime < 0 ? null : paneChord(await readKeys($, path))
    chordSeen = { path, mtime, chord }
    return chord
  } catch {
    return null
  }
}

/** `/einweave bind | unbind`: the person's keybindings.json changed only after they said yes, the rest of it kept. */
async function editKeys($: EngineInterface, verb: 'bind' | 'unbind', asked?: string): Promise<string> {
  const chord = asked ?? PANE_CHORD
  const path = await keysPath($)
  const text = await readKeys($, path)
  const edit = verb === 'bind' ? bindKeys(text, asked) : unbindKeys(text)
  if (edit.kind === 'bad') return `Not bound: ${edit.why}. Nothing changed.`
  if (edit.kind === 'unreadable') return `${path} is not a keybindings file Claude Code can read; nothing changed.`
  if (edit.kind === 'taken') return `${chord} is already ${edit.action}; nothing changed. Try another: /einweave bind ctrl+x e`
  if (edit.kind === 'same') return edit.chord ? `${edit.chord} already puts the keyboard in the pane (${path}). Another key: /einweave bind <key>, e.g. ctrl+x e.` : `No key puts the keyboard in the pane (${path}); nothing to remove.`
  const question = verb === 'bind'
    ? `Bind ${chord} to put the keyboard in the einweave pane${edit.was ? ` (instead of ${edit.was})` : ''}? It is saved in ${path}.`
    : `Remove ${edit.was}, the key that puts the keyboard in the einweave pane, from ${path}?`
  const yes = verb === 'bind' ? 'Bind it' : 'Remove it'
  let answer = ''
  try {
    answer = await $.ui.ask(question, [yes, 'Leave it'])
  } catch {
    return 'Nothing changed.'
  }
  if (answer !== yes) return 'Nothing changed.'
  await $.fs.write(path, edit.text)
  chordSeen = null
  $.ui.invalidate('ui.render')
  return verb === 'bind'
    ? `Bound: ${chord} puts the keyboard in the pane from an empty prompt, and in the pane hands it back. Undo: /einweave unbind.`
    : `Unbound. ctrl+x tab still reaches the pane, after the band's buttons.`
}

/** Take this session back from the window that took it over: the person pressed for it, so no question. */
async function takeBack($: EngineInterface): Promise<string> {
  const text = textOf(await uiTool($, 'connect', { takeover: 'lock' }))
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
  const first = textOf(await uiTool($, 'take', { ref }))
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
  const text = textOf(await uiTool($, 'take', { ref: o.id, confirm: true }))
  await poll($)
  return text
}

/** The pane held the keyboard when last drawn: a focus request waits, unanswered, while the prompt holds it. */
let paneKeys = false

/**
 * Every change to the tabs goes through here: one that changes the tab shown closes the Hand over picker,
 * so going back to the tab it opened on does not bring it back (Jörgen 2026-11-04: closed on any tab switch).
 * It also lets go of the keyboard's record and, while the pane holds the keyboard, puts the ring on the tab
 * now shown (Jörgen 2026-11-05): the element the ring was on is gone, and the engine re-homed the ring by
 * POSITION, unasked and telling no hook (a click on Held left it on the 2nd record's Release, on Channels
 * on the 4th mark, the 11th element both times), while the old record was still drawn as the keyboard's.
 */
async function setTabs($: EngineInterface, f: (t: PaneTabs) => PaneTabs): Promise<void> {
  let moved = false
  let shown = ''
  await update($, tabs, t => {
    const next = f(t)
    shown = shownTab(next)
    moved = shown !== shownTab(t)
    return next
  })
  if (!moved) return
  await update($, handover, () => NO_HANDOVER)
  await update($, focused, () => '')
  if (paneKeys) detach($.ui.focus({ requestId: PANE, key: `tab:${shown}` }).catch(() => {}))
}

/**
 * Undo a hand-over: take the thread back. The person pressed Undo, so that press answers an online holder's
 * question: the first take asks (and arms the confirm for that thread), the second confirms it.
 */
async function undoHandover($: EngineInterface, id: string): Promise<string> {
  const first = textOf(await uiTool($, 'take', { ref: id }))
  const o = takeOutcome(first)
  const text = o.kind === 'ask' ? textOf(await uiTool($, 'take', { ref: o.id, confirm: true })) : first
  await update($, handed, h => (h.threadId === id ? NO_HANDED : h))
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
  await setTabs($, t => openTab(t, 'thread', id, title))
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

/**
 * Run the Inbox search for the query as it is now (RFC-031): `/search` over the UI socket, else
 * `ui_search`. `more` appends the next page. An answer for an edit that is no longer the newest is
 * dropped: typing on while a request is out never draws a stale page.
 */
async function runSearch($: EngineInterface, more = false): Promise<void> {
  const st = await read($, search)
  const q = st.q.trim()
  if (!q) return
  const seq = st.seq
  const cursor = more ? st.next : null
  if (more && !cursor) return
  await update($, search, x => ({ ...x, loading: true }))
  const query: Record<string, string> = { q, type: st.type, sort: st.sort, ...(cursor ? { cursor } : {}) }
  let got: ReturnType<typeof searchAnswer>
  try {
    const r = await uiRead($, '/search', query, 'ui_search', { query: q, type: st.type, sort: st.sort, ...(cursor ? { cursor } : {}) })
    got = r.isError ? { rows: [], total: null, next: null, refused: null, applied: null, error: textOf(r) || 'search failed' } : searchAnswer(textOf(r))
  } catch (err) {
    got = { rows: [], total: null, next: null, refused: null, applied: null, error: String(err).slice(0, 200) }
  }
  await update($, search, x => (x.seq !== seq ? x : { ...x, ...got, rows: more ? [...x.rows, ...got.rows] : got.rows, loading: false }))
}

/** A change to the query, type or sort: a new edit; the search runs after a pause (or at once). */
async function editSearch($: EngineInterface, change: Partial<Pick<SearchState, 'q' | 'type' | 'sort'>>, now = false): Promise<void> {
  let seq = 0
  await update($, search, x => {
    seq = x.seq + 1
    const next = { ...x, ...change, seq }
    // Cleared: back to the Inbox, nothing kept.
    return next.q.trim() ? { ...next, loading: true } : { ...NO_SEARCH, type: next.type, sort: next.sort, seq }
  })
  // A new answer is a new list: its window starts at its top again.
  if (change.q !== undefined || change.type !== undefined || change.sort !== undefined) await update($, scrolls, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== SEARCH_TAB)))
  if (!(await read($, search)).q.trim()) return
  if (now) return void (await runSearch($))
  $.clock.after(SEARCH_DEBOUNCE_MS, () => detach(read($, search).then(x => (x.seq === seq ? runSearch($) : undefined))))
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
  const at = await $.clock.now()
  await update($, channels, () => ({ ...got, at }))
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
  const at = await $.clock.now()
  await update($, channel, m => ({ ...m, [id]: { ...got, at } }))
}

async function viewChannel($: EngineInterface, id: string, name: string): Promise<void> {
  await setTabs($, t => openTab(t, 'channel', id, `#${name}`))
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
// Terminal.app: no OSC 8, and Claude Code's mouse capture takes a plain or Cmd click; Option+click reaches
// Terminal.app itself, which opens the URL under it (measured 2026-11-03). The thread tab says so there.
let appleTerminal: Promise<boolean> | undefined
const isAppleTerminal = ($: EngineInterface) => (appleTerminal ??= $.env.get('TERM_PROGRAM').then(v => v === 'Apple_Terminal', () => false))

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
  key: 'take' | 'new' | 'release' | 'join' | 'handover' | 'undo'
  label: string
  hotkey: string
  onPress: (press: Press) => void
}

/**
 * One block of a tab's body: its rows exact (the pane's one window scrolls by them), `space` a blank row
 * above it. `stop`: it holds a keyboard stop, so it is drawn even outside the window (Tab must reach it;
 * ui.focus then brings it into view). `focus`: the element keys inside it, what ui.focus reveals it by.
 */
interface Block {
  key: string
  rows: number
  space?: boolean
  stop?: boolean
  /** A section's heading: the window shows it with the section's first record (model revealOff). */
  section?: boolean
  focus?: readonly string[]
  draw: () => RenderElement
}

/**
 * What every tab hands the shell (plan 2026-11-04-mod-pinned-every-tab-plan.md): its head (pinned under the
 * tabs), its body as blocks (the window scrolls them), its key bar's left side (null: the resting hint) and
 * right side, and how its window lands: a thread at its first new post, anchored at the end; a list at its top.
 */
interface Frame {
  id: string
  head: { rows: number; node: RenderElement }[]
  blocks: Block[]
  keys: RenderElement | null
  right?: RenderElement[]
  anchor: Anchor
  land?: (s: Stack, room: number) => number
  onTop?: () => void
}

/** The tab drawn last with its own window: what ui.scroll and ui.focus move, at the room it was drawn at. */
interface PaneWindow {
  id: string
  stack: Stack
  room: number
  land: number
  anchor: Anchor
  /** Element key → the key of the block holding it. */
  reveal: Map<string, string>
  onTop?: () => void
}

/** A window's place once moved: its offset, the body's last block (rows after it keep the place), a list at its top kept there. */
function placed(off: number, atTop: boolean, w: PaneWindow, sc: PaneScroll | undefined): PaneScroll {
  return { off, newest: newestKey(w.stack), open: sc?.open ?? {}, ...(w.anchor === 'top' && atTop ? { top: true as const } : {}) }
}

/**
 * This window's turn state as last seen, and as last told to the plugin's server: only a change is posted,
 * and a post that failed (no socket yet) goes with the next event or the first snapshot. Module variables:
 * a reload starts them over, and the next event reports again.
 */
let turnNow: TurnState | null = null
let turnSent: TurnState | null = null

/** Post the turn state to the plugin's server over the UI socket (`POST /turn/<state>`), if it changed. */
async function sendTurn($: EngineInterface): Promise<void> {
  const want = turnNow
  if (!want || want === turnSent) return
  const socketPath = (await read($, view)).snap?.uiSocket
  if (!socketPath) return
  const r = await $.http.fetch(`http://einweave/turn/${want}`, { method: 'POST', socketPath })
  if (r.ok) turnSent = want
}

/** A lifecycle event moved the turn state (null: no change): post it without waiting. */
function reportTurn($: EngineInterface, state: TurnState | null): void {
  if (!state) return
  turnNow = state
  detach(sendTurn($))
}

export const register: Register = on => {
  // The stops the pane's records drew last, top to bottom, and where the ring was: ui.focus reads both.
  let stops: string[] = []
  let last = ''
  // The body's focus keys and stops as drawn last, and on which tab: what refocusTarget compares with.
  let bodyWas = { frame: '', keys: [] as string[], stops: [] as string[] }
  let win: PaneWindow | null = null
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
    // The first snapshot names the UI socket: a turn state reported before it lands goes then.
    detach(poll($).then(() => sendTurn($)))
    // The relay ends when the module unloads (its sleep or spawn is aborted): nothing to report then.
    detach(runRelay($))
    $.clock.every(POLL_MS, () => {
      detach(read($, view).then(v => (v.live ? undefined : poll($))))
    })
    // Board ThreadTab: a held thread's tab is live. Read it again while it is the one shown.
    $.clock.every(HELD_TAB_MS, () => {
      detach(
        (async () => {
          const [t, v] = [await read($, tabs), await read($, view)]
          const shown = shownTab(t)
          if (t.open.some(o => o.id === shown && o.kind === 'thread') && v.snap?.holds.some(h => h.threadId === shown)) await loadThread($, shown)
        })(),
      )
    })
    return started
  })

  /**
   * What this window's model is doing (`working` | `needs_you` | `idle`), told to the plugin's server
   * (`POST /turn/<state>`, the UI socket) for einweave's Hand over picker (Jörgen 2026-11-05). From Claude
   * Code's own lifecycle, in process, never a timer: the main loop's turn start and end (an Esc ends one too,
   * which a Stop hook never hears); a dialog shown to the person (a permission, an MCP question; AskUserQuestion
   * and plan approval are tools that wait on the person); the asked call returning, or the next one, ends that wait. Only a change is
   * posted; a post that fails is tried again on the next event. No hook here waits on it or changes anything.
   */
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) reportTurn($, nextTurn(turnNow, { kind: 'start' }))
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) reportTurn($, nextTurn(turnNow, { kind: 'end' }))
    return next(e)
  })
  on('classic.Notification', async ($, e, next) => {
    reportTurn($, nextTurn(turnNow, { kind: 'notification', type: e.notification_type }))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', async ($, e, next) => {
    const waits = WAITS_ON_PERSON.has(e.tool)
    reportTurn($, nextTurn(turnNow, { kind: waits ? 'ask' : 'tool' }))
    const result = await next(e)
    // The person answered whatever this call asked (its dialog opens inside `next`), and the tool ran. No hook
    // hears the answer itself, so a long approved command still reads `needs_you` until it returns.
    reportTurn($, nextTurn(turnNow, { kind: 'tool' }))
    return result
  }).catch(($, e, next) => next(e))

  // /clear, /resume and /branch reset $.state and do not run session.start again: read the snapshot
  // anew. classic.SessionStart does not run where the built-in guard loads, so session.end backs it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    detach(poll($, true))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    $.clock.after(1_000, () => detach(poll($, true)))
    return next(e)
  })

  on('command.run', { command: 'einweave' }, async ($, e) => {
    const action = parseCommand(e.args)
    switch (action.kind) {
      case 'pane': {
        const opened = await togglePane($)
        return !opened || opened.isPlaced ? {} : { text: `The pane waits for a wider terminal. ${indicator(await read($, view), await $.clock.now()).text}` }
      }
      case 'bind':
        return { text: await editKeys($, 'bind', action.chord) }
      case 'unbind':
        return { text: await editKeys($, 'unbind') }
      case 'usage':
        return { text: action.text }
      case 'connect':
        return { text: await connect($) }
      case 'status': {
        const r = await uiTool($, 'status', {})
        const text = textOf(r)
        return { text: action.full || r.isError ? text : statusSummary(text, (await read($, view)).snap?.waiting ?? null) }
      }
      case 'tool': {
        const r = await uiTool($, action.tool, action.args)
        return { text: textOf(r) || (r.isError ? `${action.tool} failed` : 'Done.') }
      }
      case 'take':
        return { text: await takeThread($, action.ref) }
      case 'search': {
        const r = await uiRead($, '/search', { q: action.words }, 'ui_search', { query: action.words })
        return { text: r.isError ? textOf(r) || 'search failed' : searchText(textOf(r), action.words) }
      }
    }
  })

  // Closed by the person (its ×) or an unload: the band redraws and says Show again.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await update($, paneUp, () => false)
    return r
  })

  // Every tab scrolls its body itself, under its pinned head and over its pinned key bar (the thread tab's
  // layout A, made the pane's one window): the wheel and keys move it; the engine's is held at row 0, its two
  // spare rows below, so the arrows fire both ways and a fast wheel never shows the engine a row off the tree
  // last drawn (a flicker, Jörgen 2026-11-01).
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const w = win
    if (!w) return next(e)
    // An arrow (the person's, a row, no pointer) on a list moves the ring a record, as Tab does; ui.focus then
    // brings that record into view. Wheel, page keys and the thread tab scroll (arrowTarget).
    const to = e.origin.kind === 'person' && !e.pointer && Math.abs(e.by) === 1 ? arrowTarget(stops, last, e.by) : undefined
    if (to) {
      detach($.ui.focus({ requestId: PANE, key: to }))
      return {}
    }
    // The engine's window kept, never committed (as the engine's own docked mods do): a commit, even to
    // row 0, still let it show its window a row or two off the tree drawn (live 2026-11-01). The move
    // reads the place inside update, so ticks crowding in each add to the last.
    let atTop = false
    detach(update($, scrolls, m => {
      const sc = m[w.id]
      const moved = scrollBy(windowOff(sc, w.stack, w.room, w.land, w.anchor), e.by, w.stack, w.room)
      atTop = moved.atTop
      return { ...m, [w.id]: placed(moved.off, moved.atTop, w, sc) }
    }).then(() => {
      if (atTop && e.by < 0) w.onTop?.()
    }))
    return {}
  })

  // Marks are the records' only keyboard stops (focusTarget); the footer keeps the record it acts on. The
  // window follows the ring: a stop outside it is drawn all the same, and landing there brings it into view.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = focusTarget(stops, last, e.element)
    last = element ?? ''
    if (!element?.startsWith('foot:')) await update($, focused, () => recordOf(element))
    const w = win
    const block = element && w ? w.reveal.get(element) : undefined
    if (w && block)
      await update($, scrolls, m => {
        const sc = m[w.id]
        const off = windowOff(sc, w.stack, w.room, w.land, w.anchor)
        const to = revealOff(w.stack, block, off, w.room)
        return to === off ? m : { ...m, [w.id]: placed(to, to >= Math.max(0, w.stack.total - w.room), w, sc) }
      })
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
            <Button key="take-back" plain label="Take it back" onPress={() => detach(takeBack($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting')))}>
              <Text color={PALETTE.brand} weight="bold">[ Take it back ]</Text>
            </Button>
          ) : (
            <Button key="connect" plain label="Connect" onPress={() => detach(connect($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting')))}>
              <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
            </Button>
          )}
          <Box flexGrow={1} />
          {/* No hotkey: a bare letter in an empty composer would press it. */}
          <Button key="pane" label={up ? '[ Hide pane ]' : '[ Show pane ]'} plain dimColor onPress={() => detach(togglePane($))} />
        </Box>
        {forYou.slice(0, BAND_ROWS).map(r => (
          <Box key={`band:${r.threadId}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
            <Text color={PALETTE.brand}>{`#${r.channel}`}</Text>
            <Text dimColor>↳</Text>
            <Box flexShrink={1} flexGrow={1} overflow="hidden">
              <Text weight="semibold" wrap="truncate-end">{r.title}</Text>
            </Box>
            <Text color={PALETTE.amber}>{r.meta}</Text>
            <Button key={`band-view:${r.threadId}`} label="View" onPress={() => detach(showThread($, r.threadId, r.title))} />
            <Button key={`band-take:${r.threadId}`} label="Take" onPress={() => detach(takeThread($, r.threadId).then(toastFirst($)))} />
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
    // Set again by the shell when this draw has its own window.
    win = null
    const v = await read($, view)
    const now = await $.clock.now()
    const i = indicator(v, now)
    const s = v.snap
    const t = await read($, tabs)
    const runs = (key: string, segs: Seg[]) => segs.map((g, n) => <Text key={`${key}:${n}`} {...paint(g.tone)} weight={g.weight}>{g.text}</Text>)
    const act = (tool: string, args: Record<string, unknown>) => () =>
      detach(uiTool($, tool, args).then(
        r => $.ui.toast(textOf(r).split('\n')[0] || (r.isError ? `${tool} failed` : 'Done.')),
        err => $.ui.toast(`${tool} failed: ${String(err).slice(0, 120)}`),
      ))
    const take = (ref: string, after?: () => Promise<void>) => () =>
      detach(
        takeThread($, ref)
          .then(async t => {
            toastFirst($)(t)
            await after?.()
          })
          .catch(err => $.ui.toast(`take failed: ${String(err).slice(0, 120)}`)),
      )
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
    const show = (to: string) => () => detach(setTabs($, x => ({ ...x, tab: to })))
    // Channels and channel tabs load each time they are shown: nothing pushes them.
    const showChannels = () => detach(setTabs($, x => ({ ...x, tab: 'channels' })).then(() => loadChannels($)))
    const showOpen = (o: OpenTab) => () => detach(setTabs($, x => ({ ...x, tab: o.id })).then(() => (o.kind === 'channel' ? loadChannel($, o.id) : loadThread($, o.id))))
    const ch = await read($, channels)
    const st = await read($, search)
    // Every tab's window place, read with the rest of the state before anything is drawn.
    const places = await read($, scrolls)

    // Escape hands the keyboard back without a ui.focus: the record stays, drawn as where the keyboard was.
    const f = await read($, focused)
    const keys = e.props.isFocused
    paneKeys = keys
    let footActs: Act[] = []
    // The keyboard is on a record: the footer is drawn, its actions or none (a channel has none, enter still opens it).
    let footOn = false
    const open = await read($, unfolded)
    const drawn: string[] = []
    const newSession = (id: string) => (press: Press) => {
      const cmd = newSessionCommand(id)
      detach($.ui.copy({ text: cmd, surface: press.surface }).then(c => $.ui.toast(c.isCopied ? `Copied: ${cmd} (paste it in a new terminal)` : `Not copied (${c.reason}): ${cmd}`)))
    }
    const takeAct = (id: string, after?: () => Promise<void>, asks = false): Act => ({ key: 'take', label: asks ? 'Ask to take' : 'Take', hotkey: 't', onPress: take(id, after) })
    const newAct = (id: string): Act => ({ key: 'new', label: 'New session', hotkey: 'n', onPress: newSession(id) })
    // The picker belongs to the tab it opened on; setTabs closes it on a switch, and this hides it where the
    // tab shown changes without one (not connected: the Session tab only). Held and a thread tab share it.
    const ho = await read($, handover)
    const picking = ho.on === tab ? ho.id : ''
    const togglePicker = (id: string) => () =>
      detach(
        (async () => {
          let opened = false
          await update($, handover, open => {
            if (open.on === tab && open.id === id) return NO_HANDOVER
            opened = true
            return { id, on: tab, sessions: s?.sessions ?? null }
          })
          if (!opened) return
          // What each window is doing NOW: the snapshot's list is up to a minute old. Read once; the order then
          // stays while the picker is open. A failed read keeps the snapshot's.
          // Over the UI socket only: no MCP tool reads it (the model has no use for it).
          const socketPath = (await read($, view)).snap?.uiSocket
          if (!socketPath) return
          let fresh: NonNullable<UiSnapshot['sessions']> | null = null
          try {
            const r = await $.http.fetch('http://einweave/sessions', { socketPath })
            const body = r.ok ? (JSON.parse(r.text) as { sessions?: unknown }) : null
            if (Array.isArray(body?.sessions)) fresh = body.sessions as NonNullable<UiSnapshot['sessions']>
          } catch {}
          if (fresh) await update($, handover, open => (open.on === tab && open.id === id ? { ...open, sessions: fresh } : open))
        })(),
      )
    const handoverAct = (id: string): Act => ({ key: 'handover', label: 'Hand over', hotkey: 'h', onPress: togglePicker(id) })
    const hd = await read($, handed)
    const undoing = hd.threadId && now < hd.until ? hd : null
    /** The seconds Undo has left, drawn dim beside it (`8s`, mock A); a redraw each second keeps it current. */
    const undoLeft = undoing ? `${Math.max(1, Math.ceil((undoing.until - now) / 1000))}s` : ''
    const undoAct = (id: string): Act => ({
      key: 'undo',
      label: 'Undo',
      hotkey: 'u',
      onPress: () => detach(undoHandover($, id).then(toastFirst($)).catch(err => $.ui.toast(`Undo failed: ${String(err).slice(0, 120)}`))),
    })
    /** Hand the thread to window `w`; once it went, its Held row (or its tab's key bar) offers Undo for UNDO_MS. */
    const handOver = (threadId: string, w: { id: string; place: string }) =>
      detach(
        (async () => {
          const at = s?.holds.findIndex(h => h.threadId === threadId) ?? -1
          const row = at >= 0 && s ? heldRow(s.holds[at]!, now) : null
          let r: Awaited<ReturnType<typeof uiTool>>
          try {
            r = await uiTool($, 'handover', { ref: threadId, to: w.id })
          } catch (err) {
            $.ui.toast(`handover failed: ${String(err).slice(0, 120)}`)
            return
          }
          const text = textOf(r)
          $.ui.toast(text.split('\n')[0] || (r.isError ? 'handover failed' : 'Done.'))
          if (r.isError || !/^Handed /.test(text)) return
          const until = (await $.clock.now()) + UNDO_MS
          await update($, handed, () => ({ threadId, title: row?.title ?? '', channel: row?.channel ?? '', place: w.place, at: Math.max(0, at), until }))
          // A redraw each second for the count beside Undo, then the row goes.
          for (let t = 1_000; t < UNDO_MS; t += 1_000) $.clock.after(t, () => detach(update($, handed, h => (h.until === until ? { ...h } : h))))
          $.clock.after(UNDO_MS, () => detach(update($, handed, h => (h.until === until ? NO_HANDED : h))))
          await poll($)
        })(),
      )

    /**
     * Hand over's picker (option B, Jörgen 2026-11-05; mockup https://claude.ai/artifact/6L15G1YyW89Q8W2zEvpAzF):
     * hung off the record by a left edge (`╭ │ ╰`), each online window a two-line record (where it works and what
     * it is doing; what it holds), needs you first; then `[ New window ]`, which copies the command that starts
     * one and takes the thread there (also the way when there is no other window), and `[ Cancel ]`; the offline
     * windows only counted. `rows` bounds it where it has a fixed area (the thread tab's posts window): what does
     * not fit is counted, so Cancel always shows. Hands back its rows and the keys of what it draws.
     */
    const picker = (threadId: string, rows = Infinity) => {
      const close = () => detach(update($, handover, () => NO_HANDOVER))
      const { rows: windows, offline } = pickerRows(ho.id === threadId && ho.sessions ? ho.sessions : s?.sessions, now)
      const agent = s?.session.agent ? `@${s.session.agent}` : 'this agent'
      const head = windows.length ? 'Hand over to' : `No other session of ${agent}${offline ? ' online' : ''} · start one`
      // Head, the buttons and the closing edge; two rows a window.
      const fixed = 3
      const fits = fixed + windows.length * 2 <= rows
      const shown = fits ? windows : windows.slice(0, Math.max(0, Math.floor((rows - fixed - 1) / 2)))
      const cut = windows.length - shown.length
      const edge = (c: string) => <Text color={RULE}>{c}</Text>
      const win = (w: (typeof windows)[number]) => (
        <Box key={`pick-win:${threadId}:${w.id}`} flexDirection="column">
          <Box flexDirection="row" height={1} overflow="hidden">
            {edge('│ ')}
            <Box flexShrink={1} overflow="hidden">
              <Button
                key={`pick:${threadId}:${w.id}`}
                plain
                label={`Hand over to ${w.place}`}
                onPress={() => {
                  handOver(threadId, w)
                  close()
                }}
              >
                {/* One Text, truncated once: a long place wrapped to 2 rows and broke the row budget (live 2026-11-04). */}
                <Text wrap="truncate-end">
                  <Text color={PALETTE.brand}>● </Text>
                  <Text weight="semibold" hover={{ bold: true, color: '#ffffff' }}>
                    {w.place}
                  </Text>
                </Text>
              </Button>
            </Box>
            <Box flexGrow={1} />
            {w.state ? (
              <Box flexShrink={0} paddingLeft={1}>
                <Text {...paint(w.state.tone)} weight={w.state.weight}>
                  {w.state.text}
                </Text>
              </Box>
            ) : null}
          </Box>
          <Box flexDirection="row" height={1} overflow="hidden">
            {edge('│ ')}
            <Text dimColor wrap="truncate-end">{`  ${w.holds}`}</Text>
          </Box>
        </Box>
      )
      const keys = [...shown.map(w => `pick:${threadId}:${w.id}`), `pick-new:${threadId}`, `pick-cancel:${threadId}`]
      const rowsDrawn = 1 + shown.length * 2 + (cut > 0 ? 1 : 0) + 2
      const node = (
        <Box key={`picker:${threadId}`} flexDirection="column" paddingLeft={2} flexShrink={0}>
          <Box key={`pick-head:${threadId}`} flexDirection="row" height={1} overflow="hidden">
            {edge('╭ ')}
            <Text dimColor wrap="truncate-end">{head}</Text>
          </Box>
          {shown.map(win)}
          {cut > 0 ? (
            <Box key={`pick-cut:${threadId}`} flexDirection="row" height={1} overflow="hidden">
              {edge('│ ')}
              <Text dimColor wrap="truncate-end">{`${cut} more · a taller pane shows them`}</Text>
            </Box>
          ) : null}
          <Box key={`pick-foot:${threadId}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
            {edge('│')}
            <Button
              key={`pick-new:${threadId}`}
              label="New window"
              onPress={(press: Press) => {
                newSession(threadId)(press)
                close()
              }}
            />
            <Button key={`pick-cancel:${threadId}`} dimColor label="Cancel" onPress={close} />
          </Box>
          <Box key={`pick-tail:${threadId}`} flexDirection="row" height={1} overflow="hidden">
            {edge('╰ ')}
            {offline ? <Text dimColor wrap="truncate-end">{`${offline} offline not shown`}</Text> : null}
          </Box>
        </Box>
      )
      return { node, rows: rowsDrawn, keys }
    }

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
    // `pin`: its actions always drawn, not only under the pointer (the handed-over row's Undo).
    const record = (r: { id: string; label: string; title?: Seg[]; dim?: boolean; onOpen: () => void; meta?: Seg[]; meta2?: Seg[]; acts: Act[]; pin?: boolean }) => {
      if (desk) return deskRecord(r)
      drawn.push(`mark:${r.id}`)
      const hot = keys && f === r.id
      const away = !keys && f === r.id
      if (hot) {
        footActs = r.acts
        footOn = true
      }
      const title = r.title ?? [{ text: r.label, weight: 'semibold' as const }]
      const metaLines = [r.meta, r.meta2].filter((m): m is Seg[] => !!m?.length)
      // The mark: one bar down every row of the record (TabStates board). Light under the keyboard (on the title
      // row the engine's inversion of the mark's Button draws it) and under the pointer; Escape's grey.
      const markCell = (row: number) => (
        <Text {...(row > 0 && hot ? MARK_ON : away ? { backgroundColor: MARK_AWAY } : {})} hover={MARK_ON}> </Text>
      )
      // The record's Box is the ONE keyed Box in it: every hover inside (title, meta, mark, actions) lights while the
      // pointer is anywhere on the record. A row Box with a key of its own scopes its hovers to that row (kit
      // BoxProps.key): the meta rows were keyed, so the meta lit only under the pointer on its own line (2026-11-04).
      return (
        <Box key={`rec:${r.id}`} flexDirection="column">
          <Box flexDirection="row" height={1} overflow="hidden">
            {/* Never shrunk: a long title would take the mark's column (seen 2026-10-31). */}
            <Box flexShrink={0} flexDirection="row">
              <Button key={`mark:${r.id}`} plain label={r.label} onPress={r.onOpen}>
                {markCell(0)}
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
          {metaLines.map((segs, line) => (
            <Box flexDirection="row" height={1} overflow="hidden">
              {/* ONE Text, its runs inline: laid out as a row of Texts, a line wider than the pane gave
                  each Text less than its width, each WRAPPED inside it, and the one-row box showed only
                  each first line ("is being deployed" read "is deplo"; live check 2026-11-04, measured
                  against the kit docs: "a Text holds strings and inline elements"; a tree wider than its
                  columns "wraps or truncates, as its Text props say"). One Text truncates once, at its end. */}
              {markCell(line + 1)}
              <Text wrap="truncate-end">
                {' '}
                {segs.map((g, n) =>
                  g.tone === 'dim' && hot ? (
                    <Text key={`m${line}:${r.id}:${n}`} weight={g.weight} color={META_LIT}>
                      {g.text}
                    </Text>
                  ) : g.tone === 'dim' ? (
                    <Text key={`m${line}:${r.id}:${n}`} weight={g.weight} dimColor hover={{ dimColor: false, color: META_LIT }}>
                      {g.text}
                    </Text>
                  ) : (
                    <Text key={`m${line}:${r.id}:${n}`} {...paint(g.tone)} weight={g.weight}>
                      {g.text}
                    </Text>
                  ),
                )}
              </Text>
            </Box>
          ))}
          {r.acts.length ? (
            <Box position="absolute" top={metaLines.length} right={0} flexDirection="row" {...(r.pin ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
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
          {r.meta2 ? <Box flexDirection="row">{runs(`m2:${r.id}`, r.meta2)}</Box> : null}
        </Box>
      )
    }

    /** Board Unowned: `#channel` and the title, then why and the hold, the age amber once it is stale. */
    const inboxRecordOf = (r: InboxRow): Parameters<typeof record>[0] => ({
        id: r.threadId,
        label: r.title,
        title: [{ text: `#${r.channel}`, tone: 'brand' }, { text: ' ' }, { text: r.title, weight: 'semibold' }],
        onOpen: () => detach(viewThread($, r.threadId, r.title)),
        meta: [{ text: r.meta, tone: 'dim' }, ...(r.age ? [{ text: ' · ', tone: 'dim' as const }, r.stale ? { text: r.age, tone: 'amber' as const, weight: 'semibold' as const } : { text: r.age, tone: 'dim' as const }] : [])],
        acts: [takeAct(r.threadId), newAct(r.threadId)],
      })

    /** A section's heading: bold, its count, and a dim note (boards FindTake, Unowned). */
    const heading = (key: string, title: string, note: string) => (
      <Box key={key} flexDirection="row" columnGap={1} height={1} overflow="hidden">
        <Text weight="bold">{title}</Text>
        <Text dimColor wrap="truncate-end">{note}</Text>
      </Box>
    )

    // Board Main: the pane's own name in the brand colour, what went wrong beside it and the way back at
    // the line's right end (wrapping when the pane is narrow); the detail under it, wrapped here so its rows are known.
    const paneWidth = Math.max(10, e.props.bodyColumns - 2 * PANE_PAD)
    const detailLines = s && !connected && s.connection.detail ? plainLines(s.connection.detail, paneWidth).map(l => l.map(r => r.text).join('')) : []
    const stateCells = !s || !connected ? stateLine(v, now).reduce((a, g) => a + cellWidth(g.text), 0) : 0
    const backCells = s && !connected ? (i.kind === 'superseded' ? '[ Take it back ]' : '[ Connect ]').length : 0
    const headRowsOf = tabRows([8, ...(stateCells ? [stateCells] : []), ...(backCells ? [backCells] : [])], paneWidth, 2)
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
              <Button key="take-back" plain label="Take it back" onPress={() => detach(takeBack($).then(toastFirst($)))}>
                <Text color={PALETTE.brand} weight="bold">[ Take it back ]</Text>
              </Button>
            ) : (
              <Button key="connect" plain label="Connect" onPress={() => detach(connect($).then(toastFirst($)))}>
                <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
              </Button>
            )
          ) : null}
        </Box>
        {detailLines.map((l, n) => (
          <Box key={`detail:${n}`} height={1} overflow="hidden">
            <Text dimColor wrap="truncate-end">{l || ' '}</Text>
          </Box>
        ))}
        {!s && v.error ? <Text dimColor>{v.error}</Text> : null}
      </Box>
    )
    if (!s) return <Box key="pane" flexDirection="column" paddingX={PANE_PAD}>{header}</Box>

    // Tabs (board Main): the shown one a filled pill, bold; the rest dim. A desktop draws its own
    // buttons and no fill, so there dimness alone says which is shown (decision E3).
    const tabButton = (key: string, label: string, id: string, onPress: () => void, lit?: ReturnType<typeof tabLit>) =>
      tab === id ? (
        // No pointer inversion: it would turn the filled pill dark, a change on the tab already shown (Jörgen 2026-10-31).
        <Button key={key} label={label} plain hover={{ inverse: false }} onPress={onPress}>
          <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillFg} weight="bold">{` ${label} `}</Text>
        </Button>
      ) : (
        // An opened tab's label lights with its × (tabLit): dim and hover are the Text's, as the shown pill's fill
        // is; a dimColor Button would keep the lit Text grey beside a bright × (live 2026-11-03).
        lit ? (
          <Button key={key} label={` ${label} `} plain onPress={onPress}>
            <Text dimColor hover={lit}>{` ${label} `}</Text>
          </Button>
        ) : (
          <Button key={key} label={` ${label} `} plain dimColor onPress={onPress} />
        )
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
          const shown = tab === o.id
          // A tab and its × are one thing: the pointer on either lights both, as the pointer draws a tab
          // (tabLit), so the × reads as part of the tab (Jörgen 2026-11-03). The tab's Box joins the
          // group too: a Text inside a Button lights with it but does not set it off (seen live 2026-11-03: the
          // label lit, the × not), and the Box is the whole tab under the pointer. A desktop draws no hover.
          const lit = desk ? undefined : tabLit(o.id)
          return (
            <Box key={`tabbox:${o.id}`} flexDirection="row" {...(lit ? { hover: { scope: lit.scope } } : {})}>
              {tabButton(`tab:${o.id}`, label, o.id, showOpen(o), lit)}
              {/* The shown tab's × sits inside its pill, drawn as the pill (Jörgen 2026-10-31); the rest dim. A desktop
                  draws no fill, so there it stays dim: full strength is the shown tab's and the one thing to do.
                  On the terminal every × is `× `, the pill's own width, so a tab keeps its width when shown. */}
              <Button
                key={`close:${o.id}`}
                label="×"
                plain
                {...(shown && !desk ? { hover: { inverse: false } } : lit ? {} : { dimColor: true })}
                onPress={() => {
                  detach(setTabs($, x => closeTab(x, o.id)))
                  if (o.kind === 'channel') detach(update($, channel, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id))))
                  else detach(update($, threads, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id))))
                  // Its place goes too: View opens it again where it lands (first new, else newest), not where it was
                  // left (Jörgen 2026-11-01).
                  detach(update($, scrolls, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id))))
                }}
              >
                {shown && !desk ? (
                  <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillFg} weight="bold">{'× '}</Text>
                ) : lit ? (
                  <Text dimColor hover={lit}>{'× '}</Text>
                ) : undefined}
              </Button>
            </Box>
          )
        })}
      </Box>
    )

    /** A snippet as a record's line: the hits bright and bold, the rest dim (board Search). */
    const snippetSegs = (h: SearchHit): Seg[] =>
      // Fitted to the line (fitSnippet): a run past the pane's edge was drawn over the one before it.
      fitSnippet(oneLine(h.snippet_parts), e.props.bodyColumns - 2 * PANE_PAD - 3).map(p =>
        p.hit ? { text: p.text, weight: 'bold' as const } : { text: p.text, tone: 'dim' as const },
      )
    const heldHere = (id: string) => s.holds.some(h => h.threadId === id)
    const releaseAct = (id: string): Act => ({ key: 'release', label: 'Release', hotkey: 'r', onPress: act('release', { ref: id }) })
    /** Held's rows with the thread just handed over put back at its place, dim, `↪`, Undo drawn at rest. */
    const withHanded = (rows: Block[]): Block[] => {
      if (!undoing) return rows
      const u = undoing
      const label = u.title || 'thread'
      const ghost = recordBlock({
        id: u.threadId,
        label,
        title: [{ text: '↪ ' }, ...(u.channel ? [{ text: `#${u.channel} ` }] : []), { text: label }],
        dim: true,
        onOpen: () => detach(viewThread($, u.threadId, label)),
        meta: [{ text: `handed to ${u.place} · ${undoLeft}`, tone: 'dim' }],
        acts: [undoAct(u.threadId)],
        pin: true,
      })
      return [...rows.slice(0, u.at), ghost, ...rows.slice(u.at)]
    }
    const dot = { text: ' · ', tone: 'dim' as const }
    const dim = (text: string) => ({ text, tone: 'dim' as const })
    /** Where a thread matched, as the board says it: title, a reply count, the conclusion, its fields. */
    const whereText = (h: SearchHit) =>
      h.matched_in === 'message' ? (h.matching_replies === 1 ? '1 reply matches' : `${h.matching_replies ?? 0} replies match`) : h.matched_in ?? ''
    const threadHit = (h: SearchHit) => {
      const title = h.title ?? h.thread_id
      const age = quietFor(h.last_activity_at ?? null, now).age
      const meta2 = [whereText(h), h.kind ?? '', h.status ?? '', heldHere(h.thread_id) ? 'held by you' : '', age ? `${age} ago` : ''].filter(Boolean)
      return {
        id: h.thread_id,
        label: title,
        title: [{ text: `#${h.channel ?? ''}`, tone: 'brand' }, { text: ' ' }, { text: title, weight: 'semibold' }],
        onOpen: () => detach(viewThread($, h.thread_id, title)),
        meta: snippetSegs(h),
        meta2: meta2.flatMap((t, n) => (n ? [dot, dim(t)] : [dim(t)])),
        acts: [heldHere(h.thread_id) ? releaseAct(h.thread_id) : takeAct(h.thread_id)],
      } satisfies Parameters<typeof record>[0]
    }
    const messageHit = (h: SearchHit) => {
      const title = h.thread_title ?? h.thread_id
      const age = quietFor(h.created_at ?? null, now).age
      return {
        id: `msg-${h.message_id}`,
        label: title,
        title: [{ text: `#${h.channel ?? ''}`, tone: 'brand' }, { text: ' ' }, { text: title, weight: 'semibold' }],
        onOpen: () => detach(viewThread($, h.thread_id, title)),
        meta: snippetSegs(h),
        meta2: [h.sender ?? '', age ? `${age} ago` : ''].filter(Boolean).flatMap((t, n) => (n ? [dot, dim(t)] : [dim(t)])),
        acts: [],
      } satisfies Parameters<typeof record>[0]
    }
    // ── The pane's one shell (plan 2026-11-04-mod-pinned-every-tab-plan.md) ─────────────────────────────
    // Every tab draws the same way: the pane's chrome and the tab's head pinned at the top, its body in the
    // pane's one window, a rule and the key bar pinned as the pane's last rows. A tab only says what goes in
    // each part; how it is laid out, scrolled and followed by the keyboard is the shell's alone.
    const width = Math.max(10, e.props.bodyColumns - 2 * PANE_PAD)
    const one = (key: string, node: RenderElement | RenderElement[] | string, o: { space?: boolean } = {}): Block => ({
      key,
      rows: 1,
      ...o,
      draw: () => (
        <Box key={`row:${key}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
          {node}
        </Box>
      ),
    })
    /** Free text as rows of its own, wrapped here (mod/text.ts) so the window knows its height to the row. */
    const proseLines = (text: string) => plainLines(text, width).map(l => l.map(r => r.text).join(''))
    const prose = (key: string, text: string | string[], tone: Tone | 'red' = 'dim', o: { space?: boolean } = {}): Block => {
      const lines = (Array.isArray(text) ? text : [text]).flatMap(proseLines)
      const props = tone === 'red' ? { color: PALETTE.red } : paint(tone)
      return {
        key,
        rows: Math.max(1, lines.length),
        ...o,
        draw: () => (
          <Box key={`prose:${key}`} flexDirection="column" flexShrink={0}>
            {lines.map((l, n) => (
              <Box key={`prose:${key}:${n}`} height={1} overflow="hidden">
                <Text {...props} wrap="truncate-end">{l || ' '}</Text>
              </Box>
            ))}
          </Box>
        ),
      }
    }
    /** A record as a body block: its rows, its stop, the keys it draws (a held one with its picker under it). */
    const recordBlock = (r: Parameters<typeof record>[0], o: { space?: boolean; picker?: ReturnType<typeof picker> | null } = {}): Block => {
      const metaRows = [r.meta, r.meta2].filter(m => !!m?.length).length
      const p = o.picker ?? null
      return {
        key: `rec:${r.id}`,
        rows: 1 + metaRows + (p ? p.rows : 0),
        space: o.space,
        stop: true,
        focus: [`mark:${r.id}`, `open:${r.id}`, ...r.acts.map(a => `${a.key}:${r.id}`), ...(p ? p.keys : [])],
        draw: () => {
          if (!p) return record(r)
          // The picker's windows are stops after the record's mark: a move over the record's title or actions
          // (focusTarget) and the arrows go into it, not on to the next record (live 2026-11-05: with two held
          // rows the keyboard could not reach the picker).
          const head = record(r)
          drawn.push(...p.keys)
          return (
            <Box key={`recp:${r.id}`} flexDirection="column" flexShrink={0}>
              {head}
              {p.node}
            </Box>
          )
        },
      }
    }
    /** Blocks after the first get a blank row above them: a list's breathing room, counted. */
    /** A section's heading as a body block: one row, revealed with the section's first record. */
    const section = (key: string, title: string, note: string): Block => ({ ...one(key, heading(key, title, note)), section: true })
    const spaced = (blocks: Block[]) => blocks.map((b, n) => (n && b.space === undefined ? { ...b, space: true } : b))
    /** A head's title row: what the tab is on the left, how fresh it is on the right (thread chrome A, every tab). */
    // Only the title gives way when the row is short: what leads it (a thread's #channel), what follows it (a
    // channel's count) and the stamp keep their cells (live 2026-11-04: "#einweave-bac", "Updated" without its time).
    const titleRow = (key: string, parts: { lead?: RenderElement[]; title: RenderElement; tail?: RenderElement[]; right: RenderElement | null }) => ({
      rows: 1,
      node: (
        <Box key={key} flexDirection="row" columnGap={1} height={1} overflow="hidden">
          {(parts.lead ?? []).map((n, i) => (
            <Box key={`${key}:lead:${i}`} flexShrink={0}>
              {n}
            </Box>
          ))}
          <Box key={`${key}:title`} flexShrink={1} overflow="hidden">
            {parts.title}
          </Box>
          {(parts.tail ?? []).map((n, i) => (
            <Box key={`${key}:tail:${i}`} flexShrink={0}>
              {n}
            </Box>
          ))}
          <Box flexGrow={1} />
          {parts.right ? (
            <Box key={`${key}:right`} flexShrink={0}>
              {parts.right}
            </Box>
          ) : null}
        </Box>
      ),
    })
    const headLine = (key: string, text: string, props: Record<string, unknown>) => ({
      rows: 1,
      node: (
        <Box key={key} height={1} overflow="hidden">
          <Text {...props} wrap="truncate-end">{text}</Text>
        </Box>
      ),
    })
    const live = (key: string, lit: boolean, word: string, off: string) =>
      lit ? (
        <Box key={key} flexDirection="row">
          <Text color={PALETTE.brand}>● </Text>
          <Text dimColor>{word}</Text>
        </Box>
      ) : (
        <Text key={key} dimColor>{off}</Text>
      )
    const updated = (key: string, at: number | undefined) => (at !== undefined ? <Text key={key} dimColor>{`Updated ${clockOf(at)}`}</Text> : null)

    /** Board Search: Threads | Messages and the sort, pinned under the field while a query runs. */
    const searchKinds = () => {
      const pill = (key: string, label: string, shown: boolean, onPress: () => void) =>
        shown ? (
          <Button key={key} label={label} plain hover={{ inverse: false }} onPress={onPress}>
            <Text backgroundColor={PALETTE.pillBg} color={PALETTE.pillFg} weight="bold">{` ${label} `}</Text>
          </Button>
        ) : (
          <Button key={key} label={` ${label} `} plain dimColor onPress={onPress} />
        )
      const n = st.total ? `${st.total.count}${st.total.capped ? '+' : ''}` : ''
      return [
        // The results' section heading, as the Inbox's ("For you 16  questions…"): bold, a dim note. Says what
        // was searched, whatever the field shows (Enter empties it).
        { rows: 1, node: heading('h:results', 'Results', `for “${st.q.trim()}”`) },
        {
          rows: 1,
          node: (
            <Box key="search-kinds" flexDirection="row" columnGap={1} height={1} overflow="hidden">
              {pill('search-threads', st.type === 'threads' && n ? `Threads ${n}` : 'Threads', st.type === 'threads', () => detach(editSearch($, { type: 'threads' }, true)))}
              {pill('search-messages', st.type === 'messages' && n ? `Messages ${n}` : 'Messages', st.type === 'messages', () => detach(editSearch($, { type: 'messages' }, true)))}
              <Box flexGrow={1} />
              <Button key="search-clear" plain dimColor label="Clear" onPress={() => detach(editSearch($, { q: '' }, true))} />
              <Text dimColor>·</Text>
              {/* The sort the server USED (its echo): filters alone are newest first, with nothing to rank. */}
              {st.applied && !st.applied.words ? (
                <Text key="search-sorted" dimColor>newest first</Text>
              ) : (
                [
                  <Text key="search-sorted" dimColor>{(st.applied?.sort ?? st.sort) === 'newest' ? 'newest first ·' : 'best first ·'}</Text>,
                  <Button
                    key="search-sort"
                    plain
                    dimColor
                    label={(st.applied?.sort ?? st.sort) === 'newest' ? 'Best first' : 'Newest'}
                    onPress={() => detach(editSearch($, { sort: (st.applied?.sort ?? st.sort) === 'newest' ? 'relevance' : 'newest' }, true))}
                  />,
                ]
              )}
            </Box>
          ),
        },
      ]
    }
    /** Board Search: the rows, "Similar titles", More; or why nothing came. */
    const searchBlocks = (): Block[] => {
      if (st.refused) {
        const r = st.refused
        const sugs = r.suggestions
        return spaced([
          prose('search-refused', r.message, 'amber'),
          ...(sugs.length
            ? [
                {
                  key: 'search-suggest',
                  // A Button draws `[ label ]`: its cells, two between, wrapped as flex-wrap lays them out.
                  rows: tabRows(sugs.map(sg => cellWidth(sg) + 4), width, 2),
                  focus: sugs.map(sg => `suggest:${sg}`),
                  draw: () => (
                    <Box key="search-suggest" flexDirection="row" columnGap={2} flexWrap="wrap">
                      {sugs.map(sg => (
                        <Button key={`suggest:${sg}`} label={sg} onPress={() => detach(editSearch($, { q: applySuggestion(st.q, r.token, sg) }, true))} />
                      ))}
                    </Box>
                  ),
                },
              ]
            : []),
        ])
      }
      if (st.error) return [prose('search-error', st.error)]
      if (!st.rows.length)
        return st.loading
          ? [one('search-loading', <Text dimColor>Searching…</Text>)]
          : [prose('search-none', `Nothing matches ${st.q.trim()}.`, undefined), prose('search-none-hint', 'Fewer words, or drop a filter. Archived threads: add is:archived.', 'dim', { space: false })]
      const text = st.rows.filter(h => !h.similar_title)
      const similar = st.rows.filter(h => h.similar_title)
      return spaced([
        ...(st.type === 'messages' ? text.map(messageHit) : text.map(threadHit)).map(r => recordBlock(r)),
        ...(similar.length ? [section('h:similar', 'Similar titles', 'no word matched exactly')] : []),
        ...similar.map(threadHit).map(r => recordBlock(r)),
        ...(st.next ? [{ ...one('search-more', <Button key="search-more" plain dimColor label={st.loading ? 'Loading…' : 'More'} onPress={() => detach(runSearch($, true))} />), stop: true, focus: ['search-more'] }] : []),
      ])
    }

    /** A list's records, those quiet over a week under an "Older (n)" fold that opens in place. */
    const foldedBlocks = <T extends { old: boolean }>(name: string, rows: T[], draw: (r: T) => Block): Block[] => {
      const { recent, older } = fold(rows)
      const shown = recent.map(draw)
      if (!older.length) return shown
      const key = `fold:${name}`
      const isOpen = !!open[name]
      return [
        ...shown,
        {
          key,
          rows: 1,
          stop: true,
          focus: [key],
          draw: () => {
            drawn.push(key)
            return <Button key={key} plain dimColor label={`${isOpen ? '▾' : '▸'} Older (${older.length})`} onPress={() => detach(update($, unfolded, u => ({ ...u, [name]: !isOpen })))} />
          },
        },
        ...(isOpen ? older.map(draw) : []),
      ]
    }

    // The pane's chrome, the same on every tab: its header (the name, what is wrong and the way back, wrapping as
    // flex-wrap does; the detail under it while down), the gap, the tabs (wrapping) and their rule.
    const headerRows = headRowsOf + detailLines.length
    const tabsW = gated ? [tabWidth('Session', false)] : [`Inbox ${connected ? total : 0}`, `Held ${s.holds.length}`, 'Channels', 'Session'].map(l => tabWidth(l, false))
    const openW = gated ? [] : t.open.map(o => tabWidth(tabLabel(o.title), true))
    const chromeRows = headerRows + 1 + tabRows([...tabsW, ...openW], width) + 1

    let frame: Frame
    if (tab === 'inbox') {
      // Board Search: the field is the Inbox's head; a query replaces the sections with its results (their kinds
      // and sort pinned under it), clearing it brings them back. No field on mobile (no Input there): `/einweave search` is the way.
      const searching = !!Input && st.q.trim() !== ''
      const field = Input
        ? {
            rows: 4,
            node: (
              <Box key="search-field" flexDirection="column" flexShrink={0}>
                <Box height={1} overflow="hidden">
                  <Text dimColor>Search threads and messages</Text>
                </Box>
                {/* Bordered, as the board's field and Claude Code's own prompt box: bare, it read as a line of hint text (live check 2026-11-03). */}
                <Box key="search-box" flexDirection="row" borderStyle="round" borderColor={RULE} paddingX={1} height={3} overflow="hidden">
                  <Input
                    key={SEARCH_FIELD}
                    value={st.q}
                    placeholder={searchPlaceholder(e.props.bodyColumns - 2 * PANE_PAD - 4 - 10)}
                    submitLabel="search"
                    onInput={q => detach(editSearch($, { q }))}
                    onSubmit={q => detach(editSearch($, { q }, true))}
                  />
                  {/* An Input is as wide as its text: the rest of the box is this blank, which puts the keyboard
                      in the field, so a click anywhere in the box lands there (live check 2026-11-03). Clipped by the box.
                      A terminal only: a desktop draws every Button native, and its field is a native one. */}
                  {desk ? null : (
                    <Button key={SEARCH_FILL} plain dimColor label="Search" hover={{ inverse: false }} onPress={() => detach((async () => {
                        // The pane takes the keyboard first: a focus request waits, unanswered, while the
                        // prompt holds it (measured live 2026-11-04: `$.ui.focus` alone never answered).
                        await $.ui.open({ id: PANE, title: 'einweave', focus: true })
                        await $.ui.focus({ requestId: PANE, key: SEARCH_FIELD })
                      })())}>
                      {' '.repeat(Math.max(1, e.props.bodyColumns))}
                    </Button>
                  )}
                </Box>
              </Box>
            ),
          }
        : headLine('find-hint', 'Search: /einweave search <words>', { dimColor: true })
      const sections = (): Block[] => {
        const agent = s.session.agent ? `@${s.session.agent}` : 'this agent'
        return spaced([
          ...(waiting === 0 ? [prose('nothing', 'Nothing waits for this session.')] : []),
          ...(box.forYou.length ? [section('h:forYou', `For you ${forYouCount}`, 'questions and messages aimed at you')] : []),
          ...box.forYou.map(r => recordBlock(inboxRecordOf(r))),
          ...(box.open.length ? [section('h:open', `Unowned ${openCount}`, 'nobody holds these · newest first')] : []),
          // Board Unowned: whether the gateway routes these, brand when it does, amber while they wait for a take.
          ...(box.open.length && s.gateway
            ? [
                one(
                  'gateway',
                  s.gateway.online ? (
                    <Text key="gateway" color={PALETTE.brand} wrap="truncate-end">{`● gateway ${s.gateway.label ?? ''} online · routing, usually picked within a minute`}</Text>
                  ) : (
                    <Text key="gateway" color={PALETTE.amber} wrap="truncate-end">○ no gateway online · unheld work goes to sessions in scope, or waits for a take</Text>
                  ),
                ),
              ]
            : []),
          ...box.open.map(r => recordBlock(inboxRecordOf(r))),
          ...(s.waiting?.more ? [prose('more', 'More wait than shown: search, or /einweave take lists them all.')] : []),
          ...(box.open.length
            ? [prose('unowned-notes', [`Every session of ${agent} sees this list. The band stays for things aimed at you.`, 'Take brings it here. New session copies a command that starts another window and takes it there.'])]
            : []),
        ])
      }
      frame = {
        id: searching ? SEARCH_TAB : 'inbox',
        head: [field, ...(searching ? searchKinds() : [])],
        blocks: !connected ? [prose('not-connected', 'Not connected: what waits shows once this session is.')] : searching ? searchBlocks() : sections(),
        keys: null,
        anchor: 'top',
      }
    } else if (tab === 'held') {
      frame = {
        id: 'held',
        head: [
          titleRow('head:held', { title: <Text key="t" weight="bold" wrap="truncate-end">{`Held ${s.holds.length}`}</Text>, right: live('stamp', connected, 'live', '○ not connected') }),
          headLine('head:held:line', 'held by you · replies to these come here', { color: PALETTE.brand }),
        ],
        blocks: !connected
          ? [prose('not-connected', 'Not connected.')]
          : s.holds.length === 0 && !undoing
            ? [prose('none', 'None. Take one from the Inbox.')]
            : spaced(
                // Board Held (Jörgen 2026-11-03): rows as the Inbox's, Release and Hand over on the row, the picker under it.
                // A thread just handed over keeps its place for UNDO_MS, as a dim row with Undo: the same record (its
                // mark's key unchanged, so the keyboard stays on it), the same footer (`u Undo`).
                withHanded(s.holds.filter(h => h.threadId !== undoing?.threadId).map(held => {
                  const r = heldRow(held, now)
                  return recordBlock(
                    {
                      id: r.threadId,
                      label: r.title,
                      title: r.channel ? [{ text: `#${r.channel}`, tone: 'brand' }, { text: ' ' }, { text: r.title, weight: 'semibold' }] : undefined,
                      onOpen: () => detach(viewThread($, r.threadId, r.title)),
                      meta: r.meta.length ? r.meta : undefined,
                      acts: [releaseAct(r.threadId), handoverAct(r.threadId)],
                    },
                    { picker: picking === r.threadId && !desk ? picker(r.threadId) : null },
                  )
                })),
              ),
        keys: null,
        anchor: 'top',
      }
    } else if (tab === 'channels') {
      const who = ch.agent ? `@${ch.agent}` : 'This agent'
      const n = ch.channels.length
      frame = {
        id: 'channels',
        head: [
          titleRow('head:channels', { title: <Text key="t" weight="bold" wrap="truncate-end">{ch.loading && !n ? 'Channels' : `Channels ${n}`}</Text>, right: updated('stamp', ch.at) }),
          headLine('head:channels:line', ch.loading && !n ? 'Loading…' : `${who} is in ${n} · every session of the agent shares them`, { dimColor: true }),
        ],
        blocks: spaced([
          ...(ch.error ? [prose('error', ch.error, 'red')] : []),
          ...(!ch.loading && !ch.error && !n ? [prose('empty', `${who} isn't in any channels · set up in the web app`)] : []),
          ...ch.channels.map(c =>
            recordBlock({
              id: `ch:${c.id}`,
              label: `#${c.name}`,
              title: [{ text: `#${c.name}`, tone: 'brand' }],
              onOpen: () => detach(viewChannel($, c.id, c.name)),
              meta: [{ text: [channelMeta(c.threads, now), c.role ? null : 'following, not a member'].filter(Boolean).join(' · '), tone: 'dim' }],
              acts: [],
            }),
          ),
          prose('outro', 'Join, leave and private channels: in the web app.'),
        ]),
        keys: null,
        anchor: 'top',
      }
    } else if (tab === 'session') {
      const sess = s.session
      // Board Main: a label / value grid, the labels dim; each one row.
      const row = (key: string, label: string, value: ReturnType<typeof Text> | ReturnType<typeof Text>[] | null) => (
        <Box key={`row:${key}`} flexDirection="row" height={1} overflow="hidden">
          <Box width={10} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1}>
            {value}
          </Box>
        </Box>
      )
      const grid = [
        row('state', 'State', connected ? <Text color={PALETTE.brand}>● connected</Text> : runs('state', stateLine(v, now))),
        row('agent', 'Agent', <Text>{sess.agent ? `@${sess.agent}` : '-'}</Text>),
        Input && connected
          ? row('label', 'Session', <Input key="label" value={sess.label ?? ''} placeholder="this session's name" submitLabel="Rename" onSubmit={(label: string) => act('set_session_label', { label })()} />)
          : row('label', 'Session', <Text>{sess.label ?? '-'}</Text>),
        row('kind', 'Kind', <Text>{sess.kind ?? 'session'}</Text>),
        sess.scope && Select
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
            : null,
        row(
          'plugin',
          'Plugin',
          s.staleSince ? [<Text key="v">{s.version}</Text>, <Text key="st" color={PALETTE.amber}>· updated on disk: restart Claude Code to use it</Text>] : <Text>{s.version}</Text>,
        ),
      ].filter((x): x is NonNullable<typeof x> => !!x)
      frame = {
        id: 'session',
        head: [
          titleRow('head:session', { title: <Text key="t" weight="bold" wrap="truncate-end">Session</Text>, right: connected ? live('stamp', true, 'connected', '') : <Box key="stamp" flexDirection="row">{runs('stamp', stateLine(v, now))}</Box> }),
          headLine('head:session:line', `${sess.agent ? `@${sess.agent}` : 'this agent'} · this window's einweave`, { dimColor: true }),
        ],
        blocks: spaced([
          ...(gated ? [prose('gate', 'Connect to see the Inbox, held threads and channels.')] : []),
          {
            key: 'grid',
            rows: grid.length,
            stop: true,
            focus: ['label', 'scope'],
            draw: () => (
              <Box key="grid" flexDirection="column" flexShrink={0}>
                {grid}
              </Box>
            ),
          },
          // Said once here, not on every thread tab (Jörgen 2026-11-01).
          prose('note', 'Thread tabs are read-only and cost no tokens. new stays new until it reaches Claude.'),
          {
            ...one(
              'session-acts',
              connected
                ? [<Button key="disconnect" label="Disconnect" onPress={act('disconnect', {})} />, <Button key="logout" label="Sign out" dimColor onPress={act('logout', {})} />]
                : [
                    // The header's way back, drawn the same: plain, bold brand brackets (Jörgen 2026-10-31).
                    <Button key="connect-s" plain label="Connect" onPress={() => detach(connect($).then(toastFirst($)))}>
                      <Text color={PALETTE.brand} weight="bold">[ Connect ]</Text>
                    </Button>,
                    <Button key="logout" label="Sign out" dimColor onPress={act('logout', {})} />,
                  ],
            ),
            stop: true,
            focus: ['disconnect', 'connect-s', 'logout'],
          },
        ]),
        keys: null,
        anchor: 'top',
      }
    } else if (t.open.find(x => x.id === tab)?.kind === 'channel') {
      const id = tab
      const cv = (await read($, channel))[id] ?? NO_CHANNEL
      const row = ch.channels.find(c => c.id === id)
      // Take is refused outside membership; a row not (yet) in the Channels list is not judged here.
      const member = row ? row.role !== null : true
      const { rows, more } = channelRows(cv.threads)
      const name = t.open.find(x => x.id === id)?.title ?? id
      frame = {
        id,
        head: [
          titleRow('head:channel', {
            title: <Text key="n" color={PALETTE.brand} weight="bold" wrap="truncate-end">{name}</Text>,
            tail: row?.threads ? [<Text key="c" dimColor>{`${row.threads.open} open`}</Text>] : [],
            right: updated('stamp', cv.at),
          }),
          headLine('head:channel:line', member ? 'Open threads, latest activity first.' : 'Following, not a member: join in the web app to take.', { dimColor: true }),
        ],
        blocks: spaced([
          ...(cv.error ? [prose('error', cv.error, 'red')] : []),
          ...(cv.loading && !cv.threads.length ? [one('loading', <Text dimColor>Loading…</Text>)] : []),
          ...(!cv.loading && !cv.error && !cv.threads.length ? [prose('empty', 'No threads yet.')] : []),
          ...foldedBlocks(
            `ch:${id}`,
            rows.map(th => ({ ...th, ...quietFor(th.lastActivityAt, now) })),
            th => {
              const here = s.holds.some(h => h.threadId === th.id)
              const badge = holdBadge(th.hold, here)
              // `open` is every live thread's status: only the others are said.
              const status = th.resolved ? 'resolved' : th.status === 'open' ? null : th.status
              const rest = [status, th.kind, th.age].filter(Boolean).join(' · ')
              return recordBlock({
                id: th.id,
                label: th.title || th.id,
                dim: th.resolved,
                onOpen: () => detach(viewThread($, th.id, th.title || th.id)),
                meta: [
                  ...(badge ? [{ text: badge.text, tone: th.resolved ? ('dim' as const) : badge.tone }] : []),
                  ...(badge && rest ? [{ text: ' · ', tone: 'dim' as const }] : []),
                  ...(rest ? [{ text: rest, tone: 'dim' as const }] : []),
                ],
                acts: here || !member || th.resolved ? [newAct(th.id)] : [takeAct(th.id, () => loadChannel($, id), badge?.asks), newAct(th.id)],
              })
            },
          ),
          ...(more ? [prose('more', `${more} more in the web app.`)] : []),
          prose('hint', 'View opens the Thread tab. Take from an online holder asks first.'),
        ]),
        keys: null,
        anchor: 'top',
      }
    } else {
      const id = tab
      const th = (await read($, threads))[id] ?? NO_THREAD
      const title = th.title ?? t.open.find(x => x.id === id)?.title ?? id
      const held = s.holds.some(h => h.threadId === id)
      const picks = held && picking === id
      // A desktop draws links itself; a terminal only when it draws OSC 8.
      const links = desk || (await terminalLinks($))
      const sc = places[id]
      const layout = threadLayout(th.messages, width, sc?.open ?? {}, th.older, links, th.work ?? null)
      const optionClick = !links && (await isAppleTerminal($))
      // A desktop has no hotkeys: there the key bar is labels alone.
      const hot = (key: string) => (desk ? {} : { hotkey: key })
      const expand = (key: string, more: number) => () =>
        detach(update($, scrolls, m => {
          const was = m[id]
          const w = win
          // Opened in place: the rows it gains push what is under it down, so its first line stays where it was.
          const from = w && w.id === id ? windowOff(was, w.stack, w.room, w.land, w.anchor) : 0
          return { ...m, [id]: { off: from + (from > 0 ? more - 1 : 0), newest: w && w.id === id ? newestKey(w.stack) : '', open: { ...(was?.open ?? {}), [key]: true as const } } }
        }))
      const line = (key: string, l: Line) => (
        <Box key={key} flexDirection="row" height={1} overflow="hidden">
          {l.length
            ? l.map((r, n) => (
                <Text
                  key={`${key}:${n}`}
                  wrap="truncate-end"
                  {...(r.href || r.link ? { color: PALETTE.blue, underline: true } : r.mention === 'active' ? { color: PALETTE.brand } : r.dim ? { dimColor: true } : {})}
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
      const post = (b: (typeof layout.blocks)[number]) => {
        const m = th.messages[b.n]!
        const tint = m.own ? PALETTE.blue : senderColor(m.senderId)
        const head = b.head
        return (
          <Box key={`post:${id}:${b.key}`} flexDirection="column" flexShrink={0} marginTop={b.space ? 1 : 0}>
            {typeof head === 'object' ? (
              // A work item's field under its label; the required ones still blank in amber, as the web.
              <Box flexDirection="row" height={1} overflow="hidden">
                <Text wrap="truncate-end" {...(head.missing ? { color: PALETTE.amber } : { dimColor: true })}>{head.label}</Text>
              </Box>
            ) : (
              <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
                <Text weight="bold" {...(tint ? { color: tint } : {})}>{`${m.sender ?? '?'}${m.own ? ' (you)' : ''}`}</Text>
                {head === 'filed' ? <Text dimColor>filed this</Text> : null}
                {m.ts ? <Text dimColor>{timeOf(m.ts)}</Text> : null}
                {m.type !== 'text' && head !== 'filed' ? <Text color={PALETTE.amber}>{m.type}</Text> : null}
                <Box flexGrow={1} />
                {m.new ? <Text color={PALETTE.brand} weight="bold">new</Text> : null}
              </Box>
            )}
            {/* Every surface draws the server's doc as these lines (RFC-034 D6): no Markdown parsed here. A desktop
                shows the whole post (its surface scrolls), so no cap there. */}
            {(desk ? b.all : b.lines).map((l, n) => line(`ln:${id}:${b.key}:${n}`, l))}
            {b.more && !desk ? (
              <Button key={`more:${id}:${b.key}`} plain dimColor label={`▸ ${b.more} more ${b.more === 1 ? 'line' : 'lines'}`} onPress={expand(b.key, b.more)} />
            ) : null}
          </Box>
        )
      }
      // Under the root: how many older replies the tab has not read, and the way to them.
      const gapBlock: Block | null = layout.gap
        ? {
            key: 'gap',
            rows: layout.gap.rows,
            draw: () => (
              <Box key={`gap:${id}`} flexDirection="row" columnGap={1} marginTop={1} height={1} overflow="hidden" flexShrink={0}>
                <Text dimColor>{`${th.older ?? 'Some'} older ${th.older === 1 ? 'reply' : 'replies'}`}</Text>
                {th.loadingOlder ? (
                  <Text dimColor>Loading…</Text>
                ) : (
                  <Button key={`older:${id}`} plain dimColor label={`Load ${OLDER_PAGE} older ↑`} onPress={() => detach(loadOlder($, id))} />
                )}
              </Box>
            ),
          }
        : null
      // The posts in the layout's own order (the gap under the root), each block its rows; the notes above them.
      const postBlocks: Block[] = layout.blocks.map(b => ({ key: b.key, rows: b.rows, draw: () => post(b) }))
      const gapAt = layout.gap ? layout.blocks.findIndex(b => b.top >= layout.gap!.top) : -1
      const ordered = gapBlock ? (gapAt < 0 ? [...postBlocks, gapBlock] : [...postBlocks.slice(0, gapAt), gapBlock, ...postBlocks.slice(gapAt)]) : postBlocks
      const notes = [
        ...(th.error ? [prose('err', th.error, 'red')] : []),
        ...(th.loading && !th.messages.length ? [one('loading', <Text dimColor>Loading…</Text>)] : []),
      ]
      // The picker fits the body's window: the room left under the thread's head (title, work line, hold line).
      const pick = picks ? picker(id, Math.max(3, e.props.scroll.bodyRows - chromeRows - (2 + (th.work ? 1 : 0)) - 3)) : null
      frame = {
        id,
        head: [
          // Board ThreadTab, chrome A (Jörgen 2026-11-01): #channel and title, how fresh at the right; a work
          // item's line; the hold line. The shell's rule under it, so the posts start below the header.
          titleRow('head:thread', {
            lead: th.channel ? [<Text key="ch" color={PALETTE.brand}>{`#${th.channel}`}</Text>] : [],
            title: <Text key="title" weight="bold" wrap="truncate-end">{title}</Text>,
            // Live only while it is: held AND connected, else replies are not arriving (Jörgen 2026-11-04: brand dot, dim word, no pulse).
            right: held ? live('stamp', connected, 'live', '○ reconnecting') : updated('stamp', th.at),
          }),
          ...(th.work
            ? [
                {
                  rows: 1,
                  node: (
                    // A work item's line (RFC-029 D2, Jörgen 2026-11-04: kind · status · assignee, no ticking age).
                    <Box key="work" flexDirection="row" height={1} overflow="hidden">
                      <Text dimColor>{`${th.work.kind} · `}</Text>
                      <Text weight="bold">{th.work.status.replace(/_/g, ' ')}</Text>
                      {th.work.resolvedReason ? <Text dimColor>{` (${th.work.resolvedReason.replace(/_/g, ' ')})`}</Text> : null}
                      <Text dimColor>{' · '}</Text>
                      {th.work.assignee ? <Text wrap="truncate-end">{th.work.assignee}</Text> : <Text dimColor>no assignee</Text>}
                    </Box>
                  ),
                },
              ]
            : []),
          undoing?.threadId === id
            ? headLine('head:thread:line', `handed to ${undoing.place} · Undo puts it back here · ${undoLeft}`, { dimColor: true })
            : held
            ? headLine('head:thread:line', 'held by you · replies come here', { color: PALETTE.brand })
            : headLine('head:thread:line', 'not held here · Claude has not seen it · Take brings it here', { color: PALETTE.amber }),
        ],
        // Hand over's picker takes the body while open (Jörgen 2026-11-04, option B): the head and key bar stay
        // pinned, and Cancel brings the posts back where they were.
        blocks: pick ? [{ key: 'picker', rows: pick.rows, stop: true, focus: pick.keys, draw: () => pick.node }] : [...notes, ...ordered],
        // The key bar: the thread's actions on their keys (`t: Take`), whatever has the keyboard.
        keys: (
          <Box key={`acts:${id}`} flexDirection="row" columnGap={1}>
            {held ? (
              <Box key={`held-acts:${id}`} flexDirection="row" columnGap={1}>
                <Button key={`release:${id}`} plain {...hot('r')} label="Release" dimColor onPress={act('release', { ref: id })} />
                <Text dimColor>·</Text>
                <Button key={`handover:${id}`} plain {...hot('h')} label="Hand over" dimColor onPress={togglePicker(id)} />
              </Box>
            ) : undoing?.threadId === id ? (
              <Button key={`undo:${id}`} plain {...hot('u')} label="Undo" onPress={undoAct(id).onPress} />
            ) : (
              <Button key={`take:${id}`} plain {...hot('t')} label="Take" onPress={take(id)} />
            )}
            <Text dimColor>·</Text>
            <Button key={`new:${id}`} plain {...hot('n')} label="New session" dimColor onPress={newSession(id)} />
            {held ? null : <Text key="sep:refresh" dimColor>·</Text>}
            {held ? null : <Button key={`refresh:${id}`} plain label="↻ Refresh" dimColor onPress={() => detach(loadThread($, id))} />}
          </Box>
        ),
        right: [...(optionClick ? [<Text key="hint:links" dimColor>⌥-click a URL to open it ·</Text>] : []), <Text key="ro" dimColor>read-only</Text>],
        anchor: 'end',
        land: (stk, room) => (pick ? stk.total : landOff(layout, th.messages, room)),
        onTop: th.older !== 0 && !th.loadingOlder && !pick ? () => detach(loadOlder($, id)) : undefined,
      }
    }

    // ── The shell draws the frame ──────────────────────────────────────────────────────────────────
    // Rows the pinned parts take: the pane's header (+ the detail under it while down), the gap, the tabs and
    // their rule; the tab's head and its rule; the key bar under its rule.
    const headRows = frame.head.reduce((a, h) => a + h.rows, 0)
    const pinned = chromeRows + headRows + 1 + 2
    const blocks = frame.blocks.map(b => ({ ...b, rows: b.rows + (b.space ? 1 : 0) }))
    const body = stack(blocks)
    const bodyRows = e.props.scroll.bodyRows
    // The terminal scrolls the body itself: docked, the pane is the frame's height, its key bar on the last row;
    // inline the frame fits the tree, so there the window is needed only once the tree does not fit. A pane too
    // short for its pinned parts and MIN_ROOM rows of body flows instead, and the engine scrolls all of it (inline
    // above the prompt on a short terminal, live 2026-11-04). A desktop scrolls its own surface: there the parts
    // flow, in the same order. The same rule on every tab.
    const dock = e.props.placement === 'dock'
    const own = !desk && bodyRows >= pinned + MIN_ROOM && (dock || pinned + body.total > bodyRows)
    const room = own ? bodyRows - pinned : body.total
    const sc = places[frame.id]
    const land = frame.land ? frame.land(body, room) : Math.max(0, body.total - room)
    const off = own ? windowOff(sc, body, room, land, frame.anchor) : 0
    const reveal = new Map<string, string>()
    for (const b of blocks) for (const k of b.focus ?? []) reveal.set(k, b.key)
    win = own ? { id: frame.id, stack: body, room, land, anchor: frame.anchor, reveal, onTop: frame.onTop } : null
    // Only what meets the window is drawn, and every block holding a keyboard stop (Tab must reach it): a long
    // thread drawn whole made each wheel tick slow enough for the engine to show its own window a row or two off
    // the tree meanwhile (a flicker, live 2026-11-01). What is not drawn is one empty box per run, so every
    // block keeps its row.
    const foot = body.total - off
    const nodes: RenderElement[] = []
    let skipped = 0
    const flush = () => {
      if (skipped) nodes.push(<Box key={`skip:${frame.id}:${nodes.length}`} height={skipped} flexShrink={0} />)
      skipped = 0
    }
    for (const b of body.blocks) {
      const meets = !own || (b.top < foot && b.top + b.rows > foot - room)
      if (!meets && !b.stop) {
        skipped += b.rows
        continue
      }
      flush()
      nodes.push(
        b.space ? (
          <Box key={`blk:${frame.id}:${b.key}`} flexDirection="column" marginTop={1} flexShrink={0}>
            {b.draw()}
          </Box>
        ) : (
          b.draw()
        ),
      )
    }
    if (own) flush()
    // The keyboard's element left the list (Release, the picker closing, Undo running out): put the ring on
    // its record or the next one, before the engine re-homes it by position. Same tab only: a tab change
    // puts it on the tab itself (setTabs).
    const bodyKeys = frame.blocks.flatMap(b => b.focus ?? [])
    const refocus = keys && bodyWas.frame === frame.id ? refocusTarget(bodyWas, { keys: bodyKeys, stops: drawn }, last) : undefined
    bodyWas = { frame: frame.id, keys: bodyKeys, stops: drawn }
    stops = drawn
    if (refocus) {
      last = refocus
      detach($.ui.focus({ requestId: PANE, key: refocus }).catch(() => {}))
    }
    const rule = (key: string) => (
      <Box key={key} height={1} flexShrink={0}>
        <Text color={RULE}>{'─'.repeat(width)}</Text>
      </Box>
    )
    // The key bar, the pane's last row on every tab: the actions of what is selected, on their keys (the thread,
    // or the record the keyboard is on); else the keys that work now. At its right end, the rows the window hides.
    // Not on the pane: the key that puts the keyboard here. ctrl+x tab stops at every band Button first, so a
    // chord bound to PANE_ACTION presses this from the prompt, past the band (/einweave bind; live 2026-11-05).
    const chord = desk || keys ? null : await boundChord($)
    const resting = desk ? null : keys ? (
      <Text key="rest" dimColor>{tab === 'session' ? 'tab: next · esc: back' : 'tab: next · enter: open · esc: back'}</Text>
    ) : (
      <Button key="rest" plain dimColor action={PANE_ACTION} label={`${chord ?? 'ctrl+x tab'}: keys`} onPress={() => detach($.ui.open({ id: PANE, title: 'einweave', focus: true }))} />
    )
    const left =
      frame.keys ??
      (footOn ? (
        <Box key="footacts" flexDirection="row">
          {footActs.map((a, n) => (
            <Box key={`footact:${a.key}`} flexDirection="row">
              {n ? <Text dimColor> · </Text> : null}
              <Button key={`foot:${a.key}`} plain hotkey={a.hotkey} label={a.label} onPress={a.onPress} />
            </Box>
          ))}
          <Text dimColor>{`${footActs.length ? ' · ' : ''}enter: open · esc: back`}</Text>
        </Box>
      ) : (
        resting
      ))
    const cue = own ? cueText(hidden(body, off, room)) : ''
    const bar = (
      <Box key={`keys:${frame.id}`} flexDirection="row" columnGap={1} height={1} overflow="hidden">
        {left}
        <Box flexGrow={1} />
        {cue ? <Text key="cue" dimColor>{cue}</Text> : null}
        {cue && frame.right?.length ? <Text key="cue-sep" dimColor>·</Text> : null}
        {frame.right ?? null}
      </Box>
    )
    const parts = [
      header,
      gap,
      tabRow,
      rule('rule:tabs'),
      ...frame.head.map(h => h.node),
      rule('rule:head'),
      own ? (
        // Bottom-anchored once it overflows: the window's foot `off` rows up from the body's end. One that fits
        // starts under the head.
        <Box key={`body:${frame.id}`} flexDirection="column" height={room} overflow="hidden" justifyContent={body.total > room ? 'flex-end' : 'flex-start'} flexShrink={0}>
          <Box flexDirection="column" marginBottom={-off} flexShrink={0}>
            {nodes}
          </Box>
        </Box>
      ) : (
        <Box key={`body:${frame.id}`} flexDirection="column" flexGrow={1}>
          {nodes}
        </Box>
      ),
      rule('rule:foot'),
      bar,
    ]
    // Spacer rows above as many as the engine's window is down, the rest below: at row 0, where ui.scroll
    // holds it, both below; on a row the engine reached itself (a clamp, a held element kept in view) it still
    // shows exactly the pane. A fixed top spacer showed until the first scroll (Jörgen 2026-11-01).
    // Docked only: inline the engine draws rows past the frame as its own "n more" (live 2026-11-04), so there
    // the tree is exactly the frame; the wheel, page keys and the ring still move the window, the arrows do not.
    const spare = dock ? 2 : 0
    const lead = Math.min(spare, Math.max(0, e.props.scroll.offset))
    if (own)
      return (
        // Exactly the window and (docked) two spacer rows: the engine always has rows to scroll, so its wheel and
        // arrows fire (live 2026-11-01: at row 0, up and down).
        <Box key="pane" flexDirection="column" paddingX={PANE_PAD} height={bodyRows + spare}>
          {lead ? <Box key="spacer:top" height={lead} flexShrink={0} /> : null}
          {parts}
          {lead < spare ? <Box key="spacer:end" height={spare - lead} flexShrink={0} /> : null}
        </Box>
      )
    return (
      // Flowing (a desktop, or inline where it fits): docked, at least the pane's height, the body growing into it,
      // so the key bar sits on the pane's last row there too.
      <Box key="pane" flexDirection="column" paddingX={PANE_PAD} minHeight={e.props.placement === 'dock' ? bodyRows : undefined}>
        {parts}
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
