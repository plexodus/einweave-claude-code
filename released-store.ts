/**
 * Which ended sessions' releases this machine has already told a conversation about (plan
 * 2026-11-26-closed-window-holds, S3c). The server repeats `released` + `releasedFrom` on EVERY
 * auth of a session that follows an ended one, as long as nobody took the threads, so the note
 * goes once per `releasedFrom`: `told/<releasedFrom>.json` `{at}`.
 *
 * Format 0 (no `format` field), read through `format-guard.ts` like replace-store.ts: a file a
 * NEWER plugin wrote counts as told and is never swept here. Files expire after 30 days (the next
 * write sweeps them); a release still untaken by then is told once more.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readVersioned } from "./format-guard";

export const TOLD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

const toldPath = (dir: string, id: string) => join(dir, "told", `${id}.json`);

/** Whether the release from session `id` was told here already (an unusable id reads as told: nothing to key it on). */
export function wasTold(dir: string, id: string): boolean {
  if (!ID.test(id)) return true;
  return readVersioned(toldPath(dir, id)).kind !== "absent";
}

export function markTold(dir: string, id: string, now = Date.now()): void {
  if (!ID.test(id)) return;
  const sub = join(dir, "told");
  try {
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    sweep(sub, now);
    const path = toldPath(dir, id);
    const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: new Date(now).toISOString() }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {}
}

function sweep(sub: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(sub);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(sub, name);
    try {
      if (now - statSync(path).mtimeMs < TOLD_TTL_MS) continue;
      if (name.endsWith(".tmp") || readVersioned(path).kind !== "newer") unlinkSync(path);
    } catch {}
  }
}
