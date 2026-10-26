/**
 * RFC-028 §11 "Replaced conversation" — the file behind `/clear` keeping this window's threads.
 *
 * `replaces/<key>.json` `{from, at}`: what the NEW conversation `<key>` still has to declare on
 * its first connect (`replaces: {sessionKey: from, reason: "clear", carry: "all"}`). Written by
 * the `/clear`, deleted once a connect under `<key>` authenticated. A file, not memory: a window
 * left disconnected declares it whenever it connects, a restart included.
 *
 * It expires after 24 h (the next write sweeps it). Every key is a session key
 * (SESSION_KEY_REGEX), so it is a safe file name. Format 0 (no `format` field), read through
 * `format-guard.ts`: a file a NEWER plugin wrote is never consumed or deleted here. A 0.34-0.36
 * file's `carry` list is ignored: everything is carried now.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readVersioned } from "./format-guard";

export const REPLACE_TTL_MS = 24 * 60 * 60 * 1000;

const KEY = /^[a-zA-Z0-9_-]{1,64}$/;

interface ReplaceFile {
  from: string;
  at: string;
}
export interface PendingReplace {
  from: string;
}

const replacePath = (dir: string, key: string) => join(dir, "replaces", `${key}.json`);

function fresh(at: unknown, now: number): boolean {
  const t = Date.parse(String(at ?? ""));
  return Number.isFinite(t) && now - t < REPLACE_TTL_MS;
}

function write(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** Expired files; a newer-format file is left alone like everywhere else. */
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
      if (now - statSync(path).mtimeMs < REPLACE_TTL_MS) continue;
      if (name.endsWith(".tmp") || readVersioned(path).kind !== "newer") remove(path);
    } catch {}
  }
}

/** What conversation `key` still has to declare, or null (none, expired, or a newer plugin's). */
export function readPendingReplace(dir: string, key: string, now = Date.now()): PendingReplace | null {
  if (!KEY.test(key)) return null;
  const r = readVersioned<ReplaceFile>(replacePath(dir, key));
  if (r.kind !== "ok" || !fresh(r.data?.at, now) || typeof r.data.from !== "string" || !KEY.test(r.data.from)) return null;
  return { from: r.data.from };
}

export function writePendingReplace(dir: string, key: string, p: PendingReplace, now = Date.now()): void {
  if (!KEY.test(key) || !KEY.test(p.from)) return;
  const sub = join(dir, "replaces");
  mkdirSync(sub, { recursive: true, mode: 0o700 });
  sweep(sub, now);
  write(replacePath(dir, key), { from: p.from, at: new Date(now).toISOString() } satisfies ReplaceFile);
}

/** Declared and answered: never again. A newer plugin's file stays. */
export function clearPendingReplace(dir: string, key: string): void {
  if (!KEY.test(key)) return;
  const path = replacePath(dir, key);
  if (readVersioned(path).kind !== "newer") remove(path);
}
