/**
 * The mod's wiring to `$` (mod/register.tsx), in Claude Code's own test kit: `bun run test:mod`.
 * The rules themselves (indicator, grace, verbs) are unit-tested in test/mod-model.test.ts.
 *
 * Each test stands in for the plugin's MCP server (`mcp.call`) and the relay child
 * (`process.spawn`), so nothing here needs a running plugin.
 */
import { expect, mock, test } from 'claude-code/testing'

import type { UiSnapshot } from '../types'

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
 * Every MCP call and relay start is recorded; `tails` collects the hint tail handed on.
 */
function engine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  o: { polled?: UiSnapshot | null; polledRev?: number; connectAfterMs?: number; pushed?: string[]; pushes?: string[][]; stayOpen?: boolean; hang?: boolean; answer?: (c: Call) => unknown } = {},
) {
  const calls: Call[] = []
  const spawns: { env?: Record<string, string> }[] = []
  const toasts: string[] = []
  const tails: (string | undefined)[] = []
  const clock = mock.clock(on)
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args })
    if (!connected) throw new Error(`no connected MCP tool "${e.tool}" on a server named "plugin:einweave:einweave"`)
    if (o.hang) return new Promise<never>(() => {})
    if (e.tool === 'ui_state') return { value: o.polled === null ? { content: [], isError: true } : text(JSON.stringify({ rev: o.polledRev ?? 1, ...(o.polled ?? SNAP) })) }
    return { value: o.answer?.({ tool: e.tool, args: e.args }) ?? text(`${e.tool} done`) }
  })
  on('process.spawn', async function* ($, e) {
    spawns.push({ env: e.env })
    for (const l of o.pushes?.[spawns.length - 1] ?? o.pushed ?? []) yield { stream: 'stdout' as const, text: l }
    if (o.stayOpen) await clock.sleep(10 ** 12)
    // A call on $, so its result comes back as { value }.
    return { value: { code: 0, signal: null } } as never
  })
  on('ui.render', ($, e) => {
    if (e.component === 'PromptHint') tails.push((e.props as { tail?: string }).tail)
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] }
  })
  return { calls, spawns, toasts, tails, clock, registered }
}

const start = async ($: Parameters<Parameters<typeof test>[1]>[0], clock: { settle(): Promise<void> }) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
}

test('the hint tail shows the first snapshot, then what the relay pushes', async ($, on) => {
  const { tails, clock } = engine(on, { pushed: [line(2, { ...SNAP, holds: [...SNAP.holds, { threadId: 't2', title: null }] })] })
  await start($, clock)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 2 · 2 for you')
  await ui.unmount()
})

test('a relay started against an older plugin, which refuses watch, leaves the poll in charge', async ($, on) => {
  const { tails, calls, clock } = engine(on, { pushed: [JSON.stringify({ ok: false, error: 'bad request' }) + '\n'] })
  await start($, clock)
  const before = calls.filter(c => c.tool === 'ui_state').length
  await clock.advance(60_000)
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(before + 1)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 1 · 2 for you')
  await ui.unmount()
})

test('a drop shows in the band only after 10 s, with Connect; the hint says reconnecting meanwhile', async ($, on) => {
  const { tails, calls, clock } = engine(on, { polled: DOWN })
  await start($, clock)
  let band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /disconnected/ })).toBeUndefined()
  await band.unmount()
  const hint = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · reconnecting')
  await hint.unmount()
  // Drawn once and left on screen: the band appears when the grace period ends, with no other change.
  band = await $.ui.mount(BAND)
  await clock.advance(10_100)
  expect((await band.find({ type: 'Text', text: /einweave/ }))?.children).toEqual(['einweave · disconnected'])
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
  const { calls, tails, clock } = engine(on, { polled: GONE })
  await start($, clock)
  const hint = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · moved to another window')
  await hint.unmount()
  const band = await $.ui.mount(BAND)
  expect((await band.find({ type: 'Text', text: /einweave/ }))?.children).toEqual(['einweave · moved to another window'])
  // A bare digit in an empty composer presses a band Button that has a hotkey: this one must not have one.
  expect((await band.find({ type: 'Button', key: 'take-back' }))?.props.hotkey).toBeUndefined()
  await band.press({ key: 'take-back' })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{ takeover: 'lock' }])
})

test('connect into standby, declined: no takeover', async ($, on) => {
  const STANDBY: UiSnapshot = { ...SNAP, connection: { state: 'standby', detail: null }, holds: [], waiting: null }
  const { calls, clock } = engine(on, { polled: STANDBY })
  on('tool.call', ($, e) => ({ result: { answers: { [(e as { questions: { question: string }[] }).questions[0]!.question]: 'Leave it' } } }))
  await start($, clock)
  await $.command.run({ command: 'einweave', args: 'connect' })
  expect(calls.filter(c => c.tool === 'connect').map(c => c.args)).toEqual([{}])
})

test('the pane lists held threads; Release calls release with the thread id', async ($, on) => {
  const { calls, toasts, clock } = engine(on)
  await start($, clock)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Fix the build' })).toBeDefined()
    expect(await ui.find({ key: 'label' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
  expect(await ui.find({ type: 'Text', text: 'name probe' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'scope none' })).toBeDefined()
  await ui.unmount()
})

test('a window that does not hold the session shows its name, with no field to rename it from', async ($, on) => {
  const GONE: UiSnapshot = { ...SNAP, connection: { state: 'superseded', detail: null }, holds: [], waiting: null }
  const { clock } = engine(on, { polled: GONE })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'name probe' })).toBeDefined()
  await ui.unmount()
})

test('no plugin answer: the tail says so instead of claiming a state', async ($, on) => {
  const { tails, clock } = engine(on, { polled: null })
  await start($, clock)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · not answering')
  await ui.unmount()
})

test('after /clear (state back at its default) the snapshot is read again', async ($, on) => {
  const { tails, calls, clock } = engine(on)
  // No session.start: /clear does not run it; the state starts at its default, as /clear leaves it.
  await $.classic.SessionStart({ source: 'clear' } as never)
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_state').length).toBe(1)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 1 · 2 for you')
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
  const { tails, clock } = engine(on, { polledRev: 40, pushed: [line(1, { ...SNAP, holds: [] })] })
  await start($, clock)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 0 · 2 for you')
  await ui.unmount()
})

test('at startup the first read waits for the plugin\'s server instead of saying "not answering"', async ($, on) => {
  const { tails, clock } = engine(on, { connectAfterMs: 3_000 })
  await start($, clock)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · starting')
  await ui.unmount()
  await clock.advance(3_000)
  const after = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 1 · 2 for you')
  expect(tails).not.toContain('einweave · not answering')
  await after.unmount()
})

test('a relay that found no socket yet (startup) tries again after 2 s, not 10', async ($, on) => {
  const NO_SOCKET = JSON.stringify({ ok: false, error: 'no control socket' }) + '\n'
  const { tails, spawns, clock } = engine(on, { polled: null, pushes: [[NO_SOCKET], [line(1, SNAP)]] })
  await start($, clock)
  expect(spawns.length).toBe(1)
  await clock.advance(2_000)
  expect(spawns.length).toBe(2)
  const ui = await $.ui.mount(HINT)
  expect(tails.at(-1)).toBe('einweave · holds 1 · 2 for you')
  await ui.unmount()
})

test('the relay is started with CLAUDE_PID blanked: one inherited from an outer Claude names that session\'s socket', async ($, on) => {
  const { spawns, clock } = engine(on)
  await start($, clock)
  expect(spawns[0]?.env).toEqual({ CLAUDE_PID: '' })
})
