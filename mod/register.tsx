/**
 * The einweave mod (plan 2026-10-25-terminal-ui.md, Phase 2): the hint-line indicator, a band while
 * the connection is lost, the pane (session, held threads) and one command, `/einweave [verb]`.
 *
 * Data: this plugin's own MCP server is the single source. ui/ctl-watch.ts, started here for the
 * session's life, relays the control socket's `watch` stream (a snapshot per change); `ui_state`
 * answers the first draw, a re-read after /clear, and every minute while the relay is down.
 * Every action calls one of the plugin's tools: no model turn, no tokens.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UiSnapshot } from '../types'
import { applySnapshot, EMPTY_VIEW, fromTool, indicator, needsBand, parseCommand, parseLine, scopeText, statusSummary, textOf, BAND_GRACE_MS } from './model'

const SERVER = 'plugin:einweave:einweave'
const PANE = 'einweave'
const RELAY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000]
const POLL_MS = 60_000
const SETTLE_MS = 10_000
const SETTLE_STEP_MS = 500

const view = atom({ plugin: 'einweave', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-1' })

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The command first: a reload runs this again while the plugin's server may be slow to answer,
    // and nothing here may wait on it. Drawings redraw when the first snapshot lands.
    try {
      await $.command.register({
        name: 'einweave',
        description: 'einweave: open the pane, or status | connect | disconnect | rename | scope | held | release | handover',
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
        const opened = await $.ui.open({ id: PANE, title: 'einweave' })
        return opened.isPlaced ? {} : { text: `The pane waits for a wider terminal. ${indicator(await read($, view), await $.clock.now()).text}` }
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
    }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const i = indicator(await read($, view), await $.clock.now())
    return next({ ...e, props: { ...e.props, tail: i.text } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const i = indicator(v, await $.clock.now())
    if (e.props.hasSurvey || !needsBand(i)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text color="red">{i.text}</Text>
        {v.snap?.connection.detail ? <Text dimColor wrap="truncate-end">{v.snap.connection.detail}</Text> : null}
        {/* No hotkey: a bare digit in an empty composer would press it, and taking back evicts the other window's live session. */}
        {i.kind === 'superseded' ? (
          <Button key="take-back" label="Take it back" plain onPress={() => void takeBack($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))} />
        ) : (
          <Button key="connect" label="Connect" hotkey="1" plain onPress={() => void connect($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))} />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The mobile surface has no fields (its table lacks them; drawn there they are empty): there the
    // name and scope are shown, not edited.
    const fields = e.surface !== 'mobile'
    const Input = fields && 'Input' in els ? els.Input : null
    const Select = fields && 'Select' in els ? els.Select : null
    const v = await read($, view)
    const i = indicator(v, await $.clock.now())
    const s = v.snap
    const color = i.kind === 'connected' ? undefined : i.kind === 'disconnected' || i.kind === 'superseded' || i.kind === 'no-answer' ? 'red' : 'yellow'
    const act = (tool: string, args: Record<string, unknown>) => () =>
      void $.mcp.call(SERVER, tool, args).then(
        r => $.ui.toast(textOf(r).split('\n')[0] || (r.isError ? `${tool} failed` : 'Done.')),
        err => $.ui.toast(`${tool} failed: ${String(err).slice(0, 120)}`),
      )
    const connected = s?.connection.state === 'connected'
    return (
      <Box flexDirection="column">
        <Text color={color} weight="semibold">{i.text}</Text>
        {s && !connected && s.connection.detail ? <Text dimColor>{s.connection.detail}</Text> : null}
        {!s && v.error ? <Text dimColor>{v.error}</Text> : null}
        {s && !connected ? (
          i.kind === 'superseded' ? (
            <Button key="take-back" label="Take it back" onPress={() => void takeBack($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))} />
          ) : (
            <Button key="connect" label="Connect" onPress={() => void connect($).then(t => $.ui.toast(t.split('\n')[0] ?? 'Connecting'))} />
          )
        ) : null}
        {s ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="semibold">Session</Text>
            <Text>{`agent ${s.session.agent ?? '-'} · ${s.session.kind ?? 'session'} · plugin ${s.version}`}</Text>
            {s.staleSince ? <Text color="yellow">Plugin updated on disk: restart Claude Code to use it.</Text> : null}
            {Input && connected ? (
              <Input key="label" label="Name" value={s.session.label ?? ''} placeholder="this session's name" submitLabel="rename" onSubmit={(label: string) => act('set_session_label', { label })()} />
            ) : (
              <Text>{`name ${s.session.label ?? '-'}`}</Text>
            )}
            {s.session.scope && !Select ? <Text>{`scope ${scopeText(s.session.scope)}`}</Text> : null}
            {s.session.scope && Select ? (
              <Select
                key="scope"
                label="Scope"
                value={s.session.scope.mode}
                options={[
                  { value: 'none', label: scopeText({ mode: 'none', channelIds: [] }) },
                  { value: 'all', label: scopeText({ mode: 'all', channelIds: [] }) },
                  ...(s.session.scope.mode === 'channels' ? [{ value: 'channels', label: scopeText(s.session.scope) }] : []),
                ]}
                onSelect={(mode: string) => {
                  if (mode !== 'channels') act('scope', { channels: mode })()
                }}
              />
            ) : null}
          </Box>
        ) : null}
        {connected ? (
          <Box flexDirection="column" marginTop={1}>
            <Text weight="semibold">{`Held (${s.holds.length})`}</Text>
            {s.holds.length === 0 ? <Text dimColor>None. Take one with /einweave:take.</Text> : null}
            {s.holds.map(held => (
              <Box key={`held:${held.threadId}`} flexDirection="row" columnGap={1}>
                <Button key={`release:${held.threadId}`} label="Release" onPress={act('release', { ref: held.threadId })} />
                <Text wrap="truncate-end">{held.title ?? held.threadId}</Text>
              </Box>
            ))}
            {s.holds.length > 0 ? <Text dimColor>{'Hand one over: /einweave handover N <session>'}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}

