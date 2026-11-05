/**
 * The einweave mod's `$.state` contract (mod/register.tsx). The snapshot is ui/ui-state.ts's UiState,
 * restated here because a mod's types may not import the plugin's Node code.
 */

export type UiConnection = 'connected' | 'superseded' | 'standby' | 'disconnected' | 'idle'

export interface UiHeld {
  threadId: string
  title: string | null
  /** From the server's held list; null until read, absent from an older plugin server. */
  channel?: string | null
  /** The thread's last activity (ISO). */
  quietSince?: string | null
  /** Posts pushed to this window that its model has not confirmed. */
  unseenByModel?: number | null
  /** Who posted last: `@handle`, else the name. */
  lastBy?: string | null
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

/**
 * Another session of this agent, a Hand over target. The fields after `online` are absent from an older
 * plugin server: the picker then names it by `label` and shows no state.
 */
export interface UiSession {
  id: string
  label: string
  online: boolean
  /** Its own name (a rename); null = derived. */
  name?: string | null
  /** Where it works and on what branch; null = not reported. */
  folder?: string | null
  branch?: string | null
  /** What its model is doing and since when; null while offline or when its client reports none. */
  activity?: { state: 'working' | 'needs_you' | 'idle'; since: string } | null
  /** The first held thread the agent may read, by title, and how many it holds in all. */
  holds?: { title: string | null; count: number }
}

export interface UiSnapshot {
  v: 1
  connection: { state: UiConnection; detail: string | null }
  session: { agent: string | null; label: string | null; kind: string | null; scope: { mode: string; channelIds: string[]; channelNames?: (string | null)[] } | null }
  holds: UiHeld[]
  /** This agent's other sessions (Hand over targets), online first; null until read, absent from an older plugin server. */
  sessions?: UiSession[] | null
  waiting: { forYou: number | null; channel: number | null; more: boolean; top: UiWaitingItem[] } | null
  /** The agent's gateway (RFC-028); absent from an older plugin server, null until read. */
  gateway?: { online: boolean; label: string | null } | null
  version: string
  staleSince: string | null
  /** The pane's data socket (HTTP over a Unix socket); null or absent: read over MCP. */
  uiSocket?: string | null
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
  /**
   * The server's doc for it, ready to draw (RFC-034 D6): decided, URL-checked, cleaned and its mentions
   * resolved by the plugin (doc-view.ts). Absent or null: draw `content` as plain text, never parsed.
   */
  doc?: readonly unknown[] | null
  type: string
  ts: string | null
  /** Its place in the channel, for Load older's cursor; absent from an older plugin. */
  seq?: number | null
  /** The sending agent's or person's id: the pane's colour key; absent from an older plugin. */
  senderId?: string | null
  /** This agent sent it. */
  own?: boolean
  /** Above this agent's read position: not yet with Claude. */
  new?: boolean
  /** The thread's opening message. */
  root?: true
}

/** A thread tab's own window over its posts, once the person moved it; absent, the tab lands (first new post, else the newest). */
/** A tab's own window over its body, once the person moved it (every tab: the pane's one window, mod/model.ts). */
export interface PaneScroll {
  /** Rows scrolled up from the end of the body as it was then; 0 follows the end. */
  off: number
  /** Key of the body's last block when `off` was set: rows that came after it keep the place. */
  newest: string
  /** A thread's posts shown whole (by postKey), past the cap. */
  open: Record<string, true>
  /** A list scrolled to its top: it stays at the top as rows arrive. */
  top?: true
}

/** `ui_thread`'s answer for one thread tab, or why it is missing. */
/**
 * A work item's header as the thread tab draws it, from the server's model (RFC-029 D2): drawn live, never
 * copied into the root, which holds only what its author wrote and may be empty.
 */
export interface ThreadWork {
  kind: string
  status: string
  resolvedReason: string | null
  /** The assignee as einweave names it (`@handle`); null: none. */
  assignee: string | null
  /** The fields present, in the kind's order: the value as plain text, line breaks kept (never Markdown, as the web). */
  fields: { key: string; label: string; value: string }[]
  /** Labels of required fields still blank. */
  missing: string[]
}

export interface ThreadView {
  title: string | null
  /** Its channel's name, for the tab's header; null when the plugin could not name it. */
  channel?: string | null
  status: string | null
  messages: ThreadMessage[]
  /** A work item's header; absent for a conversation kind (and from an older plugin). */
  work?: ThreadWork | null
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
  /** When it was read (ms): the head's "Updated HH:MM". */
  at?: number
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
  /** When it was read (ms): the head's "Updated HH:MM". */
  at?: number
}

export type SearchHit = {
  thread_id: string
  title?: string | null
  thread_title?: string | null
  message_id?: string | null
  channel: string | null
  kind: string | null
  status: string | null
  sender?: string | null
  created_at?: string
  last_activity_at?: string
  matched_in?: string | null
  similar_title?: boolean
  matching_replies?: number
  snippet_parts: { text: string; hit: boolean }[]
}

export type SearchType = 'threads' | 'messages'
export type SearchSort = 'relevance' | 'newest'
export type SearchRefused = { code: string; token: string | null; suggestions: string[]; message: string }

/**
 * The Inbox search (RFC-031, board Search): what is typed, which answer is current, and what it said.
 * `seq` counts edits: an answer for an older `seq` is dropped, so a slow reply never draws over a newer
 * query. `rows` hold every page loaded for this query (More appends); `next` the server's cursor.
 */
export interface SearchState {
  q: string
  type: SearchType
  sort: SearchSort
  seq: number
  loading: boolean
  rows: SearchHit[]
  total: { count: number; capped: boolean } | null
  next: string | null
  refused: SearchRefused | null
  error: string | null
  /**
   * What the server did, from its echo: the sort it used, and whether the query had words. Filters
   * alone are listed newest first whatever was asked (there is nothing to rank), so the pane says
   * that and offers no Best first. Null before an answer.
   */
  applied: { sort: SearchSort; words: boolean } | null
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
      /** The held thread whose Hand over picker is open ('' when none), the tab it opened on, and the windows it lists (frozen while open). */
      handover: Shaped<{ id: string; on: string; sessions: UiSession[] | null }>
      scrolls: Shaped<Record<string, PaneScroll>>
      search: Shaped<SearchState>
    }
  }
}
