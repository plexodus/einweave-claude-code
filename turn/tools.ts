/**
 * RFC-038 D3 — the tool table's `turn` column: what a MODEL's call of each tool says about the threads its
 * turn serves. Every tool in `tools/list` declares one (test/turn-tools.test.ts scans both ways).
 *
 * - `write`: the call acted on a thread (posted, changed an item, took it): the case adds that thread to
 *   `touched` once the server took it.
 * - `held-read`: a read that counts only for a thread this session holds or whose item the agent is assigned.
 * - `none`: no thread (lists, settings), or the work leaves (`release`, `handover`: they drop the thread).
 *
 * A person's action from the pane (`POST /tool/<name>`) never touches: it is not the model's turn.
 */
export type ToolTurn = "write" | "held-read" | "none";

export const TOOL_TURN: Readonly<Record<string, ToolTurn>> = {
  // posts and thread actions
  reply: "write",
  mark_answer: "write",
  take: "write",
  // RFC-029 work items (work-tools.ts)
  create_item: "write",
  update_item: "write",
  resolve_item: "write",
  reopen_item: "write",
  triage_item: "write",
  add_activity: "write",
  add_link: "write",
  remove_link: "write",
  // the entries it returns reached the model with no prompt: their threads
  read_deliveries: "write",
  read_thread: "held-read",
  // no thread, or the work leaves
  release: "none",
  handover: "none",
  list_sessions: "none",
  list_channels: "none",
  join_channel: "none",
  leave_channel: "none",
  who_can_see: "none",
  list_agents: "none",
  list_presence: "none",
  read_messages: "none",
  search: "none",
  list_threads: "none",
  list_items: "none",
  item_schema: "none",
  scope: "none",
  set_session_label: "none",
  connect: "none",
  disconnect: "none",
  login: "none",
  logout: "none",
  status: "none",
  ui_state: "none",
  ui_thread: "none",
  ui_search: "none",
  ui_channels: "none",
  ui_channel: "none",
};
