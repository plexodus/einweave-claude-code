/**
 * The mod's wiring to `$` (mod/register.tsx), in Claude Code's own test kit: `bun run test:mod`.
 * The rules themselves (indicator, grace, verbs) are unit-tested in test/mod-model.test.ts.
 *
 * Each test stands in for the plugin's MCP server (`mcp.call`) and the relay child
 * (`process.spawn`), so nothing here needs a running plugin.
 */
import { expect, mock, test } from 'claude-code/testing'

import type { UiSnapshot } from '../types'
import { PALETTE, senderColor } from './model'

const SNAP: UiSnapshot = {
  v: 1,
  connection: { state: 'connected', detail: null },
  session: { agent: 'bellman', label: 'probe', kind: 'session', scope: { mode: 'none', channelIds: [] } },
  holds: [{ threadId: 't1', title: 'Fix the build' }],
  waiting: { forYou: 2, channel: 0, more: false, top: [] },
  version: '0.38.0',
  staleSince: null,
}
const DOWN: UiSnapshot = { ...SNAP, connection: { state: 'disconnected', detail: 'disconnected (reconnect attempt 3, in 8s)' }, holds: [], waiting: null }
const line = (rev: number, state: UiSnapshot) => JSON.stringify({ ok: true, op: 'watch', rev, state }) + '\n'
const text = (t: string) => ({ content: [{ type: 'text', text: t }], isError: false })

const HINT = { plugin: 'einweave', component: 'PromptHint', surface: 'terminal', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const
const BAND = { plugin: 'einweave', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const
const PANE = {
  plugin: 'einweave',
  component: 'Pane',
  requestId: 'einweave',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'einweave', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Call = { tool: string; args: Record<string, unknown> }

/**
 * The engine under the mod: `ui_state` answers `polled` at `polledRev` as Claude Code does, in the
 * text block only (its `$.mcp.call` drops structuredContent, measured 2026-10-29); the server
 * connects `connectAfterMs` after the session starts. The relay writes `pushed` (or, per start,
 * `pushes[n]`) and then exits, or stays open with `stayOpen`; other tools answer `answer(tool)`.
 * Every MCP call and relay start is recorded.
 */
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  o: { engineVersion?: string | null; env?: Record<string, string>; now?: number; polled?: UiSnapshot | null; polledRev?: number; connectAfterMs?: number; pushed?: string[]; pushes?: string[][]; stayOpen?: boolean; hang?: boolean; answer?: (c: Call) => unknown } = {},
) {
  const calls: Call[] = []
  const spawns: { env?: Record<string, string> }[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, o.now === undefined ? undefined : { now: o.now })
  // The server connects on its own, connectAfterMs after the session starts; until then a call fails as Claude Code's does.
  let connected = !o.connectAfterMs
  on('session.start', () => {
    if (!connected) void clock.sleep(o.connectAfterMs!).then(() => (connected = true))
    return { cwd: '/work' }
  })
  on('session.end', () => ({ sessionId: 's1' }))
  on('classic.SessionStart', () => ({}))
  // The process environment the mod reads: a terminal with OSC 8 links unless the test names another.
  on('env.get', (_$, e) => ({ value: (o.env ?? { TERM_PROGRAM: 'iTerm.app' })[e.name] }))
  // The engine's version: a current one unless the test names another; null, an engine without the call.
  on('session.version', () => {
    if (o.engineVersion === null) throw new Error('$.session.version is not a function')
    const v = o.engineVersion ?? '2.1.317'
    return { value: { version: v, base: v, builtAt: '2026-11-01T00:00:00Z' } }
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  // The engine's record of the pane: open, listed, closed.
  const pane = { up: false, opens: 0 }
  on('ui.open', () => {
    pane.up = true
    pane.opens++
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: pane.up ? [{ id: 'einweave', title: 'einweave', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.close', () => {
    pane.up = false
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('mcp.connect', async ($, e) => {
    // The plugin's own manifest names the server `einweave`; any other name is not the mod's to connect.
    if (e.server !== 'einweave') return { value: { isConnected: false, reason: 'unlisted', message: `${e.server} is not in this plugin's manifest` } }
    while (!connected) await clock.sleep(100)
    return { value: { isConnected: true, server: 'plugin:einweave:einweave' } }
  })
  on('mcp.call', async ($, e) => {
    calls.push({ tool: e.tool, args: e.args })
    if (!connected) throw new Error(`no connected MCP tool "${e.tool}" on a server named "plugin:einweave:einweave"`)
    if (o.hang) return new Promise<never>(() => {})
    if (e.tool === 'ui_state') return { value: o.polled === null ? { content: [], isError: true } : text(JSON.stringify({ rev: o.polledRev ?? 1, ...(o.polled ?? SNAP) })) }
    return { value: (await o.answer?.({ tool: e.tool, args: e.args })) ?? text(`${e.tool} done`) }
  })
  on('process.spawn', async function* ($, e) {
    spawns.push({ env: e.env })
    for (const l of o.pushes?.[spawns.length - 1] ?? o.pushed ?? []) yield { stream: 'stdout' as const, text: l }
    if (o.stayOpen) await clock.sleep(10 ** 12)
    // A call on $, so its result comes back as { value }.
    return { value: { code: 0, signal: null } } as never
  })
  // The engine's own drawing, which records the hint tail handed on.
  const tails: (string | undefined)[] = []
  on('ui.render', ($, e) => {
    if (e.component === 'PromptHint') tails.push((e.props as { tail?: string }).tail)
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] }
  })
  return { calls, spawns, toasts, tails, clock, registered, pane }
}

/** What the band says of einweave: its label, then its state line (the counts or what went wrong), as read. */
const said = async (band: { find(q: object): Promise<{ text?: string } | undefined> }) => {
  const state = await band.find({ key: 'state' })
  return state ? `einweave · ${state.text}` : undefined
}

/** The shown tab (board Main): a filled pill, bold. A desktop draws its own button, so it is also not dim. */
const PILL = { backgroundColor: '#e4e4e4', color: '#121212', weight: 'bold' }
const shownPill = (b: { props: object; children?: unknown[] } | undefined) => {
  expect(b?.props).not.toHaveProperty('dimColor')
  expect((b?.children?.[0] as { props?: object } | undefined)?.props).toMatchObject(PILL)
}

/**
 * A styled run as drawn: a record's line is ONE Text whose runs are inline Text children (register.tsx,
 * live check 2026-11-04), so the run carrying a style is found inside it. A plain Text with that one
 * string is found as before.
 */
/** A record's first meta row: the second child of its keyed Box (the title row first). */
async function metaRow(ui: { find: (q: any) => Promise<unknown> }, id: string): Promise<any> {
  return ((await ui.find({ key: `rec:${id}` })) as any)?.children?.[1]
}

async function findRun(ui: { findAll: (q: { type: 'Text' }) => Promise<unknown[]>; find: (q: any) => Promise<unknown> }, text: any): Promise<any> {
  const walk = (n: any): any => {
    if (!n || typeof n !== 'object') return undefined
    if (n.type === 'Text' && Array.isArray(n.children) && n.children.length === 1 && n.children[0] === text) return n
    for (const c of n.children ?? []) {
      const r = walk(c)
      if (r) return r
    }
    return undefined
  }
  if (typeof text === 'string') {
    for (const t of await ui.findAll({ type: 'Text' })) {
      const r = walk(t)
      if (r) return r
    }
  }
  // Not one run of a line: the kit's own match (a matcher, a whole Text).
  return ui.find({ type: 'Text', text })
}

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], clock: { settle(): Promise<void> }) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
}

test('the hint tail shows the first snapshot, then what the relay pushes', async ($, on) => {
  const { clock } = engine(on, { pushed: [line(2, { ...SNAP, holds: [...SNAP.holds, { threadId: 't2', title: null }] })] })
  await start($, clock)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · holds 2 · 2 for you')
  await ui.unmount()
})

test('the band is always there: what waits, dim, and Show / Hide for the pane (no hotkey); the hint line no longer says it', async ($, on) => {
  const { pane, tails, clock } = engine(on)
  await start($, clock)
  const band = await $.ui.mount(BAND)
  expect(await said(band)).toBe('einweave · holds 1 · 2 for you')
  // The canvas (boards Main, Indicator): the label bold in the brand colour, what is aimed at you amber.
  expect(await findRun(band, 'einweave')).toMatchObject({ props: { color: '#4cc3ad', weight: 'bold' } })
  expect(await findRun(band, '2 for you')).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await band.find({ key: 'connect' })).toBeUndefined()
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Show pane ]', dimColor: true } })
  // A bare letter in an empty composer presses a band Button that has a hotkey.
  expect((await band.find({ key: 'pane' }))?.props.hotkey).toBeUndefined()
  await band.press({ key: 'pane' })
  await clock.settle()
  expect(pane).toMatchObject({ up: true, opens: 1 })
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Hide pane ]', dimColor: true } })
  await band.press({ key: 'pane' })
  await clock.settle()
  expect(pane).toMatchObject({ up: false, opens: 1 })
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Show pane ]', dimColor: true } })
  await band.unmount()
  const hint = await $.ui.mount(HINT)
  expect(tails).toEqual([undefined])
  await hint.unmount()
})

test('/einweave toggles the pane as the band does; closed any other way (its ×), the band says Show again', async ($, on) => {
  const { pane, clock } = engine(on)
  await start($, clock)
  await $.command.run({ command: 'einweave', args: '' })
  expect(pane).toMatchObject({ up: true, opens: 1 })
  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Hide pane ]', dimColor: true } })
  await $.command.run({ command: 'einweave', args: '' })
  expect(pane).toMatchObject({ up: false, opens: 1 })
  await $.command.run({ command: 'einweave', args: '' })
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Hide pane ]', dimColor: true } })
  // Closed by its × (the engine's record changes; a test cannot press the engine's mark): the band follows the record.
  pane.up = false
  await band.redraw()
  expect(await band.find({ key: 'pane' })).toMatchObject({ props: { label: '[ Show pane ]', dimColor: true } })
  await band.unmount()
})

test('a relay started against an older plugin, which refuses watch, leaves the poll in charge', async ($, on) => {
  const { calls, clock } = engine(on, { pushed: [JSON.stringify({ ok: false, error: 'bad request' }) + '\n'] })
  await start($, clock)
  const before = calls.filter(c => c.tool === 'ui_state').length
  await clock.advance(60_000)
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(before + 1)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · holds 1 · 2 for you')
  await ui.unmount()
})

test('a drop shows in the band only after 10 s, with Connect; the hint says reconnecting meanwhile', async ($, on) => {
  const { calls, clock } = engine(on, { polled: DOWN })
  await start($, clock)
  let band = await $.ui.mount(BAND)
  expect(await findRun(band, /disconnected/)).toBeUndefined()
  await band.unmount()
  const hint = await $.ui.mount(BAND)
  expect(await said(hint)).toBe('einweave · ↻ reconnecting')
  await hint.unmount()
  // Drawn once and left on screen: the band appears when the grace period ends, with no other change.
  band = await $.ui.mount(BAND)
  await clock.advance(10_100)
  expect(await said(band)).toBe('einweave · ○ disconnected · messages are not arriving')
  expect(await findRun(band, /disconnected/)).toMatchObject({ props: { color: '#f07a7a' } })
  await band.press({ key: 'connect' })
  expect(calls.some(c => c.tool === 'connect')).toBe(true)
  await band.unmount()
})

test('the band yields to a survey', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN })
  await start($, clock)
  await clock.advance(10_100)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await findRun(band, /drawn by Claude Code/)).toBeDefined()
  await band.unmount()
})

test('/einweave is registered even while the plugin\'s server does not answer (a reload)', async ($, on) => {
  const { registered, clock } = engine(on, { hang: true })
  await start($, clock)
  expect(registered).toEqual(['einweave'])
})

test('/einweave status prints the summary; status full the JSON as it came', async ($, on) => {
  const json = JSON.stringify({ websocket: 'connected', agent: 'bellman', holds: [], version: '0.37.1', configured: true })
  const { clock } = engine(on, { answer: c => (c.tool === 'status' ? text(json) : undefined) })
  await start($, clock)
  expect((await $.command.run({ command: 'einweave', args: 'status' })).text).toBe('connected · agent bellman\nholds 0 · 2 for you (/einweave:take)\nplugin 0.37.1')
  expect((await $.command.run({ command: 'einweave', args: 'status full' })).text).toBe(json)
})

test('/einweave verbs call the plugin\'s own tools and print their answer', async ($, on) => {
  const { calls, clock } = engine(on, { answer: c => text(`${c.tool} ${JSON.stringify(c.args)}`) })
  await start($, clock)
  expect((await $.command.run({ command: 'einweave', args: 'release 2' })).text).toBe('release {"ref":"2"}')
  expect((await $.command.run({ command: 'einweave', args: 'rename review bot' })).text).toBe('set_session_label {"label":"review bot"}')
  expect((await $.command.run({ command: 'einweave', args: 'handover 1 review' })).text).toBe('handover {"ref":"1","to":"review"}')
  expect(calls.filter(c => c.tool !== 'ui_state').map(c => c.tool)).toEqual(['release', 'set_session_label', 'handover'])
  expect((await $.command.run({ command: 'einweave', args: 'bogus' })).text).toContain('Unknown: bogus')
})

test('connect into standby asks first, and takes the lock only on yes', async ($, on) => {
  const STANDBY: UiSnapshot = { ...SNAP, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  const { calls, clock } = engine(on, { polled: STANDBY })
  on('tool.call', ($, e) => ({ result: { answers: { [(e as { questions: { question: string }[] }).questions[0]!.question]: 'Take it over' } } }))
  await start($, clock)
  await $.command.run({ command: 'einweave', args: 'connect' })
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{}, { takeover: 'lock' }])
})

test('a takeover that answers "connecting" waits and reports the settled state, not "connecting"', async ($, on) => {
  const STANDBY: UiSnapshot = { ...SNAP, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  // The lock is taken; the socket signs in two reads later.
  let reads = 0
  let taken = false
  const o = {
    get polled() {
      return !taken ? STANDBY : ++reads > 2 ? SNAP : DOWN
    },
    answer: (c: Call) => {
      if (c.args.takeover) taken = true
      return text('connecting')
    },
  }
  const { clock } = engine(on, o)
  on('tool.call', ($, e) => ({ result: { answers: { [(e as { questions: { question: string }[] }).questions[0]!.question]: 'Take it over' } } }))
  await start($, clock)
  const run = $.command.run({ command: 'einweave', args: 'connect' })
  await clock.advance(2_000)
  expect((await run).text).toBe('connected · holds 1 · 2 for you')
})

test('a connect that never signs in says so after 10 s instead of hanging', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN, answer: () => text('connecting') })
  await start($, clock)
  const run = $.command.run({ command: 'einweave', args: 'connect' })
  await clock.advance(11_000)
  expect((await run).text).toContain('still connecting')
})

test('a window another one took over says so at once, and its band takes it back without asking', async ($, on) => {
  const GONE: UiSnapshot = { ...SNAP, connection: { state: 'superseded', detail: 'disconnected — another window took over' }, holds: [], waiting: null }
  const { calls, clock } = engine(on, { polled: GONE })
  await start($, clock)
  const hint = await $.ui.mount(BAND)
  expect(await said(hint)).toBe('einweave · ○ moved to another window · messages arrive there')
  await hint.unmount()
  const band = await $.ui.mount(BAND)
  expect(await findRun(band, /moved to another window/)).toMatchObject({ props: { color: '#f07a7a' } })
  // A bare digit in an empty composer presses a band Button that has a hotkey: this one must not have one.
  expect((await band.find({ type: 'Button', key: 'take-back' }))?.props.hotkey).toBeUndefined()
  // The name is the status light: dim while not connected.
  expect(await findRun(band, 'einweave')).toMatchObject({ props: { dimColor: true, weight: 'bold' } })
  expect((await findRun(band, 'einweave'))?.props).not.toHaveProperty('color')
  // Plain, brackets and all in the brand: the pointer's inversion is one colour (Jörgen 2026-10-31).
  expect(await band.find({ type: 'Button', key: 'take-back' })).toMatchObject({ props: { plain: true }, children: [{ type: 'Text', props: { color: PALETTE.brand, weight: 'bold' }, children: ['[ Take it back ]'] }] })
  await band.press({ key: 'take-back' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{ takeover: 'lock' }])
})

test('a band never connected (idle) offers Connect, bold brand like the header\'s', async ($, on) => {
  const IDLE: UiSnapshot = { ...SNAP, connection: { state: 'idle', detail: null }, holds: [], waiting: null }
  const { calls, clock } = engine(on, { polled: IDLE })
  await start($, clock)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Button', key: 'connect' })).toMatchObject({ props: { plain: true }, children: [{ type: 'Text', props: { color: PALETTE.brand, weight: 'bold' }, children: ['[ Connect ]'] }] })
  await band.press({ key: 'connect' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{}])
  await band.unmount()
})

test('a band in standby offers Connect (it asks before taking over)', async ($, on) => {
  const STANDBY: UiSnapshot = { ...SNAP, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  const { clock } = engine(on, { polled: STANDBY })
  await start($, clock)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Button', key: 'connect' })).toBeDefined()
  await band.unmount()
})

test('a band still reconnecting offers no Connect: it is already retrying', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN })
  await start($, clock)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Button', key: 'connect' })).toBeUndefined()
  await band.unmount()
})

test('the pane keeps a column free each side, its rules fitting inside it', async ($, on) => {
  const { clock } = engine(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'pane' })).toMatchObject({ props: { paddingX: 1 } })
  // A blank row between the name and the tabs (Jörgen 2026-11-03).
  expect(await ui.find({ key: 'gap:tabs' })).toMatchObject({ props: { height: 1 } })
  expect((await findRun(ui, /^─+$/))?.text).toBe('─'.repeat(PANE.props.bodyColumns - 2))
  await ui.unmount()
})

test('connect into standby, declined: no takeover', async ($, on) => {
  const STANDBY: UiSnapshot = { ...SNAP, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  const { calls, clock } = engine(on, { polled: STANDBY })
  on('tool.call', ($, e) => ({ result: { answers: { [(e as { questions: { question: string }[] }).questions[0]!.question]: 'Leave it' } } }))
  await start($, clock)
  await $.command.run({ command: 'einweave', args: 'connect' })
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{}])
})

test('the Held tab lists held threads, the Session tab has the name field; Release calls release with the thread id', async ($, on) => {
  const { calls, toasts, clock } = engine(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:held' })
    expect(await ui.find({ key: 'open:t1' })).toMatchObject(surface === 'terminal' ? { type: 'Button', props: { label: 'Fix the build' } } : { type: 'Markdown', props: { text: '[Fix the build](https://einweave.invalid/t1)' } })
    await ui.press({ key: 'tab:session' })
    expect(await ui.find({ key: 'label' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: 'release:t1' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'release')).toEqual([{ tool: 'release', args: { ref: 't1' } }])
  expect(toasts).toEqual(['release done'])
  await ui.unmount()
})

// Red: drop the channel title → no '#dev'; unseenByModel from anywhere else (or 0 shown) → no '3 new'; picker unsorted →
// offline first; handover args wrong → calls differ; the old typed hint kept → found.
test('board Held: rows as the Inbox (#channel Title, N new · last @x · age), Release and Hand over; the picker lists online first and hands over', async ($, on) => {
  const NOW = Date.parse('2026-11-03T12:00:00.000Z')
  const HELD: UiSnapshot = {
    ...SNAP,
    holds: [
      { threadId: 't1', title: 'Fix the build', channel: 'dev', quietSince: '2026-11-03T11:50:00.000Z', unseenByModel: 3, lastBy: '@kevin' },
      { threadId: 't2', title: 'Old one', channel: 'ops', quietSince: '2026-11-03T09:00:00.000Z', unseenByModel: 0, lastBy: null },
      { threadId: 't3', title: null },
    ],
    sessions: [
      { id: 's3', label: 'parked one', online: false },
      { id: 's2', label: 'live one', online: true },
    ],
  }
  const { calls, toasts, clock } = engine(on, { polled: HELD, now: NOW })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:held' })
  expect(await ui.find({ key: 'open:t1' })).toMatchObject({ type: 'Button', props: { label: 'Fix the build' } })
  expect(await findRun(ui, '#dev')).toMatchObject({ props: { color: PALETTE.brand } })
  expect(await findRun(ui, '3 new')).toMatchObject({ props: { color: PALETTE.brand } })
  expect(await ui.find({ type: 'Text', text: 'last @kevin' })).toBeDefined()
  expect(await findRun(ui, '10 min')).toBeDefined()
  // Quiet three hours: the age amber; nothing unseen: no "0 new".
  expect(await findRun(ui, '3 h')).toMatchObject({ props: { color: PALETTE.amber } })
  expect(await findRun(ui, '0 new')).toBeUndefined()
  // Not in the server's list yet: its id, no meta.
  expect(await ui.find({ key: 'open:t3' })).toMatchObject({ props: { label: 't3' } })
  expect(await ui.find({ type: 'Text', text: /Hand one over/ })).toBeUndefined()

  await ui.press({ key: 'handover:t1' })
  const picks = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter((k): k is string => !!k && k.startsWith('pick'))
  // Online only; the offline ones folded behind one row (Jörgen 2026-11-04, option C).
  expect(await picks()).toEqual(['pick:t1:s2', 'pick-offline:t1', 'pick-new:t1', 'pick-cancel:t1'])
  expect(await ui.find({ key: 'pick-offline:t1' })).toMatchObject({ props: { label: '▸ Show 1 offline', dimColor: true } })
  expect(await ui.find({ type: 'Text', text: ' · offline' })).toBeUndefined()
  // Shown, then hidden again from the same row.
  await ui.press({ key: 'pick-offline:t1' })
  expect(await picks()).toEqual(['pick:t1:s2', 'pick-offline:t1', 'pick:t1:s3', 'pick-new:t1', 'pick-cancel:t1'])
  expect(await ui.find({ key: 'pick-offline:t1' })).toMatchObject({ props: { label: '▾ Hide offline' } })
  expect(await ui.find({ type: 'Text', text: ' · offline' })).toBeDefined()
  await ui.press({ key: 'pick-offline:t1' })
  expect(await picks()).toEqual(['pick:t1:s2', 'pick-offline:t1', 'pick-new:t1', 'pick-cancel:t1'])
  // Shown, then the picker closed: it opens folded again.
  await ui.press({ key: 'pick-offline:t1' })
  await ui.press({ key: 'pick-cancel:t1' })
  await ui.press({ key: 'handover:t1' })
  expect(await picks()).toEqual(['pick:t1:s2', 'pick-offline:t1', 'pick-new:t1', 'pick-cancel:t1'])
  await ui.press({ key: 'pick:t1:s2' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'handover')).toEqual([{ tool: 'handover', args: { ref: 't1', to: 's2' } }])
  expect(toasts.at(-1)).toBe('handover done')
  // Picked: the picker closes.
  expect(await ui.find({ key: 'pick:t1:s2' })).toBeUndefined()
  // Cancel closes it too; Hand over again toggles it.
  await ui.press({ key: 'handover:t1' })
  await ui.press({ key: 'pick-cancel:t1' })
  expect(await ui.find({ key: 'pick:t1:s2' })).toBeUndefined()
  await ui.unmount()
})

// Red: no fallback copy → copied empty; the "no other session" line missing → not found.
test('board Held: with no other session the picker says so and New window copies the command that takes it there', async ($, on) => {
  const { clock } = engine(on, { polled: { ...SNAP, holds: [{ threadId: 't1', title: 'Fix the build', channel: 'dev', quietSince: null, unseenByModel: 0, lastBy: null }], sessions: [] } })
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: 'handover:t1' })
  expect(await ui.find({ type: 'Text', text: 'No other session of @bellman · start one' })).toBeDefined()
  // No offline session either: no fold row.
  expect(await ui.find({ key: 'pick-offline:t1' })).toBeUndefined()
  await ui.press({ key: 'pick-new:t1' })
  await clock.settle()
  expect(copied).toEqual(['claude "/einweave:take t1"'])
  expect(await ui.find({ key: 'pick-new:t1' })).toBeUndefined()
  await ui.unmount()
})

test('on mobile, which has no fields, the pane shows the name and scope as text', async ($, on) => {
  const { clock } = engine(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'tab:session' })
  expect(await ui.find({ key: 'row:label' })).toMatchObject({ text: expect.stringMatching(/^Session\s*probe$/) })
  expect(await ui.find({ key: 'row:scope' })).toMatchObject({ text: expect.stringMatching(/^Scope\s*none · only threads this session holds$/) })
  await ui.unmount()
})

test('a window that does not hold the session shows its name, with no field to rename it from', async ($, on) => {
  const GONE: UiSnapshot = { ...SNAP, connection: { state: 'superseded', detail: null }, holds: [], waiting: null }
  const { clock } = engine(on, { polled: GONE })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:session' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'row:label' })).toMatchObject({ text: expect.stringMatching(/^Session\s*probe$/) })
  // Connect looks like the header's: plain, bold brand brackets.
  expect(await ui.find({ type: 'Button', key: 'connect-s' })).toMatchObject({ props: { plain: true }, children: [{ type: 'Text', props: { color: PALETTE.brand, weight: 'bold' }, children: ['[ Connect ]'] }] })
  await ui.unmount()
})

test('no plugin answer: the tail says so instead of claiming a state', async ($, on) => {
  const { clock } = engine(on, { polled: null })
  await start($, clock)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · not answering')
  await ui.unmount()
})

test('after /clear (state back at its default) the snapshot is read again', async ($, on) => {
  const { calls, clock } = engine(on)
  // No session.start: /clear does not run it; the state starts at its default, as /clear leaves it.
  await $.classic.SessionStart({ source: 'clear' } as never)
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(1)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · holds 1 · 2 for you')
  await ui.unmount()
})

test('after /clear where classic hooks do not run, session.end reads it a second later', async ($, on) => {
  const { calls, clock } = engine(on)
  await $.session.end({ reason: 'clear' } as never)
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(0)
  await clock.advance(1_000)
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(1)
})

test('while the relay is live, the minute poll does not run', async ($, on) => {
  const { calls, clock } = engine(on, { pushed: [line(2, SNAP)], stayOpen: true })
  await start($, clock)
  const before = calls.filter(c => c.tool === 'ui_state').length
  await clock.advance(120_000)
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(before)
})

test('a restarted plugin counts from rev 1 again: its relay is believed over a higher polled rev', async ($, on) => {
  const { clock } = engine(on, { polledRev: 40, pushed: [line(1, { ...SNAP, holds: [] })] })
  await start($, clock)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · holds 0 · 2 for you')
  await ui.unmount()
})

test('at startup the first read waits for the plugin\'s server instead of saying "not answering"', async ($, on) => {
  const { clock } = engine(on, { connectAfterMs: 3_000 })
  await start($, clock)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · starting')
  await ui.unmount()
  await clock.advance(3_000)
  const after = await $.ui.mount(BAND)
  expect(await said(after)).toBe('einweave · holds 1 · 2 for you')
  await after.unmount()
})

test('a relay that found no socket yet (startup) tries again after 2 s, not 10', async ($, on) => {
  const NO_SOCKET = JSON.stringify({ ok: false, error: 'no control socket' }) + '\n'
  const { spawns, clock } = engine(on, { polled: null, pushes: [[NO_SOCKET], [line(1, SNAP)]] })
  await start($, clock)
  expect(spawns.length).toBe(1)
  await clock.advance(2_000)
  expect(spawns.length).toBe(2)
  const ui = await $.ui.mount(BAND)
  expect(await said(ui)).toBe('einweave · holds 1 · 2 for you')
  await ui.unmount()
})

test('the relay is started with CLAUDE_PID blanked: one inherited from an outer Claude names that session\'s socket', async ($, on) => {
  const { spawns, clock } = engine(on)
  await start($, clock)
  expect(spawns[0]?.env).toEqual({ CLAUDE_PID: '' })
})

const T_OLD = '01990000-0000-7000-8000-0000000000a1'
const T_NEW = '01990000-0000-7000-8000-0000000000a2'
const T_CH = '01990000-0000-7000-8000-0000000000a3'
const WAITING: UiSnapshot = {
  ...SNAP,
  waiting: {
    // Exact, all pages: more than the rows the snapshot carries.
    forYou: 25,
    channel: 4,
    more: true,
    // Snapshot order (toWaiting sorted it): For you newest first, then Open quiet longest first.
    top: [
      { threadId: T_NEW, title: 'Newer ask', channel: 'ops', why: 'addressed', hold: 'unheld', quietSince: '2026-10-30T09:50:00.000Z' },
      { threadId: T_OLD, title: 'Older ask', channel: 'ops', why: 'participant', hold: 'parked', quietSince: '2026-10-30T08:00:00.000Z' },
      { threadId: T_CH, title: 'Demo notes', channel: 'general', why: 'channel', hold: 'unheld', quietSince: '2026-10-30T07:00:00.000Z' },
    ],
  },
}

test('the Inbox is the default tab: For you, then Unowned, each with how long it has been quiet; the tab and each heading count all that waits, not the rows drawn', async ($, on) => {
  // 10:00: Older ask quiet 2 h (stale), Newer ask 10 min.
  const { clock } = engine(on, { polled: WAITING, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab:inbox' })).toMatchObject({ props: { label: 'Inbox 29' } })
  shownPill(await ui.find({ key: 'tab:inbox' }))
  for (const k of ['tab:held', 'tab:channels', 'tab:session']) expect(await ui.find({ key: k })).toMatchObject({ props: { dimColor: true } })
  // The pane's own name, as the canvas draws it.
  expect(await findRun(ui, 'einweave')).toMatchObject({ props: { color: '#4cc3ad', weight: 'bold' } })
  const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(keys).toEqual([`open:${T_NEW}`, `open:${T_OLD}`, `open:${T_CH}`])
  // Each heading says how many wait in it (the server's counts), so they add up to the tab: 25 + 4 = 29.
  expect(await findRun(ui, 'For you 25')).toMatchObject({ props: { weight: 'bold' } })
  expect(await findRun(ui, 'questions and messages aimed at you')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'Unowned 4')).toMatchObject({ props: { weight: 'bold' } })
  expect(await findRun(ui, 'nobody holds these · newest first')).toBeDefined()
  // Board Unowned: `#channel` in the brand colour, the title semibold, then why and the hold dim; a stale age amber.
  const row = await ui.find({ key: `open:${T_OLD}` })
  expect(row?.children).toMatchObject([
    { props: { color: '#4cc3ad' }, children: ['#ops'] },
    { children: [' '] },
    { props: { weight: 'semibold' }, children: ['Older ask'] },
  ])
  expect(await findRun(ui, 'you took part · holder offline')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, '2 h')).toMatchObject({ props: { color: '#e8b04a', weight: 'semibold' } })
  expect(await findRun(ui, '10 min')).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('board Unowned: the gateway line says whether unheld work is routed (brand) or waits for a take (amber), then the two notes', async ($, on) => {
  const GW_DOWN: UiSnapshot = { ...WAITING, gateway: { online: false, label: null } }
  const { clock } = engine(on, { polled: GW_DOWN, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await findRun(ui, '○ no gateway online · unheld work goes to sessions in scope, or waits for a take')).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await findRun(ui, 'Every session of @bellman sees this list. The band stays for things aimed at you.')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'Take brings it here. New session copies a command that starts another window and takes it there.')).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('board Unowned: an online gateway is named in the brand colour', async ($, on) => {
  const GW_UP: UiSnapshot = { ...WAITING, gateway: { online: true, label: 'bridge-gw' } }
  const { clock } = engine(on, { polled: GW_UP, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await findRun(ui, '● gateway bridge-gw online · routing, usually picked within a minute')).toMatchObject({ props: { color: '#4cc3ad' } })
  await ui.unmount()
})

test('board Unowned: no gateway in the snapshot (an older plugin server), no gateway line', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await findRun(ui, /gateway/)).toBeUndefined()
  await ui.unmount()
})

test('Take on an Inbox row takes it by id; from an online holder it asks the person first, and only a yes confirms', async ($, on) => {
  const asked = `Bellman #cd34 is online and working on this. Take it anyway?\nAsk the person; if they agree, call take again with ref "${T_NEW}" and confirm: true. Nothing was taken.`
  const { calls, toasts, clock } = engine(on, {
    polled: WAITING,
    answer: c => (c.tool === 'take' ? text(c.args.confirm ? `This session now holds Newer ask. Reply with thread_id "${T_NEW}".` : asked) : undefined),
  })
  const questions: string[] = []
  let yes = false
  on('tool.call', ($, e) => {
    const q = (e as { questions: { question: string }[] }).questions[0]!.question
    questions.push(q)
    return { result: { answers: { [q]: yes ? 'Take it' : 'Leave it' } } }
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `take:${T_NEW}` })
  await clock.settle()
  expect(questions).toEqual(['Bellman #cd34 is online and working on this. Take it anyway?'])
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: T_NEW }])
  expect(toasts.at(-1)).toBe('Nothing was taken.')
  yes = true
  await ui.press({ key: `take:${T_NEW}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: T_NEW }, { ref: T_NEW }, { ref: T_NEW, confirm: true }])
  expect(toasts.at(-1)).toContain('now holds')
  await ui.unmount()
})

test('a snapshot with uiSocket: the thread tab reads over http.fetch on that socket (whole page), with NO mcp.call for ui_thread; a refusal falls back to MCP; an error body is shown', async ($, on) => {
  const thread = {
    thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' },
    channel_id: 'c',
    messages: [{ sender: 'Kevin', content: 'Read over the socket', type: 'question', ts: '2026-10-30T08:00:00.000Z', seq: 1, root: true }],
    has_older: false,
    older_count: 0,
  }
  const fetched: { url: string; socketPath?: string }[] = []
  let mode: 'ok' | 'refused' | 'error' = 'ok'
  on('http.fetch', (_$, e) => {
    fetched.push({ url: e.url, socketPath: e.init?.socketPath })
    if (mode === 'refused') throw new Error('refused by policy')
    if (mode === 'error') return { value: { status: 409, ok: false, headers: {}, text: JSON.stringify({ error: 'einweave not connected — run /einweave:connect first.' }) } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(thread) } }
  })
  const { calls, clock } = engine(on, { polled: { ...WAITING, uiSocket: '/tmp/ew/u1.sock' }, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify({ ...thread, messages: [{ ...thread.messages[0], content: 'Read over MCP' }] })) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(fetched).toEqual([{ url: `http://einweave/thread/${T_OLD}`, socketPath: '/tmp/ew/u1.sock' }])
  expect(calls.filter(c => c.tool === 'ui_thread')).toEqual([])
  expect(await ui.find({ key: `ln:${T_OLD}:root:0` })).toMatchObject({ text: 'Read over the socket' })
  // The fetch refused (no socket any more, a policy): this call alone goes over MCP.
  mode = 'refused'
  await ui.press({ key: `refresh:${T_OLD}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_OLD }])
  expect(await ui.find({ key: `ln:${T_OLD}:root:0` })).toMatchObject({ text: 'Read over MCP' })
  // An answer from the socket stands even when it is an error: its text, not a silent second read.
  mode = 'error'
  await ui.press({ key: `refresh:${T_OLD}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_thread')).toHaveLength(1)
  expect(await findRun(ui, /einweave not connected/)).toBeDefined()
  await ui.unmount()
})

test('a snapshot with uiSocket: a person\'s actions (a /einweave command, a pane button) POST /tool/<name> on that socket, with NO mcp.call for them; a refusal falls back to MCP', async ($, on) => {
  const posted: { url: string; method?: string; body?: string; socketPath?: string }[] = []
  let refused = false
  on('http.fetch', (_$, e) => {
    if (!e.url.includes('/tool/')) return { value: { status: 404, ok: false, headers: {}, text: '{"error":"not found"}' } }
    posted.push({ url: e.url, method: e.init?.method, body: e.init?.body, socketPath: e.init?.socketPath })
    if (refused) throw new Error('refused by policy')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ content: [{ type: 'text', text: 'released over the socket' }] }) } }
  })
  const { calls, clock } = engine(on, { polled: { ...WAITING, uiSocket: '/tmp/ew/u1.sock' }, answer: c => text(`${c.tool} ${JSON.stringify(c.args)}`) })
  await start($, clock)
  expect((await $.command.run({ command: 'einweave', args: 'release 2' })).text).toBe('released over the socket')
  expect(posted).toEqual([{ url: 'http://einweave/tool/release', method: 'POST', body: '{"ref":"2"}', socketPath: '/tmp/ew/u1.sock' }])
  expect(calls.filter(c => c.tool === 'release')).toEqual([])
  refused = true
  expect((await $.command.run({ command: 'einweave', args: 'release 3' })).text).toBe('release {"ref":"3"}')
  expect(calls.filter(c => c.tool === 'release').map(c => c.args)).toEqual([{ ref: '3' }])
})

for (const [name, polled] of [['absent', WAITING], ['null', { ...WAITING, uiSocket: null }], ['junk', { ...WAITING, uiSocket: 42 as unknown as string }]] as const) {
  test(`a snapshot whose uiSocket is ${name}: the thread tab reads through mcp.call, and http.fetch is never touched`, async ($, on) => {
    const thread = { thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' }, channel_id: 'c', messages: [], has_older: false, older_count: 0 }
    let fetches = 0
    on('http.fetch', () => {
      fetches++
      throw new Error('must not be called')
    })
    const { calls, clock } = engine(on, { polled, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: `open:${T_OLD}` })
    await clock.settle()
    expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_OLD }])
    expect(fetches).toBe(0)
    await ui.unmount()
  })
}

test('not connected, the pane shows only the Session tab and says why; a thread tab opened before comes back on connecting', async ($, on) => {
  const thread = { thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' }, channel_id: 'c', messages: [], has_older: false, older_count: 0 }
  const STANDBY: UiSnapshot = { ...WAITING, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  let polled: UiSnapshot = WAITING
  let rev = 1
  const { clock } = engine(on, { get polled() { return polled }, get polledRev() { return rev }, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  shownPill(await ui.find({ key: `tab:${T_OLD}` }))
  await ui.unmount()
  polled = STANDBY
  rev = 2
  await clock.advance(61_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const k of ['tab:inbox', 'tab:held', 'tab:channels', `tab:${T_OLD}`]) expect(await ui.find({ key: k })).toBeUndefined()
  shownPill(await ui.find({ key: 'tab:session' }))
  expect(await findRun(ui, 'Connect to see the Inbox, held threads and channels.')).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Button', key: 'connect-s' })).toBeDefined()
  await ui.unmount()
  polled = WAITING
  rev = 3
  await clock.advance(61_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shownPill(await ui.find({ key: `tab:${T_OLD}` }))
  expect(await ui.find({ key: 'tab:inbox' })).toBeDefined()
  expect(await findRun(ui, /^Connect to see/)).toBeUndefined()
  await ui.unmount()
})

test('a drop still retrying (reconnecting) keeps every tab: a blip does not blank the pane', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const k of ['tab:inbox', 'tab:held', 'tab:channels', 'tab:session']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await findRun(ui, /^Connect to see/)).toBeUndefined()
  await ui.unmount()
})

test('View opens a thread tab read through ui_thread (never read_thread, which would ack it as the model\'s); × closes it', async ($, on) => {
  const thread = {
    thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' },
    channel_id: 'c',
    messages: [
      { sender: 'Kevin', content: 'Can I take the NAS at 14:00?', type: 'question', ts: '2026-10-30T08:00:00.000Z', seq: 1, root: true },
      { sender: 'Brian', content: 'yes', type: 'text', ts: '2026-10-30T08:01:00.000Z', seq: 20 },
    ],
    has_older: true,
    older_count: 12,
  }
  const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_OLD }])
  expect(calls.some(c => c.tool === 'read_thread')).toBe(false)
  shownPill(await ui.find({ key: `tab:${T_OLD}` }))
  // Its × inside the pill: the pill's fill, not dim.
  const close = await ui.find({ key: `close:${T_OLD}` })
  expect(close).toMatchObject({ children: [{ type: 'Text', props: { backgroundColor: PILL.backgroundColor, color: PILL.color }, children: ['× '] }] })
  expect(close?.props).not.toHaveProperty('dimColor')
  // Unheld: amber, Claude has not seen it; Refresh, since nothing pushes it here.
  expect(await findRun(ui, 'not held here · Claude has not seen it · Take brings it here')).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ key: `refresh:${T_OLD}` })).toMatchObject({ props: { label: '↻ Refresh' } })
  // How fresh, at the title row's right end: nothing pushes an unheld thread here.
  expect(await findRun(ui, /^Updated \d\d:\d\d$/)).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'question')).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await findRun(ui, 'Kevin')).toMatchObject({ props: { weight: 'bold' } })
  expect((await ui.findAll({ type: 'Text', text: 'Older ask' })).some(t => (t.props as { weight?: string }).weight === 'bold')).toBe(true)
  // Post text is the mod's own lines (decision 2026-10-31, option c): the pane knows each post's rows.
  expect(await ui.find({ key: `ln:${T_OLD}:root:0` })).toMatchObject({ text: 'Can I take the NAS at 14:00?' })
  expect(await findRun(ui, '12 older replies')).toBeDefined()
  expect(await ui.find({ key: `take:${T_OLD}` })).toBeDefined()
  await ui.press({ key: `close:${T_OLD}` })
  expect(await ui.find({ key: `tab:${T_OLD}` })).toBeUndefined()
  shownPill(await ui.find({ key: 'tab:inbox' }))
  await ui.unmount()
})

test('a work item\'s tab draws its header (RFC-029 D2): kind · status · assignee under the title, then filed, the fields under their labels, missing; an empty root is no post', async ($, on) => {
  const thread = {
    thread: { id: T_OLD, title: 'Search relevance', kind: 'feature', status: 'triage', work: { kind: 'feature', status: 'in_progress', resolvedReason: null, assignee: null, fields: [{ key: 'problem', label: 'Problem', value: 'Ranking is judgment' }], missing: ['Acceptance criteria'] } },
    channel_id: 'c',
    messages: [
      { sender: 'bellman', content: '', type: 'text', ts: '2026-11-03T17:36:00.000Z', seq: 1, root: true, own: true },
      { sender: 'Brian', content: 'yes', type: 'text', ts: '2026-11-03T18:01:00.000Z', seq: 20 },
    ],
    has_older: false,
    older_count: 0,
  }
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await findRun(ui, 'feature · ')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'in progress')).toMatchObject({ props: { weight: 'bold' } })
  expect(await findRun(ui, 'no assignee')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'filed this')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'Problem')).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: `ln:${T_OLD}:f:problem:0` })).toMatchObject({ text: 'Ranking is judgment' })
  expect(await findRun(ui, 'Missing: Acceptance criteria')).toMatchObject({ props: { color: '#e8b04a' } })
  // The empty root is not drawn as a post of its own: bellman shows once, on the filed row.
  expect(await ui.find({ key: `post:${T_OLD}:root` })).toBeUndefined()
  expect(await ui.find({ key: `post:${T_OLD}:s20` })).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an opened tab not shown, ${surface}: its label and its × light as one tab under the pointer (terminal only)`, async ($, on) => {
    const thread = { thread: { id: T_OLD, title: 'Older ask' }, messages: [], has_older: false, older_count: 0 }
    const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') await ui.press({ key: `open:${T_OLD}` })
    else await ui.press({ key: `open:${T_OLD}`, link: { href: `https://einweave.invalid/${T_OLD}` } } as never)
    await clock.settle()
    await ui.press({ key: 'tab:inbox' })
    const label = await ui.find({ key: `tab:${T_OLD}` })
    const close = await ui.find({ key: `close:${T_OLD}` })
    expect(label?.props).toMatchObject({ label: ' Older ask ' })
    if (surface === 'terminal') {
      // One group per tab: the pointer on either lights both, as the pointer draws a fixed tab (inverse, full
      // strength). Dim is the Texts' only: a dimColor Button keeps its lit Text grey (live 2026-11-03).
      expect([label?.props, close?.props].map(p => (p as { dimColor?: boolean }).dimColor)).toEqual([undefined, undefined])
      const lit = { scope: `tab:${T_OLD}`, inverse: true, dimColor: false }
      // (The kit reports a Text's hover beside its props; a Button's it does not, so the hover is the Texts'.)
      expect(label).toMatchObject({ children: [{ type: 'Text', props: { dimColor: true }, hover: lit, children: [' Older ask '] }] })
      // At rest a dim `× `: the shown pill's width, so the tab does not grow when it is shown.
      expect(close).toMatchObject({ children: [{ type: 'Text', props: { dimColor: true }, hover: lit, children: ['× '] }] })
      // Exactly that, both.
      expect([label?.children[0]?.hover, close?.children[0]?.hover]).toEqual([lit, lit])
      // The tab's Box joins the group too (it sets it off; a Text inside a Button does not, live 2026-11-03). The
      // kit reports no Box's or Button's hover, so that half is checked live, not here.
      // The fixed tabs keep the engine's own pointer: nothing beside them to light.
      expect((await ui.find({ key: 'tab:held' }))?.children).toEqual([])
    } else {
      // A desktop draws no hover: its native buttons, the × dim as before.
      expect(label?.props).toMatchObject({ dimColor: true })
      expect(label?.children).toEqual([])
      expect(close).toMatchObject({ props: { dimColor: true }, children: [] })
    }
    await ui.unmount()
  })
}

test('× while the thread still loads: the late answer does not bring the closed tab\'s content back', async ($, on) => {
  const thread = { thread: { id: T_OLD, title: 'Older ask' }, messages: [{ sender: 'Kevin', content: 'late', type: 'text', ts: null }], has_older: false, older_count: 0 }
  let clockRef: { sleep: (ms: number) => Promise<void> } | null = null
  let reads = 0
  // The first read answers late; the second (the tab opened again) never does, so all it can show is what was kept.
  const { clock } = engine(on, {
    polled: WAITING,
    answer: c => (c.tool !== 'ui_thread' ? undefined : ++reads === 1 ? clockRef!.sleep(5_000).then(() => text(JSON.stringify(thread))) : new Promise(() => {})),
  })
  clockRef = clock
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await ui.press({ key: `close:${T_OLD}` })
  await clock.advance(6_000)
  await clock.settle()
  void ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await findRun(ui, 'Loading…')).toBeDefined()
  expect(await findRun(ui, 'late')).toBeUndefined()
  await ui.unmount()
})

test('New session copies the command that takes the thread in a new window', async ($, on) => {
  const { toasts, clock } = engine(on, { polled: WAITING })
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `new:${T_CH}` })
  await clock.settle()
  expect(copied).toEqual([`claude "/einweave:take ${T_CH}"`])
  expect(toasts.at(-1)).toContain('Copied')
  await ui.unmount()
})

test('/einweave take N and /einweave search: take by ref; search runs RFC-031 search, one line per thread with its id', async ($, on) => {
  const page = { results: [{ thread_id: 't-9', title: 'Review the PR', channel: 'ops', kind: 'task', status: 'open', matching_replies: 0, snippet_parts: [{ text: 'Review', hit: true }, { text: ' the PR', hit: false }] }], total: { count: 1, capped: false } }
  const { calls, clock } = engine(on, { answer: c => (c.tool === 'ui_search' ? text(JSON.stringify(page)) : c.tool === 'take' ? text('This session now holds Fix the build.') : undefined) })
  await start($, clock)
  expect((await $.command.run({ command: 'einweave', args: 'take 1' })).text).toBe('This session now holds Fix the build.')
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: '1' }])
  const found = await $.command.run({ command: 'einweave', args: 'search review in:#ops' })
  expect(calls.filter(c => c.tool === 'ui_search').map(c => c.args)).toEqual([{ query: 'review in:#ops' }])
  expect(found.text).toBe('1 for "review in:#ops":\n#ops · Review the PR\n   t-9\nTake one with /einweave take <id>.')
})

const CH_OPS = 'c0000000-0000-7000-8000-00000000000a'
const CH_FOLLOW = 'c0000000-0000-7000-8000-00000000000b'
const CH_BARE = 'c0000000-0000-7000-8000-00000000000c'
const CHANNELS = {
  agent: 'bellman',
  channels: [
    { id: CH_OPS, name: 'ops', role: 'member', following: false, threads: { open: 4, unheld: 1, parked: 1, oldestWaitingAt: '2026-10-30T07:00:00.000Z' } },
    { id: CH_FOLLOW, name: 'news', role: null, following: true, threads: { open: 2, unheld: 2, parked: 0, oldestWaitingAt: null } },
    // An older server, or a count it could not read: no `threads`.
    { id: CH_BARE, name: 'misc', role: 'owner', following: false },
  ],
}
const holder = (label: string, online: boolean, parked = false) => ({ id: `s-${label}`, label, online, parked })
const OPS_THREADS = {
  channel_id: CH_OPS,
  threads: [
    { id: 'r1', title: 'Shipped', status: 'resolved', kind: 'task', lastActivityAt: null, hold: { state: 'unheld', holder: null } },
    { id: 't1', title: 'Fix the build', status: 'open', kind: 'task', lastActivityAt: null, hold: { state: 'held', holder: holder('probe', true) } },
    { id: 'u1', title: 'Nobody has it', status: 'open', kind: 'question', lastActivityAt: null, hold: { state: 'unheld', holder: null } },
    { id: 'p1', title: 'Gone quiet', status: 'open', kind: null, lastActivityAt: null, hold: { state: 'parked', holder: holder('Kevin #ab12', false, true) } },
    { id: 'h1', title: 'Someone on it', status: 'open', kind: null, lastActivityAt: null, hold: { state: 'held', holder: holder('Kevin #ab12', true) } },
  ],
}
const PERSON_ONLY = ['ui_state', 'ui_channels', 'ui_channel', 'ui_thread', 'take']

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`${surface}: the Channels tab reads ui_channels on show: rows with counts, follow-only marked, unknown counts said; its tab counts channels with waiting`, async ($, on) => {
    const { calls, clock } = engine(on, { answer: c => (c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : undefined) })
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab:channels' })
    await clock.settle()
    expect(calls.filter(c => c.tool === 'ui_channels').map(c => c.args)).toEqual([{}])
    // Board ChannelsTab: the tab has no count; an intro line; `#name` brand, its counts under it.
    expect(await ui.find({ key: 'tab:channels' })).toMatchObject({ props: { label: 'Channels' } })
    shownPill(await ui.find({ key: 'tab:channels' }))
    expect(await findRun(ui, '@bellman is in 3 channels. Every session of the agent shares them.')).toBeDefined()
    expect(await findRun(ui, /^4 open · 2 unowned · oldest waiting \d+ (s|min|h|d)$/)).toBeDefined()
    expect(await findRun(ui, '2 open · 2 unowned · following, not a member')).toBeDefined()
    // Joining is the web app's (decision Q4, 2026-10-31): no Join anywhere here.
    expect((await ui.findAll({ type: 'Button' })).some(b => String(b.key).startsWith('join'))).toBe(false)
    expect(await findRun(ui, 'Join, leave and private channels: in the web app.')).toBeDefined()
    expect(await findRun(ui, 'counts unknown')).toBeDefined()
    // The record standard (as Inbox's `#channel`): regular at rest, so the pointer's bold shows.
    if (surface === 'terminal') {
      const name = await findRun(ui, '#ops')
      expect(name).toMatchObject({ props: { color: '#4cc3ad' } })
      expect((name.props as { weight?: string }).weight, '#name bold at rest: its hover changes nothing').toBeUndefined()
      expect((name.props as { bold?: boolean }).bold).toBeFalsy()
    }
    expect(calls.every(c => PERSON_ONLY.includes(c.tool))).toBe(true)
    await ui.unmount()
  })
}

test('a failed ui_channels shows its error, never "isn\'t in any channels"; an empty answer names the agent and where to set it up', async ($, on) => {
  let answer = { content: [{ type: 'text', text: 'This einweave server is too old for the Channels tab' }], isError: true }
  const { clock } = engine(on, { answer: c => (c.tool === 'ui_channels' ? answer : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  expect(await findRun(ui, 'This einweave server is too old for the Channels tab')).toBeDefined()
  expect(await findRun(ui, /isn't in any channels/)).toBeUndefined()
  answer = text(JSON.stringify({ agent: 'bellman', channels: [] }))
  // Shown again, it reads again: nothing pushes the list, and the canvas has no Refresh.
  await ui.press({ key: 'tab:inbox' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  expect(await findRun(ui, "@bellman isn't in any channels · set up in the web app")).toBeDefined()
  await ui.unmount()
})

test('View on a channel opens its tab via ui_channel: open threads first, resolved dimmed with no Take, badges, no Take where held here; Take reloads it', async ($, on) => {
  const { calls, clock } = engine(on, {
    answer: c =>
      c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : c.tool === 'ui_channel' ? text(JSON.stringify(OPS_THREADS)) : c.tool === 'take' ? text('This session now holds Nobody has it.') : undefined,
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `open:ch:${CH_OPS}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_channel').map(c => c.args)).toEqual([{ channel_id: CH_OPS }])
  expect(await ui.find({ key: `tab:${CH_OPS}` })).toMatchObject({ props: { label: '#ops' } })
  shownPill(await ui.find({ key: `tab:${CH_OPS}` }))
  expect(await findRun(ui, 'Open threads, latest activity first.')).toBeDefined()
  const views = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(views).toEqual(['open:t1', 'open:u1', 'open:p1', 'open:h1', 'open:r1'])
  // SNAP holds t1 in this session.
  expect(await findRun(ui, 'held by you')).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await findRun(ui, 'unheld')).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ key: 'take:t1' })).toBeUndefined()
  expect(await ui.find({ key: 'take:r1' })).toBeUndefined()
  expect(await ui.find({ key: 'open:r1' })).toMatchObject({ props: { label: 'Shipped', dimColor: true } })
  // `open` is every live thread's status: never said on its row (was `open · task`).
  expect(await findRun(ui, 'task')).toBeDefined()
  expect(await findRun(ui, /^open( ·|$)/)).toBeUndefined()
  expect(await findRun(ui, 'held by Kevin #ab12 · offline')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'held by Kevin #ab12 · online')).toBeDefined()
  // From an online holder Take asks first, and says so; from an offline one it takes.
  expect(await ui.find({ key: 'take:h1' })).toMatchObject({ props: { label: 'Ask to take' } })
  expect(await ui.find({ key: 'take:p1' })).toMatchObject({ props: { label: 'Take' } })
  await ui.press({ key: 'take:u1' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: 'u1' }])
  expect(calls.filter(c => c.tool === 'ui_channel').length).toBe(2)
  await ui.press({ key: 'open:u1' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: 'u1' }])
  expect(calls.every(c => PERSON_ONLY.includes(c.tool))).toBe(true)
  await ui.unmount()
})

test('a channel it only follows offers no Take: Take is refused outside membership', async ($, on) => {
  const { clock } = engine(on, {
    answer: c => (c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : c.tool === 'ui_channel' ? text(JSON.stringify({ ...OPS_THREADS, channel_id: CH_FOLLOW })) : undefined),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `open:ch:${CH_FOLLOW}` })
  await clock.settle()
  expect(await ui.find({ key: 'open:u1' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).some(b => String(b.key).startsWith('take:'))).toBe(false)
  await ui.unmount()
})

test('× on a channel tab while it loads: the late answer does not bring its content back', async ($, on) => {
  let clockRef: { sleep: (ms: number) => Promise<void> } | null = null
  let reads = 0
  const { clock } = engine(on, {
    answer: c =>
      c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : c.tool !== 'ui_channel' ? undefined : ++reads === 1 ? clockRef!.sleep(5_000).then(() => text(JSON.stringify(OPS_THREADS))) : new Promise(() => {}),
  })
  clockRef = clock
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `open:ch:${CH_OPS}` })
  await ui.press({ key: `close:${CH_OPS}` })
  await clock.advance(6_000)
  await clock.settle()
  void ui.press({ key: 'tab:channels' })
  await clock.settle()
  void ui.press({ key: `open:ch:${CH_OPS}` })
  await clock.settle()
  expect(await findRun(ui, 'Loading…')).toBeDefined()
  expect(await ui.find({ key: 'open:t1' })).toBeUndefined()
  await ui.unmount()
})

/** The engine's side of a focus move: what element the ring was finally sent to, after the mod's hook. */
const ring = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const landed: (string | undefined)[] = []
  on('ui.focus', ($, e) => {
    landed.push(e.element)
    return {}
  })
  return landed
}
const focus = ($: Parameters<Parameters<typeof test>[1]>[0], element: string) =>
  $.ui.focus({ component: 'Pane', requestId: 'einweave', element, origin: { kind: 'person' } } as never)

test('the keyboard stops on marks only: a move onto a record\'s title or Take goes on to the next mark (down) or back to its own (up)', async ($, on) => {
  const landed = ring(on)
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await focus($, `mark:${T_NEW}`)
  await focus($, `open:${T_NEW}`)
  expect(landed.at(-1)).toBe(`mark:${T_OLD}`)
  // Up from T_OLD's mark the ring meets T_NEW's title: back to T_NEW's mark.
  await focus($, `open:${T_NEW}`)
  expect(landed.at(-1)).toBe(`mark:${T_NEW}`)
  // Past the last record its title stays reachable: the ring goes on beyond the list.
  await focus($, `mark:${T_CH}`)
  await focus($, `open:${T_CH}`)
  expect(landed.at(-1)).toBe(`open:${T_CH}`)
  await ui.unmount()
})

test('the keyboard\'s record: its actions in the footer on hotkeys (t Take, n New), none inline on hotkeys; the pane still draws', async ($, on) => {
  ring(on)
  const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'take' ? text('This session now holds Newer ask.') : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  expect(await ui.find({ key: 'foot:take' })).toBeUndefined()
  await focus($, `mark:${T_NEW}`)
  await clock.settle()
  expect(await ui.find({ key: 'tab:inbox' })).toBeDefined()
  expect(await ui.find({ key: 'foot:take' })).toMatchObject({ props: { hotkey: 't', label: 'Take' } })
  expect(await ui.find({ key: 'foot:new' })).toMatchObject({ props: { hotkey: 'n', label: 'New session' } })
  expect((await ui.find({ key: `take:${T_NEW}` }))?.props).not.toHaveProperty('hotkey')
  // Its meta lit as under the pointer, dim no more; another record's stays dim.
  expect(await findRun(ui, 'addressed to you · unheld')).toMatchObject({ props: { color: '#b8b8b8' } })
  expect((await findRun(ui, 'addressed to you · unheld'))?.props).not.toHaveProperty('dimColor')
  expect(await findRun(ui, 'you took part · holder offline')).toMatchObject({ props: { dimColor: true } })
  // The keyboard's mark runs down the meta row too (the engine inverts only the title row's Button).
  expect((await metaRow(ui, T_NEW))?.children?.[0]).toMatchObject({ type: 'Text', props: { backgroundColor: '#e4e4e4' } })
  expect((await metaRow(ui, T_OLD))?.children?.[0]?.props).not.toHaveProperty('backgroundColor')
  // Onto the footer, the record it acts on stays the keyboard's.
  await focus($, 'foot:take')
  await clock.settle()
  expect(await ui.find({ key: 'foot:take' })).toBeDefined()
  await ui.press({ key: 'foot:take' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: T_NEW }])
  await ui.unmount()
})

test('the keyboard on a channel, which has no actions: the footer still says enter open · esc back', async ($, on) => {
  ring(on)
  const { clock } = engine(on, { answer: c => (c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  expect(await findRun(ui, 'enter open · esc back')).toBeUndefined()
  await focus($, `mark:ch:${CH_OPS}`)
  await clock.settle()
  expect(await findRun(ui, 'enter open · esc back'), 'no footer on a record with no actions').toBeDefined()
  await ui.unmount()
})

test('the pointer anywhere on a record lights all of it: the record\'s Box is its only keyed Box, so the meta row\'s hovers follow it (a keyed row scoped them to that row, 2026-11-04)', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rec = await ui.find({ key: `rec:${T_NEW}` })
  expect(rec?.children?.length).toBeGreaterThan(1)
  for (const row of rec!.children! as { props?: { key?: unknown } }[]) expect(row.props?.key, 'a row with a key of its own scopes its hovers to that row').toBeUndefined()
  // The meta lights as the title does.
  expect(await findRun(ui, 'addressed to you · unheld')).toMatchObject({ props: { dimColor: true }, hover: { dimColor: false, color: '#b8b8b8' } })
  await ui.unmount()
})

test('Escape hands the keyboard back with no ui.focus: no footer, a grey mark where the keyboard will land again', async ($, on) => {
  ring(on)
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  await focus($, `mark:${T_NEW}`)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'foot:take' })).toBeUndefined()
  expect(await ui.find({ key: `mark:${T_NEW}` })).toMatchObject({ children: [{ type: 'Text', props: { backgroundColor: '#4a4a4a' } }] })
  // The grey mark runs down the whole record, its meta row too (TabStates board).
  expect((await metaRow(ui, T_NEW))?.children?.[0]).toMatchObject({ type: 'Text', props: { backgroundColor: '#4a4a4a' } })
  // Another record: no mark at rest, the pointer's light mark on every row under hover.
  expect((await ui.find({ key: `mark:${T_OLD}` }))?.children?.[0]).toMatchObject({ type: 'Text', hover: { backgroundColor: '#e4e4e4' } })
  expect((await ui.find({ key: `mark:${T_OLD}` }))?.children?.[0]?.props).not.toHaveProperty('backgroundColor')
  expect((await metaRow(ui, T_OLD))?.children?.[0]).toMatchObject({ type: 'Text', hover: { backgroundColor: '#e4e4e4' } })
  await ui.unmount()
})

test('the Inbox has no "Older" fold (2026-11-03): a thread quiet for decades is drawn with the rest', async ($, on) => {
  // Before the mock clock's start, whatever it is: quiet for decades.
  const old = '1900-01-01T00:00:00.000Z'
  const top = WAITING.waiting!.top.map(w => (w.threadId === T_OLD ? { ...w, quietSince: old } : w))
  const { clock } = engine(on, { polled: { ...WAITING, waiting: { ...WAITING.waiting!, top } } })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `open:${T_OLD}` })).toBeDefined()
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  expect(await ui.find({ key: 'fold:forYou' })).toBeUndefined()
  expect(await ui.find({ key: 'fold:open' })).toBeUndefined()
  await ui.unmount()
})

// Red: picker drawn after the key bar (the old place) → the posts still drawn, order differs; no row budget → Cancel cut.
test('a held thread tab, docked: Hand over opens the picker in place of the posts, header and key bar pinned; what does not fit is counted and Cancel stays', async ($, on) => {
  const HELD: UiSnapshot = {
    ...WAITING,
    holds: [{ threadId: T_OLD, title: 'Older ask', channel: 'ops', quietSince: null, unseenByModel: 0, lastBy: null }],
    sessions: [
      { id: 'on1', label: 'live one', online: true },
      { id: 'on2', label: 'live two', online: true },
      ...[1, 2, 3, 4, 5].map(n => ({ id: `off${n}`, label: `closed ${n}`, online: false })),
    ],
  }
  const { clock } = engine(on, { polled: HELD, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(THREAD_A)) : undefined) })
  await start($, clock)
  // Pinned rows 9 (see layout A): 14 rows leave the posts' window 5.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } } })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  const postKeys = async () => (await ui.findAll({ type: 'Box' })).map(b => String(b.key)).filter(k => k.startsWith(`post:${T_OLD}:`))
  expect((await postKeys()).length).toBeGreaterThan(0)
  await ui.press({ key: `handover:${T_OLD}` })
  // The picker is in the posts' window; the posts are gone while it is open; header and key bar where they were.
  expect(await postKeys()).toEqual([])
  const order = (await ui.findAll({})).map(n => String(n.key)).filter(k => ['rule:head', `posts:${T_OLD}`, `picker:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`].includes(k))
  expect(order).toEqual(['rule:head', `posts:${T_OLD}`, `picker:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`])
  expect(await ui.find({ key: `posts:${T_OLD}` })).toMatchObject({ props: { height: 5 } })
  const picks = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter((k): k is string => !!k && k.startsWith('pick'))
  // Head, 2 online, fold row, foot = 5: it fits.
  expect(await picks()).toEqual([`pick:${T_OLD}:on1`, `pick:${T_OLD}:on2`, `pick-offline:${T_OLD}`, `pick-new:${T_OLD}`, `pick-cancel:${T_OLD}`])
  // Shown, 7 rows do not fit 5: one session, a count of the rest, and Cancel still there.
  await ui.press({ key: `pick-offline:${T_OLD}` })
  expect(await picks()).toEqual([`pick:${T_OLD}:on1`, `pick-offline:${T_OLD}`, `pick-new:${T_OLD}`, `pick-cancel:${T_OLD}`])
  expect(await findRun(ui, '6 more · a taller pane shows them')).toMatchObject({ props: { dimColor: true } })
  // Cancel: the posts come back.
  await ui.press({ key: `pick-cancel:${T_OLD}` })
  expect((await postKeys()).length).toBeGreaterThan(0)
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeUndefined()
  // The picker belongs to the tab it opened on (live 2026-11-04): opened on Held, the thread tab shows its
  // posts, and its first Hand over opens the picker rather than closing Held's.
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: `handover:${T_OLD}` })
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeDefined()
  await ui.press({ key: `tab:${T_OLD}` })
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeUndefined()
  expect((await postKeys()).length).toBeGreaterThan(0)
  // Closed, not hidden: back on Held it does not come back.
  await ui.press({ key: 'tab:held' })
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeUndefined()
  await ui.press({ key: `tab:${T_OLD}` })
  await ui.press({ key: `handover:${T_OLD}` })
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeDefined()
  // And back on Held it is closed there.
  await ui.press({ key: 'tab:held' })
  expect(await ui.find({ key: `picker:${T_OLD}` })).toBeUndefined()
  await ui.unmount()
})

test('a thread tab takes on t and copies the new-session command on n', async ($, on) => {
  const thread = { thread: { id: T_OLD, title: 'Older ask' }, messages: [], has_older: false, older_count: 0 }
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await ui.find({ key: `take:${T_OLD}` })).toMatchObject({ props: { hotkey: 't' } })
  expect(await ui.find({ key: `new:${T_OLD}` })).toMatchObject({ props: { hotkey: 'n' } })
  await ui.unmount()
})

for (const surface of ['desktop', 'vscode'] as const) {
  test(`${surface}: titles are links (a desktop draws every Button as a pill), no row actions; a link press opens the thread tab, which has Take and New`, async ($, on) => {
    const thread = { thread: { id: T_NEW, title: 'Newer ask' }, messages: [], has_older: false, older_count: 0 }
    const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
    await start($, clock)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: `open:${T_NEW}` })).toMatchObject({ type: 'Markdown', props: { text: `[Newer ask](https://einweave.invalid/${T_NEW})` } })
    expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => /^(open|take|new):/.test(k))).toEqual([])
    await ui.press({ key: `open:${T_NEW}`, link: { href: `https://einweave.invalid/${T_NEW}` } } as never)
    await clock.settle()
    expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_NEW }])
    // A desktop takes no hotkeys (its webview drops them), so its buttons name no key: `Take`, not `t Take`.
    expect(await ui.find({ key: `take:${T_NEW}` })).toMatchObject({ props: { label: 'Take' } })
    expect(await ui.find({ key: `new:${T_NEW}` })).toMatchObject({ props: { label: 'New session' } })
    expect(await findRun(ui, /^[rtn]$/)).toBeUndefined()
    await ui.unmount()
  })
}

test('a held thread\'s tab has Release (the desktop\'s only way to it); a followed channel\'s tab sends joining to the web app', async ($, on) => {
  const thread = { thread: { id: 't1', title: 'Fix the build' }, messages: [], has_older: false, older_count: 0 }
  const { calls, clock } = engine(on, {
    answer: c =>
      c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : c.tool === 'ui_channel' ? text(JSON.stringify({ ...OPS_THREADS, channel_id: CH_FOLLOW })) : undefined,
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: 'open:t1', link: { href: 'https://einweave.invalid/t1' } } as never)
  await clock.settle()
  expect(await ui.find({ key: 'take:t1' })).toBeUndefined()
  await ui.press({ key: 'release:t1' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'release').map(c => c.args)).toEqual([{ ref: 't1' }])
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `open:ch:${CH_FOLLOW}`, link: { href: `https://einweave.invalid/ch%3A${CH_FOLLOW}` } } as never)
  await clock.settle()
  expect(await findRun(ui, 'Following, not a member: join in the web app to take.')).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).some(b => String(b.key).startsWith('join'))).toBe(false)
  expect(calls.some(c => c.tool === 'join_channel')).toBe(false)
  await ui.unmount()
})

test('the button standard: full strength only for the shown tab and the one thing to do; all else dim (a desktop draws no variant)', async ($, on) => {
  const old = '1900-01-01T00:00:00.000Z'
  const top = WAITING.waiting!.top.map(w => (w.threadId === T_OLD ? { ...w, quietSince: old } : w))
  const thread = (id: string) => ({ thread: { id, title: id }, messages: [], has_older: false, older_count: 0 })
  const { clock } = engine(on, {
    polled: { ...WAITING, holds: [{ threadId: T_NEW, title: 'Newer ask' }], waiting: { ...WAITING.waiting!, top } },
    answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread(String(c.args.thread_id)))) : undefined),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const full = async () => (await ui.findAll({ type: 'Button' })).filter(b => !(b.props as { dimColor?: boolean }).dimColor).map(b => String(b.key))
  expect(await full()).toEqual(['tab:inbox'])
  // A thread not held: Take is the one thing to do. One held: nothing is (Release gives it up).
  await ui.press({ key: `open:${T_CH}`, link: { href: `https://einweave.invalid/${T_CH}` } } as never)
  await clock.settle()
  expect(await full()).toEqual([`tab:${T_CH}`, `take:${T_CH}`])
  await ui.press({ key: 'tab:inbox' })
  await ui.press({ key: `open:${T_NEW}`, link: { href: `https://einweave.invalid/${T_NEW}` } } as never)
  await clock.settle()
  expect(await full()).toEqual([`tab:${T_NEW}`])
  await ui.unmount()
})

test('the band lists what is aimed at you (board Main): #channel brand, the title, why amber; View opens the pane on its tab, Take takes it', async ($, on) => {
  const thread = { thread: { id: T_NEW, title: 'Newer ask' }, messages: [], has_older: false, older_count: 0 }
  const { calls, pane, clock } = engine(on, {
    polled: WAITING,
    now: Date.parse('2026-10-30T10:00:00.000Z'),
    answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : c.tool === 'take' ? text('This session now holds Older ask.') : undefined),
  })
  await start($, clock)
  const band = await $.ui.mount(BAND)
  // Addressed only: taken part in, and the channel tier, wait in the pane.
  const rows = (await band.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('band-view:'))
  expect(rows).toEqual([`band-view:${T_NEW}`])
  expect(await band.find({ key: `band:${T_NEW}` })).toMatchObject({ text: expect.stringMatching(/^#ops\s*↳\s*Newer ask\s*addressed to you · unheld/) })
  expect(await findRun(band, 'addressed to you · unheld')).toMatchObject({ props: { color: '#e8b04a' } })
  await band.press({ key: `band-view:${T_NEW}` })
  await clock.settle()
  expect(pane).toMatchObject({ up: true, opens: 1 })
  expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_NEW }])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shownPill(await ui.find({ key: `tab:${T_NEW}` }))
  await ui.unmount()
  await band.press({ key: `band-take:${T_NEW}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: T_NEW }])
  await band.unmount()
})

test('an ask quiet a day or more leaves the band (it waits in the pane): the band is for what needs you now', async ($, on) => {
  // Newer ask was last active 2026-10-30 09:50: in the band until 09:50 the next day, not after.
  const { clock } = engine(on, { polled: WAITING, now: Date.parse('2026-10-31T09:49:00.000Z') })
  await start($, clock)
  const band = await $.ui.mount(BAND)
  expect((await band.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('band-view:'))).toEqual([`band-view:${T_NEW}`])
  await band.unmount()
  await clock.advance(60_000)
  const later = await $.ui.mount(BAND)
  expect((await later.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('band-view:'))).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  await ui.unmount()
  await later.unmount()
})

test('a held thread\'s tab is live (board ThreadTab): read again every 15 s while shown, and says so; no Refresh', async ($, on) => {
  const thread = { thread: { id: 't1', title: 'Fix the build' }, messages: [], has_older: false, older_count: 0 }
  // Connected, then a drop still retrying (the tabs stay): the stamp says live only while replies can arrive.
  let dropped = false
  const { calls, clock } = engine(on, {
    get polled() {
      return dropped ? { ...SNAP, connection: { state: 'disconnected', detail: 'disconnected (reconnect attempt 1, in 2s)' } } : SNAP
    },
    answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: 'open:t1' })
  await clock.settle()
  expect(await findRun(ui, 'held by you · replies come here')).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await findRun(ui, '● ')).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await findRun(ui, 'live')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, '○ reconnecting')).toBeUndefined()
  expect(await ui.find({ key: 'refresh:t1' })).toBeUndefined()
  const reads = () => calls.filter(c => c.tool === 'ui_thread').length
  expect(reads()).toBe(1)
  await clock.advance(15_100)
  expect(reads()).toBe(2)
  // The connection drops, still retrying: the tab stays, and its stamp stops saying live.
  // The minute poll (at 60 s) reads the drop; inside the band's grace it is "reconnecting", the tabs kept.
  dropped = true
  await clock.advance(45_500)
  expect(await findRun(ui, '○ reconnecting')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, 'live')).toBeUndefined()
  // Not shown: not read.
  const before = reads()
  await ui.press({ key: 'tab:inbox' })
  await clock.advance(30_100)
  expect(reads()).toBe(before)
  await ui.unmount()
})

test('the Session tab is the canvas\'s label / value grid, with Disconnect and Sign out', async ($, on) => {
  const { calls, clock } = engine(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:session' })
  expect(await ui.find({ key: 'row:state' })).toMatchObject({ text: expect.stringMatching(/^State\s*● connected$/) })
  expect(await findRun(ui, '● connected')).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await ui.find({ key: 'row:agent' })).toMatchObject({ text: expect.stringMatching(/^Agent\s*@bellman$/) })
  expect(await ui.find({ key: 'row:plugin' })).toMatchObject({ text: expect.stringMatching(/^Plugin\s*0\.38\.0$/) })
  expect(await findRun(ui, 'State')).toMatchObject({ props: { dimColor: true } })
  await ui.press({ key: 'disconnect' })
  await ui.press({ key: 'logout' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'disconnect' || c.tool === 'logout').map(c => c.tool)).toEqual(['disconnect', 'logout'])
  expect(await ui.find({ key: 'logout' })).toMatchObject({ props: { label: 'Sign out', dimColor: true } })
  await ui.unmount()
})

/** Board ThreadTab, layout A: a root, a long post, a reply this agent sent, and two new ones. */
const LONG = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
const THREAD_A = {
  thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' },
  channel_id: 'c',
  channel: 'ops',
  messages: [
    // The server's doc, as ui_thread hands it over (RFC-034 D6): the mod draws it and parses nothing.
    { sender: 'Kevin', senderId: 'kevin', content: 'Can I take the NAS at **14:00**?', doc: [['p', 0, 'Can I take the NAS at ', ['strong', 0, '14:00'], '?']], type: 'question', ts: '2026-10-30T08:00:00.000Z', seq: 1, own: false, new: false, root: true },
    { sender: 'Brian', content: LONG, type: 'text', ts: '2026-10-30T08:05:00.000Z', seq: 30, own: false, new: false },
    { sender: 'Bellman', senderId: 'bellman', content: 'On it: see https://example.com/x', doc: [['p', 0, 'On it: see ', ['a', { href: 'https://example.com/x' }, 'https://example.com/x']]], type: 'text', ts: '2026-10-30T08:06:00.000Z', seq: 31, own: true, new: false },
    { sender: 'Kevin', content: 'thanks', type: 'text', ts: '2026-10-30T08:07:00.000Z', seq: 32, own: false, new: true },
    { sender: 'Kevin', content: 'one more', type: 'text', ts: '2026-10-30T08:08:00.000Z', seq: 33, own: false, new: true },
  ],
  has_older: true,
  older_count: 25,
}
/** The posts window's inner Box: its negative bottom margin is how far up the window is. */
const offOf = async (ui: { find(q: object): Promise<{ children: unknown[] } | undefined> }) =>
  -Number(((await ui.find({ key: `posts:${T_OLD}` }))?.children[0] as { props: { marginBottom: number } }).props.marginBottom)
// `offset` where the engine would put its window (moved by `by`): the mod holds it one row in instead.
const scrollEv = (by: number) => ({ component: 'Pane', requestId: 'einweave', offset: Math.max(0, 1 + by), by, bodyRows: 30, contentRows: 32, origin: { kind: 'person' } }) as never

test('layout A, docked: posts in chat order under a pinned header and footer, the tree the window plus a spacer row each end', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(THREAD_A)) : undefined) })
  await start($, clock)
  // Pinned: name 1, gap 1, tabs 1, rule 1, thread header 3 (title, hold, rule), key bar 2 (rule, keys) = 9; 26 rows leave 17.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 26 } } })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await ui.find({ key: 'pane' })).toMatchObject({ props: { height: 26 + 2 } })
  // The gap under the name is drawn here too, the row `pinned` counts for it.
  expect(await ui.find({ key: 'gap:tabs' })).toMatchObject({ props: { height: 1 } })
  const keys = async () => (await ui.findAll({ type: 'Box' })).map(b => String(b.key)).filter(k => k.startsWith(`post:${T_OLD}:`))
  // Only what meets the window is drawn: 17 rows of 22 leave the root above it (a long thread stays cheap per tick).
  expect(await keys()).toEqual(['s30', 's31', 's32', 's33'].map(k => `post:${T_OLD}:${k}`))
  // Overflowing: bottom-anchored, the newest at the window's foot.
  expect(await ui.find({ key: `posts:${T_OLD}` })).toMatchObject({ props: { justifyContent: 'flex-end' } })
  await ui.unmount()
  // Room for all 22 rows: every post, in chat order.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 40 } } })
  await clock.settle()
  expect(await keys()).toEqual(['root', 's30', 's31', 's32', 's33'].map(k => `post:${T_OLD}:${k}`))
  expect(await ui.find({ key: `tail:${T_OLD}` })).toBeUndefined()
  // It fits: the posts start under the header, not pushed to the foot with empty rows above (Jörgen 2026-11-04).
  expect(await ui.find({ key: `posts:${T_OLD}` })).toMatchObject({ props: { justifyContent: 'flex-start' } })
  // Own posts blue with (you); new ones say so in the brand, bold.
  expect(await findRun(ui, 'Bellman (you)')).toMatchObject({ props: { color: PALETTE.blue, weight: 'bold' } })
  // Others in their own colour by id; one without an id (an older plugin) stays plain bold.
  expect(await findRun(ui, 'Kevin')).toMatchObject({ props: { color: senderColor('kevin'), weight: 'bold' } })
  expect((await findRun(ui, 'Brian'))?.props.color).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /^new$/ })).toHaveLength(2)
  expect(await findRun(ui, /^new$/)).toMatchObject({ props: { color: PALETTE.brand, weight: 'bold' } })
  // Post text is our own lines: bold run, link run, each line one row.
  expect(await findRun(ui, '14:00')).toMatchObject({ props: { weight: 'bold' } })
  expect(await findRun(ui, 'https://example.com/x')).toMatchObject({ props: { color: PALETTE.blue, underline: true } })
  // A terminal that draws links needs no Option-click hint.
  expect(await findRun(ui, /click a URL/)).toBeUndefined()
  // A link is the kit's Link on the terminal too (an OSC 8 link), not coloured text alone.
  expect((await ui.findAll({ type: 'Link' })).map(l => (l.props as { href?: string }).href)).toContain('https://example.com/x')
  // The long post capped at 6 lines, a "more" row after them.
  expect((await ui.findAll({ type: 'Box' })).filter(b => String(b.key).startsWith(`ln:${T_OLD}:s30:`))).toHaveLength(6)
  expect(await ui.find({ key: `more:${T_OLD}:s30` })).toMatchObject({ props: { label: '▸ 4 more lines', dimColor: true } })
  // Under the root: how many older replies, and Load older.
  expect(await findRun(ui, '25 older replies')).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: `older:${T_OLD}` })).toMatchObject({ props: { label: 'Load 20 older ↑' } })
  // Chrome A (Jörgen 2026-11-01): #channel in the brand before the title; a rule under the header and over the
  // key bar, the posts between; the key bar ends read-only. The long sentence lives on the Session tab.
  expect(await findRun(ui, '#ops')).toMatchObject({ props: { color: PALETTE.brand } })
  const order = (await ui.findAll({})).map(n => String(n.key)).filter(k => ['rule:head', `posts:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`].includes(k))
  expect(order).toEqual(['rule:head', `posts:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`])
  expect(await findRun(ui, 'read-only')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, /Read-only · no tokens/)).toBeUndefined()
  await ui.press({ key: 'tab:session' })
  expect(await findRun(ui, 'Thread tabs are read-only and cost no tokens. new stays new until it reaches Claude.')).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('layout A: opens at the first new post (else the newest); the wheel moves its own window and leaves the engine its own; the top edge loads older', async ($, on) => {
  // The engine beneath: reached only when the plugin hands the engine's own window on.
  const offsets: number[] = []
  on('ui.scroll', ($, e) => {
    offsets.push(e.offset)
    return {}
  })
  const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(c.args.before_seq ? { ...THREAD_A, messages: [THREAD_A.messages[0], { sender: 'Kevin', content: 'older one', type: 'text', ts: null, seq: 10 }], has_older: true, older_count: 5 } : THREAD_A)) : undefined) })
  await start($, clock)
  // Pinned: name 1, gap 1, tabs 1, rule 1, thread header 3, key bar 2 = 9; a 13-row body leaves 4.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 13 } } })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  // Rows: root 2, gap 2, s30 9, s31 3, s32 3, s33 3 = 22; s32's sender row is row 17: 22 - 4 - 17 up from the end.
  expect(await offOf(ui)).toBe(1)
  expect(await $.ui.scroll(scrollEv(-2))).toEqual({})
  expect(await offOf(ui)).toBe(3)
  await $.ui.scroll(scrollEv(100))
  expect(await offOf(ui)).toBe(0)
  expect(calls.filter(c => c.tool === 'ui_thread' && c.args.before_seq)).toEqual([])
  await $.ui.scroll(scrollEv(-100))
  await clock.settle()
  expect(await offOf(ui)).toBe(22 - 4)
  expect(offsets).toEqual([])
  expect(calls.filter(c => c.tool === 'ui_thread' && c.args.before_seq).map(c => c.args)).toEqual([{ thread_id: T_OLD, before_seq: 30, limit: 20 }])
  expect(await ui.find({ key: `post:${T_OLD}:s10` })).toBeDefined()
  expect(await findRun(ui, '5 older replies')).toBeDefined()
  // A fresh read (↻, or a held thread's live one) brings the newest page again: the older page stays.
  await ui.press({ key: `refresh:${T_OLD}` })
  await clock.settle()
  expect(await ui.find({ key: `post:${T_OLD}:s10` })).toBeDefined()
  expect(await findRun(ui, '5 older replies')).toBeDefined()
  await ui.unmount()
})

test('layout A: × forgets the place: View opens the tab again where it lands, not where it was left', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(THREAD_A)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 13 } } })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await offOf(ui)).toBe(1)
  await $.ui.scroll(scrollEv(-100))
  expect(await offOf(ui)).toBe(22 - 4)
  await ui.press({ key: `close:${T_OLD}` })
  await clock.settle()
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await offOf(ui)).toBe(1)
  await ui.unmount()
})

test('layout A: "more" opens a capped post in place; inline (or on a desktop) the posts flow and the surface scrolls them', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(THREAD_A)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  await ui.press({ key: `more:${T_OLD}:s30` })
  expect((await ui.findAll({ type: 'Box' })).filter(b => String(b.key).startsWith(`ln:${T_OLD}:s30:`))).toHaveLength(10)
  expect(await ui.find({ key: `more:${T_OLD}:s30` })).toBeUndefined()
  await ui.unmount()
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline' } })
  expect((await inline.find({ key: 'pane' }))?.props).not.toHaveProperty('height')
  expect((await inline.find({ key: `posts:${T_OLD}` }))?.props).not.toHaveProperty('height')
  expect(await inline.find({ key: `ln:${T_OLD}:root:0` })).toBeDefined()
  await inline.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'vscode' })
  // A desktop draws the same lines from the doc, never the kit's Markdown over `content` (RFC-034 D6); links are the kit's Link.
  expect(await desk.find({ key: `md:${T_OLD}:root` })).toBeUndefined()
  expect(await desk.find({ type: 'Markdown', text: /14:00/ })).toBeUndefined()
  expect(await desk.find({ key: `ln:${T_OLD}:root:0` })).toBeDefined()
  expect(await findRun(desk, '14:00')).toMatchObject({ props: { weight: 'bold' } })
  expect((await desk.findAll({ type: 'Link' })).map(l => (l.props as { href?: string }).href)).toContain('https://example.com/x')
  await desk.unmount()
})

test('layout A: the spacers follow the window, so whatever row it opens on it shows exactly the pane (no top spacer before the first scroll); the wheel leaves the engine its own window', async ($, on) => {
  const offsets: number[] = []
  on('ui.scroll', ($, e) => {
    offsets.push(e.offset)
    return {}
  })
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(THREAD_A)) : undefined) })
  await start($, clock)
  for (const [offset, top, end] of [[0, undefined, 2], [1, 1, 1], [2, 2, undefined]] as const) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset, bodyRows: 16 } } })
    if (!offset) await ui.press({ key: `open:${T_OLD}` })
    await clock.settle()
    expect((await ui.find({ key: 'spacer:top' }))?.props.height).toBe(top)
    expect((await ui.find({ key: 'spacer:end' }))?.props.height).toBe(end)
    // Wherever it was, the wheel keeps it there: a commit, even to row 0, let the engine show a row off the tree drawn.
    await $.ui.scroll({ ...(scrollEv(-1) as object), offset: offset + 1 } as never)
    expect(offsets).toEqual([])
    await ui.unmount()
  }
})

// Claude Code before 2.1.299 has no Text `weight` and refuses a tree that names it whole: an empty pane,
// no band (seen on 2.1.296 under WSL, 2026-11-03). There the band and the pane say what to do instead.
for (const engineVersion of ['2.1.296', null] as const) {
  test(`on Claude Code ${engineVersion ?? 'with no version call'} the band and the pane say to update, with no weight anywhere`, async ($, on) => {
    const { clock } = engine(on, { engineVersion })
    await start($, clock)
    for (const target of [BAND, { ...PANE, surface: 'terminal' as const }] as const) {
      const ui = await $.ui.mount(target)
      const need = await findRun(ui, 'einweave needs Claude Code 2.1.299 or later')
      expect(need?.text).toBe(`einweave needs Claude Code 2.1.299 or later (this is ${engineVersion ?? 'an older version'}).`)
      expect((await findRun(ui, 'claude update'))?.text).toBe('Run `claude update`, then restart Claude Code.')
      for (const t of await ui.findAll({ type: 'Text' })) expect(t.props).not.toHaveProperty('weight')
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      await ui.unmount()
    }
  })
}

// Terminal.app (and any terminal not known to draw OSC 8): the kit's Link would print its URL after the
// text, uncounted, and every row overflowed (seen 2026-11-03). There a link is plain text with its URL
// after it, counted in the width, for the terminal's own URL detection.
test('a terminal without OSC 8 links: no Link; the URL is part of the line, counted in the width', async ($, on) => {
  const named = { ...THREAD_A, messages: THREAD_A.messages.map((m, i) => (i === 2 ? { ...m, doc: [['p', 0, 'On it: see ', ['a', { href: 'https://example.com/x' }, 'the PR']]] } : m)) }
  const { clock } = engine(on, { env: { TERM_PROGRAM: 'Apple_Terminal' }, polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(named)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 40 } } })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  // Terminal.app opens a URL on Option+click (Claude Code takes the plain and Cmd clicks): the footer says so.
  expect(await findRun(ui, '⌥-click a URL to open it ·')).toBeDefined()
  const row = (await ui.findAll({ type: 'Box' })).find(b => String(b.key) === `ln:${T_OLD}:s31:0`)
  expect(row).toBeDefined()
  expect(await findRun(ui, 'https://example.com/x')).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('on Claude Code 2.1.299, the minimum, the band and the pane draw as usual', async ($, on) => {
  const { clock } = engine(on, { engineVersion: '2.1.299' })
  await start($, clock)
  for (const target of [BAND, { ...PANE, surface: 'terminal' as const }] as const) {
    const ui = await $.ui.mount(target)
    expect(await findRun(ui, 'needs Claude Code')).toBeUndefined()
    expect(await findRun(ui, 'einweave')).toBeDefined()
    await ui.unmount()
  }
})

// ── Inbox search (RFC-031, board Search) ─────────────────────────────────────────────────────────

const hitRow = (id: string, title: string, o: Record<string, unknown> = {}) => ({
  thread_id: id, title, channel: 'ops', kind: 'question', status: 'open', matched_in: 'message', matching_replies: 3,
  last_activity_at: '2026-10-30T09:00:00.000Z', similar_title: false,
  snippet_parts: [{ text: 'after the ', hit: false }, { text: 'deploy', hit: true }, { text: ' window', hit: false }],
  ...o,
})
const searchPageOf = (rows: unknown[], o: Record<string, unknown> = {}) => text(JSON.stringify({ query: { text: 'deploy', filters: [], sort: 'relevance' }, type: 'threads', results: rows, next: null, total: { count: rows.length, capped: false }, ...o }))

test('Inbox search: typing waits for a pause, then the results replace the sections; hits bold, where it matched, Take or Release by hold', async ($, on) => {
  const { calls, clock } = engine(on, {
    polled: { ...WAITING, holds: [{ threadId: 't1', title: 'Fix the build' }] },
    now: Date.parse('2026-10-30T10:00:00.000Z'),
    answer: c => (c.tool === 'ui_search' ? searchPageOf([hitRow(T_NEW, 'Deploy window today'), hitRow('t1', 'Fix the build')]) : undefined),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'h:forYou' })).toBeDefined()
  // A field that looks like one (live check 2026-11-03: bare, it read as hint text).
  expect(await ui.find({ key: 'search-box' })).toMatchObject({ props: { borderStyle: 'round' } })
  await ui.input({ key: 'search', text: 'dep', kind: 'change' })
  await ui.input({ key: 'search', text: 'deploy', kind: 'change' })
  await clock.advance(100)
  expect(calls.filter(c => c.tool === 'ui_search')).toEqual([])
  await clock.advance(200)
  await clock.settle()
  // One request, for the text as it stood after the pause.
  expect(calls.filter(c => c.tool === 'ui_search').map(c => c.args)).toEqual([{ query: 'deploy', type: 'threads', sort: 'relevance' }])
  expect(await ui.find({ key: 'h:forYou' })).toBeUndefined()
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  // The hit, inside the result's snippet line (the header names the query too).
  const snippetLine = (await ui.findAll({ type: 'Text' })).find(t => JSON.stringify(t).includes('"after the "')) as any
  expect(snippetLine.children.find((c: any) => c?.type === 'Text' && c.children?.[0] === 'deploy')).toMatchObject({ props: { weight: 'bold' } })
  expect(await findRun(ui, 'after the ')).toMatchObject({ props: { dimColor: true } })
  expect(await findRun(ui, '3 replies match')).toBeDefined()
  expect(await ui.find({ key: `take:${T_NEW}` })).toBeDefined()
  expect(await ui.find({ key: 'release:t1' })).toBeDefined()
  expect(await ui.find({ key: 'take:t1' })).toBeUndefined()
  expect(await ui.find({ key: 'search-threads' })).toMatchObject({ props: { label: 'Threads 2' } })
  // What was searched is said above the results, whatever the field shows.
  expect(await findRun(ui, 'deploy')).toBeDefined()
  expect(await findRun(ui, 'Results')).toBeDefined()
  expect(await findRun(ui, 'for \u201Cdeploy\u201D')).toBeDefined()
  // Cleared: the Inbox again, with no request.
  await ui.input({ key: 'search', text: '', kind: 'change' })
  await clock.advance(300)
  await clock.settle()
  expect(await ui.find({ key: 'h:forYou' })).toBeDefined()
  expect(calls.filter(c => c.tool === 'ui_search')).toHaveLength(1)
  await ui.unmount()
})

test('Inbox search: an answer for an older query never draws over a newer one', async ($, on) => {
  let clockRef: { sleep(ms: number): Promise<void> } | null = null
  const { clock } = engine(on, {
    polled: WAITING,
    answer: async c => {
      if (c.tool !== 'ui_search') return undefined
      if (c.args.query === 'slow') {
        await clockRef!.sleep(1_000)
        return searchPageOf([hitRow('t-slow', 'Slow answer')])
      }
      return searchPageOf([hitRow('t-fast', 'Fast answer')])
    },
  })
  clockRef = clock
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'slow', kind: 'change' })
  await clock.advance(260)
  await ui.input({ key: 'search', text: 'fast', kind: 'change' })
  await clock.advance(260)
  await clock.settle()
  expect(await ui.find({ key: 'open:t-fast' })).toBeDefined()
  await clock.advance(1_000)
  await clock.settle()
  expect(await ui.find({ key: 'open:t-fast' })).toBeDefined()
  expect(await ui.find({ key: 'open:t-slow' })).toBeUndefined()
  await ui.unmount()
})

test('Inbox search: a refusal says why; a suggestion pressed rewrites the query and searches at once', async ($, on) => {
  const { calls, clock } = engine(on, {
    polled: WAITING,
    answer: c =>
      c.tool !== 'ui_search'
        ? undefined
        : c.args.query === 'deploy in:#opz'
          ? text(JSON.stringify({ refused: { code: 'unresolved_filter', token: 'in:#opz', suggestions: ['in:#ops', 'in:#infra'], message: 'Nothing you can read matches in:#opz. Did you mean: in:#ops, in:#infra?' } }))
          : searchPageOf([hitRow(T_NEW, 'Deploy window today')]),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'deploy in:#opz' })
  await clock.settle()
  expect(await findRun(ui, 'Nothing you can read matches in:#opz. Did you mean: in:#ops, in:#infra?')).toMatchObject({ props: { color: '#e8b04a' } })
  await ui.press({ key: 'suggest:in:#ops' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_search').map(c => c.args.query)).toEqual(['deploy in:#opz', 'deploy in:#ops'])
  expect(await ui.find({ key: 'search' })).toMatchObject({ props: { value: 'deploy in:#ops' } })
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  await ui.unmount()
})

test('Inbox search: Messages and Newest search again at once; Similar titles under their heading; More appends the next page', async ($, on) => {
  const { calls, clock } = engine(on, {
    polled: WAITING,
    answer: c => {
      if (c.tool !== 'ui_search') return undefined
      if (c.args.type === 'messages') return searchPageOf([{ message_id: 'm-1', thread_id: T_NEW, thread_title: 'Deploy window today', channel: 'ops', kind: 'question', status: 'open', sender: '@brian', created_at: '2026-10-30T09:00:00.000Z', snippet_parts: [{ text: 'deploy', hit: true }] }])
      if (c.args.cursor === 'p2') return searchPageOf([hitRow('t-p2', 'Second page')])
      return searchPageOf([hitRow(T_NEW, 'Deploy window today'), hitRow('t-sim', 'Deployment checklist', { similar_title: true, matched_in: 'title', matching_replies: 0 })], { next: 'p2', total: { count: 1000, capped: true } })
    },
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'deploy' })
  await clock.settle()
  expect(await ui.find({ key: 'search-threads' })).toMatchObject({ props: { label: 'Threads 1000+' } })
  expect(await ui.find({ key: 'h:similar' })).toBeDefined()
  expect(await ui.find({ key: 'open:t-sim' })).toBeDefined()
  await ui.press({ key: 'search-more' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_search').at(-1)!.args).toEqual({ query: 'deploy', type: 'threads', sort: 'relevance', cursor: 'p2' })
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  expect(await ui.find({ key: 'open:t-p2' })).toBeDefined()
  await ui.press({ key: 'search-messages' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_search').at(-1)!.args).toEqual({ query: 'deploy', type: 'messages', sort: 'relevance' })
  expect(await ui.find({ key: 'open:msg-m-1' })).toBeDefined()
  expect(await findRun(ui, '@brian')).toBeDefined()
  await ui.press({ key: 'search-sort' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_search').at(-1)!.args).toEqual({ query: 'deploy', type: 'messages', sort: 'newest' })
  await ui.unmount()
})

test('Inbox search: nothing found says so, with what to try', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_search' ? searchPageOf([]) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'zzz' })
  await clock.settle()
  expect(await findRun(ui, 'Nothing matches zzz.')).toBeDefined()
  expect(await findRun(ui, 'Fewer words, or drop a filter. Archived threads: add is:archived.')).toBeDefined()
  await ui.unmount()
})

test('Inbox search on mobile (no fields): no search field, the Inbox as before, and the way to search said', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ key: 'search' })).toBeUndefined()
  expect(await findRun(ui, 'Search: /einweave search <words>')).toBeDefined()
  expect(await ui.find({ key: 'h:forYou' })).toBeDefined()
  await ui.unmount()
})

test('Inbox search: the field box is all clickable on a terminal (a blank after the field, as wide as the row); a desktop draws no filler', async ($, on) => {
  // The kit's engine has no implementation for a plugin's own $.ui.focus, so the move itself is checked live.
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const fill = await ui.find({ key: 'search-fill' })
  expect(fill).toBeDefined()
  expect(String((fill as { text?: string }).text ?? '').length).toBeGreaterThanOrEqual(PANE.props.bodyColumns)
  await ui.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await desk.find({ key: 'search-fill' })).toBeUndefined()
  expect(await desk.find({ key: 'search' })).toBeDefined()
  await desk.unmount()
})

test('Inbox search: Tab from the field skips the filler to the first record; Shift-Tab onto it lands in the field', async ($, on) => {
  const landed = ring(on)
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  await focus($, 'search')
  await focus($, 'search-fill')
  expect(landed.at(-1)).toBe(`mark:${T_NEW}`)
  await focus($, 'search-fill')
  expect(landed.at(-1)).toBe('search')
  await ui.unmount()
})

test('Inbox search: a snippet with the message\'s newlines draws on one line', async ($, on) => {
  const row = hitRow(T_NEW, 'Deploy window today', { snippet_parts: [{ text: 'first line\n\nsecond   line ', hit: false }, { text: 'answered', hit: true }, { text: '\nmore', hit: false }] })
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_search' ? searchPageOf([row]) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'answered' })
  await clock.settle()
  expect(await findRun(ui, 'first line second line ')).toBeDefined()
  expect(await findRun(ui, ' more')).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => String((t as { text?: string }).text ?? '').includes('\n'))).toBe(false)
  await ui.unmount()
})

test('Inbox search: Clear empties the query and brings the Inbox back, from results and from a refusal', async ($, on) => {
  const { calls, clock } = engine(on, {
    polled: WAITING,
    answer: c =>
      c.tool !== 'ui_search'
        ? undefined
        : c.args.query === 'x in:#opz'
          ? text(JSON.stringify({ refused: { code: 'unresolved_filter', token: 'in:#opz', suggestions: ['in:#ops'], message: 'Nothing you can read matches in:#opz. Did you mean: in:#ops?' } }))
          : searchPageOf([hitRow(T_NEW, 'Deploy window today')]),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'deploy' })
  await clock.settle()
  expect(await ui.find({ key: 'h:forYou' })).toBeUndefined()
  await ui.press({ key: 'search-clear' })
  await clock.settle()
  expect(await ui.find({ key: 'h:forYou' })).toBeDefined()
  expect(await ui.find({ key: 'search' })).toMatchObject({ props: { value: '' } })
  await ui.input({ key: 'search', text: 'x in:#opz' })
  await clock.settle()
  expect(await ui.find({ key: 'search-clear' })).toBeDefined()
  await ui.press({ key: 'search-clear' })
  await clock.settle()
  expect(await ui.find({ key: 'h:forYou' })).toBeDefined()
  expect(calls.filter(c => c.tool === 'ui_search')).toHaveLength(2)
  await ui.unmount()
})

test('a record\'s line is ONE Text that truncates at its end, its runs inline (a long snippet read "is deplo as" when each run was its own Text)', async ($, on) => {
  const long = 'x'.repeat(200)
  const row = hitRow(T_NEW, 'Deploy window today', { snippet_parts: [{ text: `bellman is being ${long} `, hit: false }, { text: 'deployed', hit: true }, { text: ' as we speak', hit: false }] })
  const { clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_search' ? searchPageOf([row]) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'deploy' })
  await clock.settle()
  const line = (await ui.findAll({ type: 'Text' })).find(t => JSON.stringify(t).includes('"deployed"') && (t as { props?: { wrap?: string } }).props?.wrap === 'truncate-end')
  expect(line).toBeDefined()
  expect(await findRun(ui, 'deployed')).toMatchObject({ props: { weight: 'bold' } })
  await ui.unmount()
})

test('Inbox search: filters alone say "newest first" (what the server did) and offer no Best first; words offer the toggle', async ($, on) => {
  const { clock } = engine(on, {
    polled: WAITING,
    answer: c =>
      c.tool !== 'ui_search'
        ? undefined
        : String(c.args.query).startsWith('in:')
          ? searchPageOf([hitRow(T_NEW, 'Deploy window today', { matched_in: null, snippet_parts: [] })], { query: { text: '', filters: ['in:#ops'], sort: 'newest' } })
          : searchPageOf([hitRow(T_NEW, 'Deploy window today')]),
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'in:#ops' })
  await clock.settle()
  expect(await findRun(ui, 'newest first')).toBeDefined()
  expect(await ui.find({ key: 'search-sort' })).toBeUndefined()
  await ui.input({ key: 'search', text: 'deploy' })
  await clock.settle()
  expect(await ui.find({ key: 'search-sort' })).toMatchObject({ props: { label: 'Newest' } })
  await ui.unmount()
})

