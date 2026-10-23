---
name: carry
description: Hand threads this session holds to the next conversation in this window, so /clear carries them instead of releasing them. Use when the user says /einweave:carry, or is about to /clear and wants the fresh conversation to keep working on a thread.
user-invocable: true
---

# /einweave:carry — keep threads across /clear

`/clear` releases every thread this conversation holds (replies then go to the agent's sessions in
scope until one takes them), except those handed to the next conversation first. This hands them.

Arguments passed: `$ARGUMENTS`

---

## What to do

Call the `handover` MCP tool with `to: "next"`:

- **No argument:** call it with no `ref`: it lists the threads this session holds, numbered. Ask
  which, then call again with that `ref` and `to: "next"`.
- **`all`:** `ref: "all"` carries every thread this session holds.
- **Anything else:** pass it as `ref`: a **number** from the list this session showed last, a
  **link** or **thread id**, or **words** from the title (one match acts; several are listed).

Say what the tool answered in one line.

## Notes

- Nothing moves now: this session keeps the threads until the `/clear`; the next conversation gets them then.
- Only threads this session holds can be carried; at most 64; the list expires after 24 h.
- `/einweave:handover` moves a thread to another running session instead.
