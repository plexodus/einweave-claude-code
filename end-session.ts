/**
 * A closed window holds nothing (plan 2026-11-26-closed-window-holds, S3a): when a conversation
 * leaves its window — the window exits (SessionEnd), or an in-window `/resume` switches it away —
 * its einweave session ENDS, and the server releases the threads it held. Same seat keeps its
 * threads (`/clear` carries them); no seat, no threads.
 *
 * Two callers, one rule:
 * - `hooks/session-end.ts`, the detached child the SessionEnd hook leaves behind (an exit);
 * - server.ts's re-key on an in-window `/resume` (the old conversation's key).
 *
 * The key is always named explicitly — the conversation that left — never "this client's own".
 * A key another window still uses is never ended: a second window on the same conversation
 * (standing by on its session lock, or holding it) keeps it, and the session ends after 24 h
 * idle once nobody uses it.
 */
import { join } from "path";
import { AgentClient, type Installation, type Runtime } from "./vendor/einweave-agent-sdk/index.js";
import { fileStore, readVersioned, sessionLock } from "./vendor/einweave-agent-sdk/node.js";
import { KNOWN_FORMAT } from "./vendor/einweave-agent-sdk/core/index.js";
import { listProcs, checkLive, newerProcOn } from "./proc-registry";
import { readPendingReplace, clearPendingReplace } from "./replace-store";
import { PLUGIN_CLIENT_ID } from "./auth/client-id";

/** This window: its Claude Code CLI pid, and (in the plugin itself) the key it is on now. */
export interface Here {
  claudePid: number | null;
  /** The plugin itself: the key this process serves NOW (a /resume back onto a key being ended keeps it). */
  current?: () => string;
}

/**
 * Why `key` must NOT be ended from `here`, or null when it may. Fails closed: anything it
 * cannot attribute to this window keeps the session (24 h idle ends it).
 */
export async function keepReason(stateDir: string, key: string, here: Here): Promise<string | null> {
  if (here.claudePid === null) return "this window's Claude Code process is unknown";
  if (here.current?.() === key) return "this window is on it again";
  // A newer plugin's record is not this build's to interpret: if it may be on the key, keep (fail closed).
  const newer = newerProcOn(stateDir, key);
  if (newer !== null) return `a newer einweave (pid ${newer}) may be on this conversation`;
  const procs = listProcs(stateDir);
  const ours = new Set<number>();
  for (const p of procs) {
    if (p.sessionKey !== key) continue;
    if (p.claudePid !== here.claudePid) return `another window's einweave (pid ${p.pid}) is on this conversation`;
    ours.add(p.pid);
  }
  const lock = sessionLock({ dir: stateDir, sessionKey: key, software: PLUGIN_CLIENT_ID, version: "0.0.0" });
  const holder = await lock.holder().catch(() => null);
  if (!holder || ours.has(holder.pid)) return null;
  // A record of a process that is gone (or a reused pid) holds nothing; an unverifiable one might.
  if (checkLive(holder.pid, holder) === "dead") return null;
  return `the session lock is held by pid ${holder.pid}, not this window`;
}

/** The profile's installation, as on disk now (null: none, unreadable, or a newer plugin's). */
function installationIn(profileDir: string): Installation | null {
  const v = readVersioned<Installation>(join(profileDir, "installation.json"), KNOWN_FORMAT);
  if (v.kind !== "ok") return null;
  return typeof v.data.apiUrl === "string" && typeof v.data.installationId === "string" ? v.data : null;
}

/**
 * End conversation `key`'s session (SDK `revokeSession`, scope `session`) -- and, when `key` is a
 * /clear's new conversation that never got to declare it (`replaces/<key>.json`: the window exited
 * or moved on before its first connect), the conversation it replaced, which still holds the
 * threads. Each only if `keepReason` finds nobody else on it, asked UNDER the installation lock:
 * every mint takes that lock, so no window that came back on the key mints between the check and
 * the revoke. A throwaway client: it mints nothing. Returns the outcome line(s); throws what the
 * SDK throws (the session then ends after 24 h idle).
 */
export async function endConversation(rt: Runtime, stateDir: string, profileDir: string, key: string, here: Here, version: string): Promise<string> {
  const inst = installationIn(profileDir);
  if (!inst) return "not_enrolled";
  const pending = readPendingReplace(stateDir, key);
  const client = await AgentClient.open(rt, { apiUrl: inst.apiUrl, store: fileStore(profileDir), softwareId: PLUGIN_CLIENT_ID, softwareVersion: version, sessionKey: key });
  try {
    const out: string[] = [];
    for (const k of pending ? [key, pending.from] : [key]) {
      let why: string | null = null;
      const r = await client.revokeSession(k, { keep: async () => (why = await keepReason(stateDir, k, here)) !== null });
      out.push(`${k === key ? "" : `replaced ${k} `}${r === "kept" ? `kept: ${why}` : r}`);
      // Ended: a later /resume of `key` must not declare it (it would carry from whoever is on it then).
      if (k !== key && r === "ended") clearPendingReplace(stateDir, key);
    }
    return out.join("; ");
  } finally {
    client.stop();
  }
}
