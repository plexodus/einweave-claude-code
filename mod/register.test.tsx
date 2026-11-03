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
  o: { now?: number; polled?: UiSnapshot | null; polledRev?: number; connectAfterMs?: number; pushed?: string[]; pushes?: string[][]; stayOpen?: boolean; hang?: boolean; answer?: (c: Call) => unknown } = {},
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
  expect(await band.find({ type: 'Text', text: 'einweave' })).toMatchObject({ props: { color: '#4cc3ad', weight: 'bold' } })
  expect(await band.find({ type: 'Text', text: '2 for you' })).toMatchObject({ props: { color: '#e8b04a' } })
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
  expect(await band.find({ type: 'Text', text: /disconnected/ })).toBeUndefined()
  await band.unmount()
  const hint = await $.ui.mount(BAND)
  expect(await said(hint)).toBe('einweave · ↻ reconnecting')
  await hint.unmount()
  // Drawn once and left on screen: the band appears when the grace period ends, with no other change.
  band = await $.ui.mount(BAND)
  await clock.advance(10_100)
  expect(await said(band)).toBe('einweave · ○ disconnected · messages are not arriving')
  expect(await band.find({ type: 'Text', text: /disconnected/ })).toMatchObject({ props: { color: '#f07a7a' } })
  await band.press({ key: 'connect' })
  expect(calls.some(c => c.tool === 'connect')).toBe(true)
  await band.unmount()
})

test('the band yields to a survey', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN })
  await start($, clock)
  await clock.advance(10_100)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await band.find({ type: 'Text', text: /drawn by Claude Code/ })).toBeDefined()
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
  expect(await band.find({ type: 'Text', text: /moved to another window/ })).toMatchObject({ props: { color: '#f07a7a' } })
  // A bare digit in an empty composer presses a band Button that has a hotkey: this one must not have one.
  expect((await band.find({ type: 'Button', key: 'take-back' }))?.props.hotkey).toBeUndefined()
  // The name is the status light: dim while not connected.
  expect(await band.find({ type: 'Text', text: 'einweave' })).toMatchObject({ props: { dimColor: true, weight: 'bold' } })
  expect((await band.find({ type: 'Text', text: 'einweave' }))?.props).not.toHaveProperty('color')
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
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text).toBe('─'.repeat(PANE.props.bodyColumns - 2))
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
  expect(await ui.find({ type: 'Text', text: 'einweave' })).toMatchObject({ props: { color: '#4cc3ad', weight: 'bold' } })
  const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(keys).toEqual([`open:${T_NEW}`, `open:${T_OLD}`, `open:${T_CH}`])
  // Each heading says how many wait in it (the server's counts), so they add up to the tab: 25 + 4 = 29.
  expect(await ui.find({ type: 'Text', text: 'For you 25' })).toMatchObject({ props: { weight: 'bold' } })
  expect(await ui.find({ type: 'Text', text: 'questions and messages aimed at you' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'Unowned 4' })).toMatchObject({ props: { weight: 'bold' } })
  expect(await ui.find({ type: 'Text', text: 'nobody holds these · oldest first' })).toBeDefined()
  // Board Unowned: `#channel` in the brand colour, the title semibold, then why and the hold dim; a stale age amber.
  const row = await ui.find({ key: `open:${T_OLD}` })
  expect(row?.children).toMatchObject([
    { props: { color: '#4cc3ad' }, children: ['#ops'] },
    { children: [' '] },
    { props: { weight: 'semibold' }, children: ['Older ask'] },
  ])
  expect(await ui.find({ type: 'Text', text: 'you took part · holder offline' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: '2 h' })).toMatchObject({ props: { color: '#e8b04a', weight: 'semibold' } })
  expect(await ui.find({ type: 'Text', text: '10 min' })).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('board Unowned: the gateway line says whether unheld work is routed (brand) or waits for a take (amber), then the two notes', async ($, on) => {
  const GW_DOWN: UiSnapshot = { ...WAITING, gateway: { online: false, label: null } }
  const { clock } = engine(on, { polled: GW_DOWN, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '○ no gateway online · unheld work goes to sessions in scope, or waits for a take' })).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ type: 'Text', text: 'Every session of @bellman sees this list. The band stays for things aimed at you.' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'Take brings it here. New session copies a command that starts another window and takes it there.' })).toMatchObject({ props: { dimColor: true } })
  await ui.unmount()
})

test('board Unowned: an online gateway is named in the brand colour', async ($, on) => {
  const GW_UP: UiSnapshot = { ...WAITING, gateway: { online: true, label: 'bridge-gw' } }
  const { clock } = engine(on, { polled: GW_UP, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '● gateway bridge-gw online · routing, usually picked within a minute' })).toMatchObject({ props: { color: '#4cc3ad' } })
  await ui.unmount()
})

test('board Unowned: no gateway in the snapshot (an older plugin server), no gateway line', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING, now: Date.parse('2026-10-30T10:00:00.000Z') })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /gateway/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: 'Connect to see the Inbox, held threads and channels.' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Button', key: 'connect-s' })).toBeDefined()
  await ui.unmount()
  polled = WAITING
  rev = 3
  await clock.advance(61_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  shownPill(await ui.find({ key: `tab:${T_OLD}` }))
  expect(await ui.find({ key: 'tab:inbox' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Connect to see/ })).toBeUndefined()
  await ui.unmount()
})

test('a drop still retrying (reconnecting) keeps every tab: a blip does not blank the pane', async ($, on) => {
  const { clock } = engine(on, { polled: DOWN })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const k of ['tab:inbox', 'tab:held', 'tab:channels', 'tab:session']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Connect to see/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: 'not held here · Claude has not seen it · Take brings it here' })).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ key: `refresh:${T_OLD}` })).toMatchObject({ props: { label: '↻ Refresh' } })
  // How fresh, at the title row's right end: nothing pushes an unheld thread here.
  expect(await ui.find({ type: 'Text', text: /^Updated \d\d:\d\d$/ })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'question' })).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ type: 'Text', text: 'Kevin' })).toMatchObject({ props: { weight: 'bold' } })
  expect((await ui.findAll({ type: 'Text', text: 'Older ask' })).some(t => (t.props as { weight?: string }).weight === 'bold')).toBe(true)
  // Post text is the mod's own lines (decision 2026-10-31, option c): the pane knows each post's rows.
  expect(await ui.find({ key: `ln:${T_OLD}:root:0` })).toMatchObject({ text: 'Can I take the NAS at 14:00?' })
  expect(await ui.find({ type: 'Text', text: '12 older replies' })).toBeDefined()
  expect(await ui.find({ key: `take:${T_OLD}` })).toBeDefined()
  await ui.press({ key: `close:${T_OLD}` })
  expect(await ui.find({ key: `tab:${T_OLD}` })).toBeUndefined()
  shownPill(await ui.find({ key: 'tab:inbox' }))
  await ui.unmount()
})

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
  expect(await ui.find({ type: 'Text', text: 'Loading…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'late' })).toBeUndefined()
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

test('/einweave take N and /einweave find: take by ref, find filters the takeable list and keeps its numbers', async ($, on) => {
  const list = 'Threads this session could take (pick with take N, a link, an id, or words from the title):\n1. #general · Fix the build — unheld\n2. #ops · Review the PR — held by Bellman #cd34 (online)'
  const { calls, clock } = engine(on, { answer: c => (c.tool === 'list_threads' ? text(list) : c.tool === 'take' ? text('This session now holds Fix the build.') : undefined) })
  await start($, clock)
  expect((await $.command.run({ command: 'einweave', args: 'take 1' })).text).toBe('This session now holds Fix the build.')
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: '1' }])
  const found = await $.command.run({ command: 'einweave', args: 'find review' })
  expect(calls.filter(c => c.tool === 'list_threads').map(c => c.args)).toEqual([{ takeable: true, limit: 50 }])
  expect(found.text).toBe('2. #ops · Review the PR — held by Bellman #cd34 (online)\nTake one with /einweave take N.')
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
    expect(await ui.find({ type: 'Text', text: '@bellman is in 3 channels. Every session of the agent shares them.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4 open · 2 unowned · oldest waiting \d+ (s|min|h|d)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 open · 2 unowned · following, not a member' })).toBeDefined()
    // Joining is the web app's (decision Q4, 2026-10-31): no Join anywhere here.
    expect((await ui.findAll({ type: 'Button' })).some(b => String(b.key).startsWith('join'))).toBe(false)
    expect(await ui.find({ type: 'Text', text: 'Join, leave and private channels: in the web app.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'counts unknown' })).toBeDefined()
    // The record standard (as Inbox's `#channel`): regular at rest, so the pointer's bold shows.
    if (surface === 'terminal') {
      const name = await ui.find({ type: 'Text', text: '#ops' })
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
  expect(await ui.find({ type: 'Text', text: 'This einweave server is too old for the Channels tab' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /isn't in any channels/ })).toBeUndefined()
  answer = text(JSON.stringify({ agent: 'bellman', channels: [] }))
  // Shown again, it reads again: nothing pushes the list, and the canvas has no Refresh.
  await ui.press({ key: 'tab:inbox' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: "@bellman isn't in any channels · set up in the web app" })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: 'Open threads, latest activity first.' })).toBeDefined()
  const views = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(views).toEqual(['open:t1', 'open:u1', 'open:p1', 'open:h1', 'open:r1'])
  // SNAP holds t1 in this session.
  expect(await ui.find({ type: 'Text', text: 'held by you' })).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await ui.find({ type: 'Text', text: 'unheld' })).toMatchObject({ props: { color: '#e8b04a' } })
  expect(await ui.find({ key: 'take:t1' })).toBeUndefined()
  expect(await ui.find({ key: 'take:r1' })).toBeUndefined()
  expect(await ui.find({ key: 'open:r1' })).toMatchObject({ props: { label: 'Shipped', dimColor: true } })
  // `open` is every live thread's status: never said on its row (was `open · task`).
  expect(await ui.find({ type: 'Text', text: 'task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^open( ·|$)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'held by Kevin #ab12 · offline' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: 'held by Kevin #ab12 · online' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: 'Loading…' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: 'addressed to you · unheld' })).toMatchObject({ props: { color: '#b8b8b8' } })
  expect((await ui.find({ type: 'Text', text: 'addressed to you · unheld' }))?.props).not.toHaveProperty('dimColor')
  expect(await ui.find({ type: 'Text', text: 'you took part · holder offline' })).toMatchObject({ props: { dimColor: true } })
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
  expect(await ui.find({ type: 'Text', text: 'enter open · esc back' })).toBeUndefined()
  await focus($, `mark:ch:${CH_OPS}`)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'enter open · esc back' }), 'no footer on a record with no actions').toBeDefined()
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
  expect(await ui.find({ key: `mark:${T_OLD}` })).toMatchObject({ children: [' '] })
  await ui.unmount()
})

test('threads quiet over a week fold under "Older (n)", which opens in place', async ($, on) => {
  // Before the mock clock's start, whatever it is: quiet for decades.
  const old = '1900-01-01T00:00:00.000Z'
  const top = WAITING.waiting!.top.map(w => (w.threadId === T_OLD ? { ...w, quietSince: old } : w))
  const { clock } = engine(on, { polled: { ...WAITING, waiting: { ...WAITING.waiting!, top } } })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `open:${T_OLD}` })).toBeUndefined()
  expect(await ui.find({ key: `open:${T_NEW}` })).toBeDefined()
  expect(await ui.find({ key: 'fold:forYou' })).toMatchObject({ props: { label: '▸ Older (1)' } })
  expect(await ui.find({ key: 'fold:open' })).toBeUndefined()
  await ui.press({ key: 'fold:forYou' })
  await clock.settle()
  expect(await ui.find({ key: 'fold:forYou' })).toMatchObject({ props: { label: '▾ Older (1)' } })
  expect(await ui.find({ key: `open:${T_OLD}` })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: /^[rtn]$/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: 'Following, not a member: join in the web app to take.' })).toBeDefined()
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
  await ui.press({ key: 'fold:forYou' })
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
  expect(await band.find({ type: 'Text', text: 'addressed to you · unheld' })).toMatchObject({ props: { color: '#e8b04a' } })
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
  const { calls, clock } = engine(on, { answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:held' })
  await ui.press({ key: 'open:t1' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'held by you · replies come here' })).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await ui.find({ type: 'Text', text: '● live' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: 'refresh:t1' })).toBeUndefined()
  const reads = () => calls.filter(c => c.tool === 'ui_thread').length
  expect(reads()).toBe(1)
  await clock.advance(15_100)
  expect(reads()).toBe(2)
  // Not shown: not read.
  await ui.press({ key: 'tab:inbox' })
  await clock.advance(30_100)
  expect(reads()).toBe(2)
  await ui.unmount()
})

test('the Session tab is the canvas\'s label / value grid, with Disconnect and Sign out', async ($, on) => {
  const { calls, clock } = engine(on)
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:session' })
  expect(await ui.find({ key: 'row:state' })).toMatchObject({ text: expect.stringMatching(/^State\s*● connected$/) })
  expect(await ui.find({ type: 'Text', text: '● connected' })).toMatchObject({ props: { color: '#4cc3ad' } })
  expect(await ui.find({ key: 'row:agent' })).toMatchObject({ text: expect.stringMatching(/^Agent\s*@bellman$/) })
  expect(await ui.find({ key: 'row:plugin' })).toMatchObject({ text: expect.stringMatching(/^Plugin\s*0\.38\.0$/) })
  expect(await ui.find({ type: 'Text', text: 'State' })).toMatchObject({ props: { dimColor: true } })
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
    { sender: 'Kevin', senderId: 'kevin', content: 'Can I take the NAS at **14:00**?', type: 'question', ts: '2026-10-30T08:00:00.000Z', seq: 1, own: false, new: false, root: true },
    { sender: 'Brian', content: LONG, type: 'text', ts: '2026-10-30T08:05:00.000Z', seq: 30, own: false, new: false },
    { sender: 'Bellman', senderId: 'bellman', content: 'On it: see https://example.com/x', type: 'text', ts: '2026-10-30T08:06:00.000Z', seq: 31, own: true, new: false },
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
  await ui.unmount()
  // Room for all 22 rows: every post, in chat order.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 40 } } })
  await clock.settle()
  expect(await keys()).toEqual(['root', 's30', 's31', 's32', 's33'].map(k => `post:${T_OLD}:${k}`))
  expect(await ui.find({ key: `tail:${T_OLD}` })).toBeUndefined()
  // Own posts blue with (you); new ones say so in the brand, bold.
  expect(await ui.find({ type: 'Text', text: 'Bellman (you)' })).toMatchObject({ props: { color: PALETTE.blue, weight: 'bold' } })
  // Others in their own colour by id; one without an id (an older plugin) stays plain bold.
  expect(await ui.find({ type: 'Text', text: 'Kevin' })).toMatchObject({ props: { color: senderColor('kevin'), weight: 'bold' } })
  expect((await ui.find({ type: 'Text', text: 'Brian' }))?.props.color).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /^new$/ })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^new$/ })).toMatchObject({ props: { color: PALETTE.brand, weight: 'bold' } })
  // Post text is our own lines: bold run, link run, each line one row.
  expect(await ui.find({ type: 'Text', text: '14:00' })).toMatchObject({ props: { weight: 'bold' } })
  expect(await ui.find({ type: 'Text', text: 'https://example.com/x' })).toMatchObject({ props: { color: PALETTE.blue, underline: true } })
  // The long post capped at 6 lines, a "more" row after them.
  expect((await ui.findAll({ type: 'Box' })).filter(b => String(b.key).startsWith(`ln:${T_OLD}:s30:`))).toHaveLength(6)
  expect(await ui.find({ key: `more:${T_OLD}:s30` })).toMatchObject({ props: { label: '▸ 4 more lines', dimColor: true } })
  // Under the root: how many older replies, and Load older.
  expect(await ui.find({ type: 'Text', text: '25 older replies' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ key: `older:${T_OLD}` })).toMatchObject({ props: { label: 'Load 20 older ↑' } })
  // Chrome A (Jörgen 2026-11-01): #channel in the brand before the title; a rule under the header and over the
  // key bar, the posts between; the key bar ends read-only. The long sentence lives on the Session tab.
  expect(await ui.find({ type: 'Text', text: '#ops' })).toMatchObject({ props: { color: PALETTE.brand } })
  const order = (await ui.findAll({})).map(n => String(n.key)).filter(k => ['rule:head', `posts:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`].includes(k))
  expect(order).toEqual(['rule:head', `posts:${T_OLD}`, 'rule:foot', `keys:${T_OLD}`])
  expect(await ui.find({ type: 'Text', text: 'read-only' })).toMatchObject({ props: { dimColor: true } })
  expect(await ui.find({ type: 'Text', text: /Read-only · no tokens/ })).toBeUndefined()
  await ui.press({ key: 'tab:session' })
  expect(await ui.find({ type: 'Text', text: 'Thread tabs are read-only and cost no tokens. new stays new until it reaches Claude.' })).toMatchObject({ props: { dimColor: true } })
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
  expect(await ui.find({ type: 'Text', text: '5 older replies' })).toBeDefined()
  // A fresh read (↻, or a held thread's live one) brings the newest page again: the older page stays.
  await ui.press({ key: `refresh:${T_OLD}` })
  await clock.settle()
  expect(await ui.find({ key: `post:${T_OLD}:s10` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5 older replies' })).toBeDefined()
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
  expect(await desk.find({ key: `md:${T_OLD}:root` })).toMatchObject({ type: 'Markdown', props: { text: 'Can I take the NAS at **14:00**?' } })
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
