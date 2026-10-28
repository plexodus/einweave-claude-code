#!/usr/bin/env bun
/**
 * The einweave mod's relay (plan 2026-10-25-terminal-ui.md, "push, not poll"). A mod cannot hear
 * an MCP server, but it can start a child for the session's life (`$.process.spawn`) and read
 * what it writes. This child opens the control socket's `watch` op and copies every line to
 * stdout: one UI snapshot per change (ctl-protocol.ts).
 *
 * The mod spawns it directly, so its parent is Claude Code and the socket is found the way the
 * hooks find it (`c<pid>.sock`, ctl-path.ts), CLAUDE_PID first where the host sets it.
 *
 * Exits 0 when the server closes the stream, 1 when there is no socket to watch (no session yet,
 * or another copy serves it), 2 when the socket directory is not ours alone. The mod starts it
 * again later. Exits too once its parent is gone, so it never outlives the session.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ctlSocketPath } from "../delivery/ctl-path";
import { checkPrivateDir } from "../delivery/private-dir";
import { resolveStateDir } from "../state-dir";

function claudePid(): number {
  const raw = (process.env.CLAUDE_PID ?? "").trim();
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : process.ppid;
}

const say = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");

const parent = process.ppid;
const path = ctlSocketPath(resolveStateDir(), claudePid());
if (!existsSync(dirname(path))) {
  say({ ok: false, error: "no control socket" });
  process.exit(1);
}
// What arrives is drawn on the person's screen: never read a socket in a directory that is not ours alone.
if (!checkPrivateDir(dirname(path)).ok) {
  say({ ok: false, error: "control socket directory is not private" });
  process.exit(2);
}

setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 2000);

try {
  await Bun.connect({
    unix: path,
    socket: {
      open(s) {
        s.write(JSON.stringify({ op: "watch" }) + "\n");
      },
      data(_s, chunk) {
        process.stdout.write(chunk);
      },
      close() {
        process.exit(0);
      },
      error() {
        process.exit(1);
      },
    },
  });
} catch {
  say({ ok: false, error: "no control socket" });
  process.exit(1);
}
