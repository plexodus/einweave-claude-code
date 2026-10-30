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
  expect(await ui.find({ type: 'Text', text: 'name probe' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'scope none' })).toBeDefined()
  await ui.unmount()
})

test('a window that does not hold the session shows its name, with no field to rename it from', async ($, on) => {
  const GONE: UiSnapshot = { ...SNAP, connection: { state: 'superseded', detail: null }, holds: [], waiting: null }
  const { clock } = engine(on, { polled: GONE })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:session' })
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
    // Snapshot order (toWaiting sorted it): For you quiet longest first, then Open.
    top: [
      { threadId: T_OLD, title: 'Older ask', channel: 'ops', why: 'participant', hold: 'parked', quietSince: '2026-10-30T08:00:00.000Z' },
      { threadId: T_NEW, title: 'Newer ask', channel: 'ops', why: 'addressed', hold: 'unheld', quietSince: '2026-10-30T09:50:00.000Z' },
      { threadId: T_CH, title: 'Demo notes', channel: 'general', why: 'channel', hold: 'unheld', quietSince: '2026-10-30T07:00:00.000Z' },
    ],
  },
}

test('the Inbox is the default tab: For you, then Open, each with how long it has been quiet; the tab and each heading count all that waits, not the rows drawn', async ($, on) => {
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab:inbox' })).toMatchObject({ props: { label: 'Inbox 29', variant: 'primary' } })
  // A desktop draws no variant: the tabs not shown are dim, so the shown one stands out everywhere.
  expect(await ui.find({ key: 'tab:inbox' })).not.toMatchObject({ props: { dimColor: true } })
  for (const k of ['tab:held', 'tab:channels', 'tab:session']) expect(await ui.find({ key: k })).toMatchObject({ props: { dimColor: true } })
  const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(keys).toEqual([`open:${T_OLD}`, `open:${T_NEW}`, `open:${T_CH}`])
  // Each heading says how many wait in it (the server's counts), so they add up to the tab: 25 + 4 = 29.
  expect(await ui.find({ type: 'Text', text: 'For you 25' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Open 4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#ops · parked · you took part · \d+[smhd]$/ })).toBeDefined()
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

test('View opens a thread tab read through ui_thread (never read_thread, which would ack it as the model\'s); × closes it', async ($, on) => {
  const thread = { thread: { id: T_OLD, title: 'Older ask', kind: 'question', status: 'open' }, channel_id: 'c', messages: [{ sender: 'Kevin', content: 'Can I take the NAS at 14:00?', type: 'question', ts: '2026-10-30T08:00:00.000Z' }], has_older: true, older_count: 12 }
  const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'ui_thread' ? text(JSON.stringify(thread)) : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `open:${T_OLD}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'ui_thread').map(c => c.args)).toEqual([{ thread_id: T_OLD }])
  expect(calls.some(c => c.tool === 'read_thread')).toBe(false)
  expect(await ui.find({ key: `tab:${T_OLD}` })).toMatchObject({ props: { variant: 'primary' } })
  // Messages are Markdown, as Claude's own replies draw (plan decision 1); a title stays plain Text.
  expect(await ui.find({ key: `md:${T_OLD}:0` })).toMatchObject({ type: 'Markdown', props: { text: 'Can I take the NAS at 14:00?' } })
  expect(await ui.find({ type: 'Text', text: '12 older replies not shown: the web app has them.' })).toBeDefined()
  expect(await ui.find({ key: `take:${T_OLD}` })).toBeDefined()
  await ui.press({ key: `close:${T_OLD}` })
  expect(await ui.find({ key: `tab:${T_OLD}` })).toBeUndefined()
  expect(await ui.find({ key: 'tab:inbox' })).toMatchObject({ props: { variant: 'primary' } })
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
    expect(await ui.find({ key: 'tab:channels' })).toMatchObject({ props: { label: 'Channels 2', variant: 'primary' } })
    expect(await ui.find({ type: 'Text', text: /^2 waiting · oldest \d+[smhd] · 4 open$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 waiting · 2 open · not a member' })).toBeDefined()
    // Only the channel it follows without membership offers Join on its row; a desktop draws no row actions (no hover).
    expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('join:'))).toEqual(surface === 'terminal' ? [`join:ch:${CH_FOLLOW}`] : [])
    expect(await ui.find({ type: 'Text', text: 'counts unknown' })).toBeDefined()
    // A terminal row is one line: a dot parts the name from its meta (`#ops · 2 waiting …`); a desktop's meta has its own line.
    const texts = (n: unknown): string[] =>
      typeof n === 'string' ? [n] : Array.isArray(n) ? n.flatMap(texts) : n && typeof n === 'object' ? texts((n as { children?: unknown }).children ?? []) : []
    for (const id of [CH_OPS, CH_FOLLOW, CH_BARE]) expect(texts(await ui.find({ key: `rec:ch:${id}` })).includes('·')).toBe(surface === 'terminal')
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
  await ui.press({ key: 'refresh:channels' })
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
  expect(await ui.find({ key: `tab:${CH_OPS}` })).toMatchObject({ props: { label: '#ops', variant: 'primary' } })
  const views = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('open:'))
  expect(views).toEqual(['open:t1', 'open:u1', 'open:p1', 'open:h1', 'open:r1'])
  // SNAP holds t1 in this session.
  expect(await ui.find({ type: 'Text', text: 'held here' })).toBeDefined()
  expect(await ui.find({ key: 'take:t1' })).toBeUndefined()
  expect(await ui.find({ key: 'take:r1' })).toBeUndefined()
  expect(await ui.find({ key: 'open:r1' })).toMatchObject({ props: { label: 'Shipped', dimColor: true } })
  // `open` is every live thread's status: never said on its row (was `open · task`).
  expect(await ui.find({ type: 'Text', text: '· task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^· open/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'parked, Kevin #ab12 offline' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'held by Kevin #ab12 online' })).toBeDefined()
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

test('the keyboard stops on titles only: a move onto a record\'s Take goes on to the next title (down) or back to its own (up)', async ($, on) => {
  const landed = ring(on)
  const { clock } = engine(on, { polled: WAITING })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await focus($, `open:${T_OLD}`)
  await focus($, `take:${T_OLD}`)
  expect(landed.at(-1)).toBe(`open:${T_NEW}`)
  // Up from T_NEW's title the ring meets T_OLD's New: back to T_OLD's title.
  await focus($, `new:${T_OLD}`)
  expect(landed.at(-1)).toBe(`open:${T_OLD}`)
  // Past the last record its actions stay reachable: the ring goes on beyond the list.
  await focus($, `open:${T_CH}`)
  await focus($, `take:${T_CH}`)
  expect(landed.at(-1)).toBe(`take:${T_CH}`)
  await ui.unmount()
})

test('a focused record draws its actions with hotkeys (t Take, n New), and the pane still draws', async ($, on) => {
  ring(on)
  const { calls, clock } = engine(on, { polled: WAITING, answer: c => (c.tool === 'take' ? text('This session now holds Newer ask.') : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: `take:${T_NEW}` })).toMatchObject({ props: { label: 'Take' } })
  expect((await ui.find({ key: `take:${T_NEW}` }))?.props).not.toHaveProperty('hotkey')
  await focus($, `open:${T_NEW}`)
  await clock.settle()
  // Drawn shown with the hover reveal still on, the kit refuses the overlay and the whole pane goes blank.
  expect(await ui.find({ key: 'tab:inbox' })).toBeDefined()
  expect(await ui.find({ key: `take:${T_NEW}` })).toMatchObject({ props: { hotkey: 't' } })
  expect(await ui.find({ key: `new:${T_NEW}` })).toMatchObject({ props: { hotkey: 'n' } })
  expect((await ui.find({ key: `take:${T_OLD}` }))?.props).not.toHaveProperty('hotkey')
  await ui.press({ key: `take:${T_NEW}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'take').map(c => c.args)).toEqual([{ ref: T_NEW }])
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

test('Join on a channel it only follows joins it and reads the Channels tab again', async ($, on) => {
  const { calls, toasts, clock } = engine(on, { answer: c => (c.tool === 'ui_channels' ? text(JSON.stringify(CHANNELS)) : c.tool === 'join_channel' ? text('Joined #news.') : undefined) })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `join:ch:${CH_FOLLOW}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'join_channel').map(c => c.args)).toEqual([{ channel_id: CH_FOLLOW }])
  expect(calls.filter(c => c.tool === 'ui_channels').length).toBe(2)
  expect(toasts.at(-1)).toBe('Joined #news.')
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

test('a held thread\'s tab has Release (the desktop\'s only way to it); a followed channel\'s tab has Join', async ($, on) => {
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
  await ui.press({ key: `joinch:${CH_FOLLOW}` })
  await clock.settle()
  expect(calls.filter(c => c.tool === 'join_channel').map(c => c.args)).toEqual([{ channel_id: CH_FOLLOW }])
  expect(calls.filter(c => c.tool === 'ui_channel').length).toBe(2)
  // A channel it is a member of offers no Join.
  await ui.press({ key: 'tab:channels' })
  await clock.settle()
  await ui.press({ key: `open:ch:${CH_OPS}`, link: { href: `https://einweave.invalid/ch%3A${CH_OPS}` } } as never)
  await clock.settle()
  expect(await ui.find({ key: `joinch:${CH_OPS}` })).toBeUndefined()
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
