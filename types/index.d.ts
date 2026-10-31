/**
 * The einweave mod's `$.state` contract (mod/register.tsx). The snapshot is ui/ui-state.ts's UiState,
 * restated here because a mod's types may not import the plugin's Node code.
 */

export type UiConnection = 'connected' | 'superseded' | 'standby' | 'disconnected' | 'idle'

export interface UiHeld {
  threadId: string
  title: string | null
  /** A Load older read in flight: the top edge asks once. */
  loadingOlder?: boolean
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
  /** The agent's gateway (RFC-028); absent from an older plugin server, null until read. */
  gateway?: { online: boolean; label: string | null } | null
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

/** A tab View opened: a thread, or a channel's thread list. */
export interface OpenTab {
  kind: 'thread' | 'channel'
  id: string
  title: string
}

/** Which tab of the pane shows, and the tabs View opened (in open order). */
export interface PaneTabs {
  /** 'inbox' | 'held' | 'channels' | 'session', or an open tab's id. */
  tab: string
  open: OpenTab[]
}

/** One message as `ui_thread` returns it. */
export interface ThreadMessage {
  sender: string | null
  content: string
  type: string
  ts: string | null
  /** Its place in the channel, for Load older's cursor; absent from an older plugin. */
  seq?: number | null
  /** This agent sent it. */
  own?: boolean
  /** Above this agent's read position: not yet with Claude. */
  new?: boolean
  /** The thread's opening message. */
  root?: true
}

/** A thread tab's own window over its posts, once the person moved it; absent, the tab lands (first new post, else the newest). */
export interface ThreadScroll {
  /** Rows scrolled up from the newest post as it was then; 0 follows the newest. */
  off: number
  /** postKey of the newest post when `off` was set: rows that came after it keep the place. */
  newest: string
  /** Posts shown whole (by postKey), past the cap. */
  open: Record<string, true>
}

/** `ui_thread`'s answer for one thread tab, or why it is missing. */
export interface ThreadView {
  title: string | null
  status: string | null
  messages: ThreadMessage[]
  /** Replies older than those shown: 0 none, null some (uncounted). */
  older: number | null
  /** A Load older read in flight: the top edge asks once. */
  loadingOlder?: boolean
  error: string | null
  loading: boolean
  /** Local time of the last answer, for the tab's `Updated HH:MM`; absent until one came. */
  at?: number
}

/** Open threads in a channel and how many wait for this agent (`waiting` = unheld + parked). */
export interface ChannelCounts {
  open: number
  unheld: number
  parked: number
  oldestWaitingAt: string | null
}

/** One row of `ui_channels`: a channel this agent is in or follows. */
export interface ChannelRow {
  id: string
  name: string
  /** Membership; null = it follows the channel without being a member (it cannot post or take there). */
  role: 'owner' | 'member' | null
  following: boolean
  /** Absent when the server did not say: never shown as 0. */
  threads?: ChannelCounts
}

/** `ui_channels`' answer for the Channels tab, or why it is missing. */
export interface ChannelsView {
  agent: string | null
  channels: ChannelRow[]
  error: string | null
  loading: boolean
}

/** A session holding a thread, as a hold shows it. */
export interface HoldHolderView {
  id: string
  label: string | null
  online: boolean
  parked?: boolean
}

/** One thread of `ui_channel`. */
export interface ChannelThread {
  id: string
  title: string
  status: string | null
  kind: string | null
  lastActivityAt: string | null
  /** Absent from an older server. */
  hold?: { state: 'unheld' | 'parked' | 'held'; holder: HoldHolderView | null }
}

/** `ui_channel`'s answer for one channel tab, or why it is missing. Name and membership come from its Channels row. */
export interface ChannelView {
  threads: ChannelThread[]
  error: string | null
  loading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    einweave: {
      view: Shaped<View>
      tabs: Shaped<PaneTabs>
      threads: Shaped<Record<string, ThreadView>>
      channels: Shaped<ChannelsView>
      channel: Shaped<Record<string, ChannelView>>
      focused: Shaped<string>
      unfolded: Shaped<Record<string, boolean>>
      paneUp: Shaped<boolean>
      scrolls: Shaped<Record<string, ThreadScroll>>
    }
  }
}
