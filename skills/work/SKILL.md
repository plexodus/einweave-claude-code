---
name: work
description: Work Bridge work items (tasks, bugs, features, requests) — file, claim, report progress, finish. Use when the user says /einweave:work, asks what Bridge work is assigned to this agent, wants to file a bug/task/feature/request on Bridge, or when you are the assignee of a Bridge work item (a thread_event arrived, or read_thread shows `work`).
user-invocable: true
---

# /einweave:work — work items

A work item (`task`, `bug`, `feature`, `request`) is a Bridge thread with a status, one
assignee and structured activity. The server renders its header; `read_thread` shows it as
`work.text`.

Arguments passed: `$ARGUMENTS`

---

## With no argument

Call `list_items(assignee: "me")` and show the rows as they are (kind, status, title,
channel, attention). `list_items(status: "triage")` shows what waits for a channel owner.

## Rules

1. **`item_schema` once per session**, before you file or edit an item. It lists each kind's
   required `fields`, the statuses, the resolve reasons, the link types and the labels. Do not
   guess field names.
2. **File with `create_item`**, never with a plain `reply`. Pass the kind's required `fields`
   (a 422 `missing_fields` names the missing ones). **Read `similar`** in the result. If one is
   the same work, continue it there and say so. A near-identical bug is refused once with 409
   `similar_exists`: read the candidates. If one is the same failure, reopen it with
   `reopen_item(regression: true)` or reply into it. Only if none is the same, send again with
   `confirm_new: true`.
3. **Claiming is `update_item(thread_id, assignee: "me")`.** That makes this agent the item's
   assignee. It is not `take`: `take` only moves a thread's hold between this agent's own
   sessions. An agent usually claims, and takes only to move work between its sessions.
4. **Report with `add_activity`, not prose.** As the assignee:
   - a `plan` (items) when you start;
   - a `progress` (text) at least every ~15 minutes on long work — silence reads as stuck;
   - `needs_input` (text, `to`) when you are blocked on someone;
   - `failed` (text) when you cannot do it.
5. **End with a `result`**, never by resolving: `add_activity(type: "result", text, fix?,
   conclusion?, proposed: {reason})`. A person resolves it, or the channel's review policy
   does. `resolve_item` answers an agent 403 with the remedy — that remedy is the result.
6. An item you file as an agent with no assignee, yourself, or an agent you manage starts in
   **triage**: a channel owner accepts it (`triage_item`). That is expected, not an error.
7. Dates are calendar dates: `due` is `YYYY-MM-DD`. Fix and link URLs are `http(s)` only.

## Refusals

Every refusal names its `code` and the fix: `not_allowed` names the field, who may, and a
remedy; `missing_fields` names the fields; `status_changed` means someone moved it — read it
again before you retry. Act on the fix; do not retry the same call.
