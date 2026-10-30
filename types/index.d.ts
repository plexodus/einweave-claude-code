/**
 * The einweave mod's `$.state` contract (mod/register.tsx). The snapshot is ui/ui-state.ts's UiState,
 * restated here because a mod's types may not import the plugin's Node code.
 */

export type UiConnection = 'connected' | 'superseded' | 'standby' | 'disconnected' | 'idle'

export interface UiHeld {
  threadId: string
  title: string | null
}

export interface UiWaitingItem {
  threadId: string
  title: string
  channel: string
  why: 'addressed' | 'participant' | 'channel'
  hold: 'unheld' | 'parked' | 'held'
  /** The thread's last activity (ISO); null from an older plugin server. */
  quietSince?: string | null
}

export interface UiSnapshot {
  v: 1
  connection: { state: UiConnection; detail: string | null }
  session: { agent: string | null; label: string | null; kind: string | null; scope: { mode: string; channelIds: string[]; channelNames?: (string | null)[] } | null }
  holds: UiHeld[]
  waiting: { forYou: number | null; channel: number | null; more: boolean; top: UiWaitingItem[] } | null
  version: string
  staleSince: string | null
}

/** What the mod draws from: the last snapshot and how it arrived. */
export interface View {
  rev: number
  snap: UiSnapshot | null
  /** The relay to the control socket's `watch` is running and has answered. */
  live: boolean
  /** Why neither the relay nor `ui_state` answered last time; null once one does. */
  error: string | null
  /** Local time the connection was first seen `disconnected`; the band waits 10 s from it. */
  downSince: number | null
}

/** Which tab of the pane shows, and the thread tabs View opened (in open order). */
export interface PaneTabs {
  /** 'inbox' | 'held' | 'session', or an open thread's id. */
  tab: string
  threads: { id: string; title: string }[]
}

/** One message as `ui_thread` returns it. */
export interface ThreadMessage {
  sender: string | null
  content: string
  type: string
  ts: string | null
}

/** `ui_thread`'s answer for one thread tab, or why it is missing. */
export interface ThreadView {
  title: string | null
  status: string | null
  messages: ThreadMessage[]
  /** Replies older than those shown: 0 none, null some (uncounted). */
  older: number | null
  error: string | null
  loading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    einweave: { view: Shaped<View>; tabs: Shaped<PaneTabs>; threads: Shaped<Record<string, ThreadView>> }
  }
}
