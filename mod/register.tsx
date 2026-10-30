/**
 * The einweave mod (plan 2026-10-25-terminal-ui.md, Phase 2): the hint-line indicator, a band while
 * the connection is lost, the pane (inbox, held threads, channels, session) and one command, `/einweave [verb]`.
 *
 * Data: this plugin's own MCP server is the single source. ui/ctl-watch.ts, started here for the
 * session's life, relays the control socket's `watch` stream (a snapshot per change); `ui_state`
 * answers the first draw, a re-read after /clear, and every minute while the relay is down.
 * Every action calls one of the plugin's tools: no model turn, no tokens.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChannelView, OpenTab, ThreadView, UiSnapshot } from '../types'
import {
  ago, applySnapshot, channelMeta, channelRows, channelsView, channelView, closeTab, EMPTY_TABS, EMPTY_VIEW, findInList, fromTool, holdBadge, inbox, indicator,
  needsBand, newSessionCommand, NO_CHANNELS, openTab, parseCommand, parseLine, scopeText, shownTab, statusSummary, takeOutcome, textOf, threadView, waitingIn,
  BAND_GRACE_MS, type InboxRow,
} from './model'

const SERVER = 'plugin:einweave:einweave'
const PANE = 'einweave'
const RELAY_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000]
const POLL_MS = 60_000
const SETTLE_MS = 10_000
const SETTLE_STEP_MS = 500

const view = atom({ plugin: 'einweave', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-1' })
const tabs = atom({ plugin: 'einweave', key: 'tabs' } as const, EMPTY_TABS, { shape: 'tabs-2' })
const threads = atom({ plugin: 'einweave', key: 'threads' } as const, {} as Record<string, ThreadView>, { shape: 'threads-1' })
const channels = atom({ plugin: 'einweave', key: 'channels' } as const, NO_CHANNELS, { shape: 'channels-1' })
const channel = atom({ plugin: 'einweave', key: 'channel' } as const, {} as Record<string, ChannelView>, { shape: 'channel-1' })
const NO_THREAD: ThreadView = { title: null, status: null, messages: [], older: 0, error: null, loading: true }
const NO_CHANNEL: ChannelView = { threads: [], error: null, loading: true }

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
    const r = await $.mcp.call(SERVER, 'ui_thread', { thread_id: id })
    got = r.isError ? { ...NO_THREAD, loading: false, error: textOf(r) || 'ui_thread failed' } : threadView(textOf(r))
  } catch (err) {
    got = { ...NO_THREAD, loading: false, error: String(err).slice(0, 200) }
  }
  // Closed (×) while it loaded: the tab is gone, so its content must not come back.
  if (!(await read($, tabs)).open.some(x => x.id === id)) return
  await update($, threads, m => ({ ...m, [id]: got }))
}

async function viewThread($: EngineInterface, id: string, title: string): Promise<void> {
  await update($, tabs, t => openTab(t, 'thread', id, title))
  await loadThread($, id)
}

/** Read the Channels tab with `ui_channels`: GET only, nothing marked. */
async function loadChannels($: EngineInterface): Promise<void> {
  await update($, channels, c => ({ ...c, loading: true }))
  let got
  try {
    const r = await $.mcp.call(SERVER, 'ui_channels', {})
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
    const r = await $.mcp.call(SERVER, 'ui_channel', { channel_id: id })
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
      case 'take':
        return { text: await takeThread($, action.ref) }
      case 'find': {
        const r = await $.mcp.call(SERVER, 'list_threads', { takeable: true, limit: 50 })
        return { text: r.isError ? textOf(r) || 'list_threads failed' : findInList(textOf(r), action.words) }
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
    const { Box, Text, Button, Markdown } = els
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
    const color = i.kind === 'connected' ? undefined : i.kind === 'disconnected' || i.kind === 'superseded' || i.kind === 'no-answer' ? 'red' : 'yellow'
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
    const tab = shownTab(t)
    const show = (to: string) => () => void update($, tabs, x => ({ ...x, tab: to }))
    // Channels and channel tabs load each time they are shown: nothing pushes them.
    const showChannels = () => void update($, tabs, x => ({ ...x, tab: 'channels' })).then(() => loadChannels($))
    const showOpen = (o: OpenTab) => () => void update($, tabs, x => ({ ...x, tab: o.id })).then(() => (o.kind === 'channel' ? loadChannel($, o.id) : undefined))
    const ch = await read($, channels)
    // Channels with something waiting; unknown counts count as none.
    const waitingChannels = ch.channels.filter(c => waitingIn(c.threads) > 0).length

    const row = (r: InboxRow) => (
      <Box key={`row:${r.threadId}`} flexDirection="column">
        {/* The title alone on its line: beside it a narrow pane broke the channel name mid-word (seen live). */}
        <Text weight="semibold" wrap="truncate-end">{r.title}</Text>
        <Text dimColor wrap="truncate-end">{[`#${r.channel}`, r.meta, r.quiet].filter(Boolean).join(' · ')}</Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key={`view:${r.threadId}`} label="View" onPress={() => void viewThread($, r.threadId, r.title)} />
          <Button key={`take:${r.threadId}`} label="Take" onPress={take(r.threadId)} />
          <Button
            key={`new:${r.threadId}`}
            label="New session"
            onPress={press => {
              const cmd = newSessionCommand(r.threadId)
              void $.ui.copy({ text: cmd, surface: press.surface }).then(c => $.ui.toast(c.isCopied ? `Copied: ${cmd} (paste it in a new terminal)` : `Not copied (${c.reason}): ${cmd}`))
            }}
          />
        </Box>
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Text color={color} weight="semibold">{i.text}</Text>
        {s && !connected && s.connection.detail ? <Text dimColor>{s.connection.detail}</Text> : null}
        {!s && v.error ? <Text dimColor>{v.error}</Text> : null}
        {s && !connected ? (
          i.kind === 'superseded' ? (
            <Button key="take-back" label="Take it back" onPress={() => void takeBack($).then(toastFirst($))} />
          ) : (
            <Button key="connect" label="Connect" onPress={() => void connect($).then(toastFirst($))} />
          )
        ) : null}
      </Box>
    )
    if (!s) return header

    const tabRow = (
      <Box flexDirection="row" columnGap={1} marginTop={1} flexWrap="wrap">
        <Button key="tab:inbox" label={`Inbox ${connected ? total : 0}`} variant={tab === 'inbox' ? 'primary' : undefined} onPress={show('inbox')} />
        <Button key="tab:held" label={`Held ${s.holds.length}`} variant={tab === 'held' ? 'primary' : undefined} onPress={show('held')} />
        <Button key="tab:channels" label={`Channels ${waitingChannels}`} variant={tab === 'channels' ? 'primary' : undefined} onPress={showChannels} />
        <Button key="tab:session" label="Session" variant={tab === 'session' ? 'primary' : undefined} onPress={show('session')} />
        {t.open.map(o => (
          <Box key={`tabbox:${o.id}`} flexDirection="row">
            <Button key={`tab:${o.id}`} label={o.title.length > 18 ? `${o.title.slice(0, 17)}…` : o.title} variant={tab === o.id ? 'primary' : undefined} onPress={showOpen(o)} />
            <Button
              key={`close:${o.id}`}
              label="×"
              plain
              onPress={() => {
                void update($, tabs, x => closeTab(x, o.id))
                if (o.kind === 'channel') void update($, channel, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id)))
                else void update($, threads, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== o.id)))
              }}
            />
          </Box>
        ))}
      </Box>
    )

    let body
    if (tab === 'inbox') {
      body = !connected ? (
        <Text dimColor>Not connected: what waits shows once this session is.</Text>
      ) : waiting === 0 ? (
        <Text dimColor>Nothing waits for this session.</Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {box.forYou.length ? <Text weight="semibold">For you</Text> : null}
          {box.forYou.map(row)}
          {box.open.length ? <Text weight="semibold">Open</Text> : null}
          {box.open.map(row)}
          {s.waiting?.more ? <Text dimColor>More wait than shown: /einweave take lists them all.</Text> : null}
        </Box>
      )
    } else if (tab === 'held') {
      body = !connected ? (
        <Text dimColor>Not connected.</Text>
      ) : (
        <Box flexDirection="column">
          {s.holds.length === 0 ? <Text dimColor>None. Take one from the Inbox.</Text> : null}
          {s.holds.map(held => (
            <Box key={`held:${held.threadId}`} flexDirection="row" columnGap={1}>
              <Button key={`release:${held.threadId}`} label="Release" onPress={act('release', { ref: held.threadId })} />
              <Button key={`view:${held.threadId}`} label="View" onPress={() => void viewThread($, held.threadId, held.title ?? held.threadId)} />
              <Text wrap="truncate-end">{held.title ?? held.threadId}</Text>
            </Box>
          ))}
          {s.holds.length > 0 ? <Text dimColor>{'Hand one over: /einweave handover N <session>'}</Text> : null}
        </Box>
      )
    } else if (tab === 'channels') {
      const who = ch.agent ? `@${ch.agent}` : 'This agent'
      body = (
        <Box flexDirection="column" rowGap={1}>
          {ch.error ? <Text color="red">{ch.error}</Text> : null}
          {ch.loading && !ch.channels.length ? <Text dimColor>Loading…</Text> : null}
          {!ch.loading && !ch.error && !ch.channels.length ? <Text dimColor>{`${who} isn't in any channels · set up in the web app`}</Text> : null}
          {ch.channels.map(c => (
            <Box key={`chan:${c.id}`} flexDirection="column">
              <Text weight="semibold" wrap="truncate-end">{`#${c.name}`}</Text>
              <Text dimColor wrap="truncate-end">{[channelMeta(c.threads, now), c.role ? null : 'not a member · join to take'].filter(Boolean).join(' · ')}</Text>
              <Box flexDirection="row" columnGap={1}>
                <Button key={`viewch:${c.id}`} label="View" onPress={() => void viewChannel($, c.id, c.name)} />
              </Box>
            </Box>
          ))}
          <Box flexDirection="row" columnGap={1}>
            <Button key="refresh:channels" label="Refresh" onPress={() => void loadChannels($)} />
          </Box>
        </Box>
      )
    } else if (tab === 'session') {
      body = (
        <Box flexDirection="column">
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
          <Text weight="semibold" wrap="truncate-end">{t.open.find(x => x.id === id)?.title ?? id}</Text>
          {row ? <Text dimColor wrap="truncate-end">{[channelMeta(row.threads, now), member ? null : 'not a member · join to take'].filter(Boolean).join(' · ')}</Text> : null}
          <Box flexDirection="row" columnGap={1}>
            <Button key={`refresh:${id}`} label="Refresh" onPress={() => void loadChannel($, id)} />
          </Box>
          {cv.error ? <Text color="red">{cv.error}</Text> : null}
          {cv.loading && !cv.threads.length ? <Text dimColor>Loading…</Text> : null}
          {!cv.loading && !cv.error && !cv.threads.length ? <Text dimColor>No threads yet.</Text> : null}
          {rows.map(th => {
            const here = s.holds.some(h => h.threadId === th.id)
            const badge = holdBadge(th.hold, here)
            const quiet = th.lastActivityAt && Number.isFinite(Date.parse(th.lastActivityAt)) ? `quiet ${ago(now - Date.parse(th.lastActivityAt))}` : null
            return (
              <Box key={`cth:${th.id}`} flexDirection="column" marginTop={1}>
                <Text weight="semibold" dimColor={th.resolved} wrap="truncate-end">{th.title || th.id}</Text>
                <Box flexDirection="row" columnGap={1}>
                  {badge ? <Text color={th.resolved ? undefined : badge.color} dimColor={th.resolved}>{badge.text}</Text> : null}
                  <Text dimColor wrap="truncate-end">{[th.resolved ? 'resolved' : th.status, th.kind, quiet].filter(Boolean).join(' · ')}</Text>
                </Box>
                <Box flexDirection="row" columnGap={1}>
                  <Button key={`view:${th.id}`} label="View" onPress={() => void viewThread($, th.id, th.title || th.id)} />
                  {here || !member || th.resolved ? null : <Button key={`take:${th.id}`} label="Take" onPress={take(th.id, () => loadChannel($, id))} />}
                </Box>
              </Box>
            )
          })}
          {more ? <Text dimColor>{`${more} more in the web app.`}</Text> : null}
          <Text dimColor>Read-only · no tokens · viewing marks nothing read.</Text>
        </Box>
      )
    } else {
      const id = tab
      const th = (await read($, threads))[id] ?? NO_THREAD
      const title = th.title ?? t.open.find(x => x.id === id)?.title ?? id
      const held = s.holds.some(h => h.threadId === id)
      body = (
        <Box flexDirection="column">
          <Text weight="semibold" wrap="truncate-end">{title}</Text>
          <Text color={held ? 'cyan' : 'yellow'}>{held ? 'held by this session · replies come here' : 'not held here: Claude has not seen it · Take brings it here'}</Text>
          <Box flexDirection="row" columnGap={1}>
            {held ? null : <Button key={`take:${id}`} label="Take" onPress={take(id)} />}
            <Button key={`refresh:${id}`} label="Refresh" onPress={() => void loadThread($, id)} />
          </Box>
          {th.error ? <Text color="red">{th.error}</Text> : null}
          {th.loading && !th.messages.length ? <Text dimColor>Loading…</Text> : null}
          {th.messages.map((m, n) => (
            <Box key={`msg:${id}:${n}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text weight="semibold">{m.sender ?? '?'}</Text>
                {m.ts ? <Text dimColor>{timeOf(m.ts)}</Text> : null}
                {m.type !== 'text' ? <Text color="yellow">{m.type}</Text> : null}
              </Box>
              <Markdown key={`md:${id}:${n}`} text={m.content} />
            </Box>
          ))}
          {th.older !== 0 ? <Text dimColor>{`${th.older ?? 'Some'} older ${th.older === 1 ? 'reply' : 'replies'} not shown: the web app has them.`}</Text> : null}
          <Text dimColor>Read-only · no tokens · viewing does not mark it read.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {tabRow}
        <Box flexDirection="column" marginTop={1}>
          {body}
        </Box>
      </Box>
    )
  })
}

/** A message's local time, `HH:MM`, or its date when not today. */
function timeOf(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toISOString().slice(0, 10)} ${hm}`
}
