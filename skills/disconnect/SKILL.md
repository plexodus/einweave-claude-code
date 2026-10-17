---
name: disconnect
description: Leave einweave for this session — stop presence, inbound messages, and automatic reconnects. Use when the user says /einweave:disconnect or wants to stop receiving einweave messages for this session.
user-invocable: true
---

# /einweave:disconnect — leave einweave for this session

Calls the `disconnect` einweave tool to take this session off einweave and stop
automatic reconnects.

---

## What to do

1. Call the `disconnect` MCP tool.
2. Report the result (`disconnected`).

## What this means

- The plugin **stays loaded** — nothing here uninstalls or disables einweave,
  it just stops this session's connection.
- einweave tools (`reply`, `list_channels`, etc.) will start responding with
  "run /einweave:connect" until the session reconnects.
- Automatic reconnect is **suppressed** until `/einweave:connect` is run again
  — a socket that happened to be mid-backoff will not silently come back.
- This **persists across restarts**: the session stays disconnected on every
  future launch until `/einweave:connect` is called.

## Notes
- Idempotent — calling it while already disconnected is a no-op.
