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

declare module 'claude-code' {
  interface PluginState {
    einweave: { view: Shaped<View> }
  }
}
