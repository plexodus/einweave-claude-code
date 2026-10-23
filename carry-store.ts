/**
 * RFC-028 §11 "Replaced conversation" — the two files behind `/clear`'s carry-or-release.
 *
 * - `carry/<key>.json` `{threads, at}`: the threads a person (or Claude, saying so) handed to
 *   "the next conversation in this window" (`handover to: next`, `/einweave:carry`) while
 *   conversation `<key>` ran. Read and deleted by the `/clear` that leaves `<key>`.
 * - `replaces/<key>.json` `{from, carry, at}`: what the NEW conversation `<key>` still has to
 *   declare on its first connect (`replaces: {sessionKey: from, reason: "clear", carry}`).
 *   Written by that `/clear`, deleted once a connect under `<key>` authenticated. A file, not
 *   memory: a window left disconnected declares it whenever it connects, a restart included.
 *
 * Both expire after 24 h (a window closed without a `/clear` leaves its carry behind; the next
 * write sweeps it). Every key is a session key (SESSION_KEY_REGEX), so it is a safe file name.
 * Format 0 (no `format` field), read through `format-guard.ts`: a file a NEWER plugin wrote is
 * never consumed or deleted here.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { readVersioned } from "./format-guard";

export const CARRY_TTL_MS = 24 * 60 * 60 * 1000;
/** The server takes at most 64 `carry` ids (RFC-028 §11). */
export const MAX_CARRY = 64;

const KEY = /^[a-zA-Z0-9_-]{1,64}$/;

interface CarryFile {
  threads: string[];
  at: string;
}
interface ReplaceFile {
  from: string;
  carry: string[];
  at: string;
}
export interface PendingReplace {
  from: string;
  carry: string[];
}

const carryPath = (dir: string, key: string) => join(dir, "carry", `${key}.json`);
const replacePath = (dir: string, key: string) => join(dir, "replaces", `${key}.json`);

function fresh(at: unknown, now: number): boolean {
  const t = Date.parse(String(at ?? ""));
  return Number.isFinite(t) && now - t < CARRY_TTL_MS;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

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

/** Expired files of one kind; a newer-format file is left alone like everywhere else. */
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
      if (now - statSync(path).mtimeMs < CARRY_TTL_MS) continue;
      if (name.endsWith(".tmp") || readVersioned(path).kind !== "newer") remove(path);
    } catch {}
  }
}

function readCarryFile(dir: string, key: string, now: number): { kind: "ok"; threads: string[] } | { kind: "none" | "newer" } {
  const r = readVersioned<CarryFile>(carryPath(dir, key));
  if (r.kind === "newer") return { kind: "newer" };
  if (r.kind !== "ok" || !fresh(r.data?.at, now)) return { kind: "none" };
  return { kind: "ok", threads: ids(r.data.threads) };
}

/** What conversation `key` has handed to the next one so far (expired = nothing). */
export function readCarry(dir: string, key: string, now = Date.now()): string[] {
  if (!KEY.test(key)) return [];
  const r = readCarryFile(dir, key, now);
  return r.kind === "ok" ? r.threads : [];
}

/**
 * Hand `threads` to the next conversation after `key`. Returns the whole list now carried and
 * the ids that did not fit under MAX_CARRY. Throws if the file cannot be written.
 */
export function addCarry(dir: string, key: string, threads: string[], now = Date.now()): { carried: string[]; dropped: string[] } {
  if (!KEY.test(key)) throw new Error(`not a session key: ${key}`);
  const sub = join(dir, "carry");
  mkdirSync(sub, { recursive: true, mode: 0o700 });
  sweep(sub, now);
  const cur = readCarryFile(dir, key, now);
  if (cur.kind === "newer") throw new Error("a newer einweave plugin owns this window's carry list; update this one (/plugin) to change it");
  const all = [...new Set([...(cur.kind === "ok" ? cur.threads : []), ...threads])];
  const carried = all.slice(0, MAX_CARRY);
  write(carryPath(dir, key), { threads: carried, at: new Date(now).toISOString() } satisfies CarryFile);
  return { carried, dropped: all.slice(MAX_CARRY) };
}

/** The `/clear` leaving `key`: its carry list, deleted (used once). */
export function takeCarry(dir: string, key: string, now = Date.now()): string[] {
  if (!KEY.test(key)) return [];
  const r = readCarryFile(dir, key, now);
  if (r.kind === "newer") return [];
  remove(carryPath(dir, key));
  return r.kind === "ok" ? r.threads : [];
}

/** What conversation `key` still has to declare, or null (none, expired, or a newer plugin's). */
export function readPendingReplace(dir: string, key: string, now = Date.now()): PendingReplace | null {
  if (!KEY.test(key)) return null;
  const r = readVersioned<ReplaceFile>(replacePath(dir, key));
  if (r.kind !== "ok" || !fresh(r.data?.at, now) || typeof r.data.from !== "string" || !KEY.test(r.data.from)) return null;
  return { from: r.data.from, carry: ids(r.data.carry).slice(0, MAX_CARRY) };
}

export function writePendingReplace(dir: string, key: string, p: PendingReplace, now = Date.now()): void {
  if (!KEY.test(key) || !KEY.test(p.from)) return;
  const sub = join(dir, "replaces");
  mkdirSync(sub, { recursive: true, mode: 0o700 });
  sweep(sub, now);
  write(replacePath(dir, key), { from: p.from, carry: p.carry.slice(0, MAX_CARRY), at: new Date(now).toISOString() } satisfies ReplaceFile);
}

/** Declared and answered: never again. A newer plugin's file stays. */
export function clearPendingReplace(dir: string, key: string): void {
  if (!KEY.test(key)) return;
  const path = replacePath(dir, key);
  if (readVersioned(path).kind !== "newer") remove(path);
}
