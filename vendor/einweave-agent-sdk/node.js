import {
  KNOWN_FORMAT,
  classifyVersioned,
  deadline,
  decideLock,
  isJoinState,
  isP256PrivateJwk,
  joinStateSeq,
  randomB64url
} from "./index-kwqgqdrq.js";

// src/node/store.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/node/format-guard.ts
import { readFileSync } from "node:fs";
function readVersioned(path, knownMax = KNOWN_FORMAT) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "absent" };
  }
  return classifyVersioned(parsed, knownMax);
}

// src/node/fs-atomic.ts
import * as fs from "node:fs";
import { dirname } from "node:path";
var __fsIo = {
  openSync: fs.openSync,
  writeSync: fs.writeSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync
};
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeAllAndSync(fd, content) {
  const buf = Buffer.from(content, "utf8");
  let off = 0;
  while (off < buf.length)
    off += __fsIo.writeSync(fd, buf, off, buf.length - off);
  __fsIo.fsyncSync(fd);
}
function fsyncDir(dir) {
  let fd;
  try {
    fd = __fsIo.openSync(dir, "r");
  } catch {
    return;
  }
  try {
    __fsIo.fsyncSync(fd);
  } catch (e) {
    const code = e?.code;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP")
      throw e;
  } finally {
    __fsIo.closeSync(fd);
  }
}
var RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
function renameWithRetry(from, to) {
  for (let delay = 10;; delay *= 2) {
    try {
      __fsIo.renameSync(from, to);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(e?.code ?? "") || delay > 640)
        throw e;
      sleepSync(delay);
    }
  }
}
function removeQuiet(path) {
  try {
    fs.unlinkSync(path);
  } catch {}
}
function writeAtomic(path, content, opts = {}) {
  const dir = dirname(path);
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomB64url(4)}.tmp`;
  const fd = __fsIo.openSync(tmp, "wx", 384);
  try {
    try {
      if (opts.durable)
        writeAllAndSync(fd, content);
      else
        fs.writeSync(fd, content);
    } finally {
      __fsIo.closeSync(fd);
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    removeQuiet(tmp);
    throw e;
  }
  if (opts.durable)
    fsyncDir(dir);
}

// src/node/lock.ts
import * as fs2 from "node:fs";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { join } from "node:path";
var LOCK_DIR_NAME = ".install-lock";
var STALE_MS = 120000;
var HOLD_BUDGET_MS = 90000;
var LOCK_WAIT_MS = 150000;
var BREAK_STALE_MS = 1e4;
var RETRY_MS = 100;
var TRANSIENT_FS = new Set(["ENOENT", "ENOTEMPTY", "EPERM", "EBUSY"]);
var __lockIo = {
  rmSync: fs2.rmSync,
  renameSync: fs2.renameSync,
  writeFileSync: fs2.writeFileSync
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var codeOf = (e) => e?.code ?? "";
function ageMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
function readOwner(lockDir) {
  try {
    return JSON.parse(readFileSync2(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}
function isStale(lockDir) {
  const age = ageMs(lockDir);
  return age !== null && age > STALE_MS;
}
function breakIfStale(lockDir) {
  const breakDir = `${lockDir}.break`;
  try {
    mkdirSync2(breakDir, { mode: 448 });
  } catch (err) {
    if (codeOf(err) !== "EEXIST")
      throw err;
    const age = ageMs(breakDir);
    if (age !== null && age > BREAK_STALE_MS)
      __lockIo.rmSync(breakDir, { recursive: true, force: true });
    return;
  }
  try {
    if (isStale(lockDir))
      __lockIo.rmSync(lockDir, { recursive: true, force: true });
  } finally {
    __lockIo.rmSync(breakDir, { recursive: true, force: true });
  }
}
async function withFsRetry(op) {
  for (let i = 0;; i++) {
    try {
      op();
      return;
    } catch (e) {
      if (!TRANSIENT_FS.has(codeOf(e)) || i >= 5)
        throw e;
      await sleep(50);
    }
  }
}
async function release(lockDir, nonce) {
  if (readOwner(lockDir)?.nonce !== nonce)
    return;
  const tomb = `${lockDir}.released-${nonce}`;
  try {
    await withFsRetry(() => __lockIo.renameSync(lockDir, tomb));
  } catch (e) {
    if (codeOf(e) === "ENOENT")
      return;
    throw e;
  }
  if (readOwner(tomb)?.nonce !== nonce) {
    try {
      __lockIo.renameSync(tomb, lockDir);
    } catch {}
    return;
  }
  await withFsRetry(() => __lockIo.rmSync(tomb, { recursive: true, force: true }));
}
var TOMBSTONE = new RegExp(`^${LOCK_DIR_NAME.replace(".", "\\.")}\\.released-[0-9a-f-]+$`);
function sweepLockTombstones(profileDir) {
  let n = 0;
  let entries;
  try {
    entries = fs2.readdirSync(profileDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!TOMBSTONE.test(name))
      continue;
    const p = join(profileDir, name);
    const age = ageMs(p);
    if (age === null || age <= STALE_MS)
      continue;
    try {
      __lockIo.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}
async function withInstallationLock(profileDir, fn, o = {}) {
  const waitMs = o.waitMs ?? LOCK_WAIT_MS;
  const holdMs = o.holdMs ?? HOLD_BUDGET_MS;
  if (!(holdMs > 0 && holdMs < STALE_MS))
    throw new RangeError(`installation lock holdMs must be in (0, ${STALE_MS}), got ${holdMs}`);
  mkdirSync2(profileDir, { recursive: true, mode: 448 });
  const lockDir = join(profileDir, LOCK_DIR_NAME);
  const nonce = crypto.randomUUID();
  const waitDeadline = Date.now() + waitMs;
  for (;; ) {
    o.signal?.throwIfAborted();
    let created = false;
    try {
      mkdirSync2(lockDir, { mode: 448 });
      created = true;
      __lockIo.writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 384 });
      break;
    } catch (err) {
      if (created) {
        if (codeOf(err) === "ENOENT")
          continue;
        try {
          __lockIo.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        throw err;
      }
      if (codeOf(err) !== "EEXIST")
        throw err;
    }
    try {
      if (isStale(lockDir))
        breakIfStale(lockDir);
    } catch (err) {
      if (!TRANSIENT_FS.has(codeOf(err)))
        throw err;
    }
    if (Date.now() > waitDeadline)
      throw new Error(`einweave: installation lock ${lockDir} held for over ${waitMs / 1000}s`);
    await sleep(RETRY_MS);
  }
  const hold = deadline(holdMs);
  try {
    return await fn({ signal: hold.signal });
  } finally {
    hold.clear();
    try {
      await release(lockDir, nonce);
    } catch (e) {
      (o.log ?? ((m) => console.error(m)))(`einweave: could not release installation lock ${lockDir}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// src/node/store.ts
var installationFile = (dir) => join2(dir, "installation.json");
var keyFile = (dir) => join2(dir, "key.json");
var stateFile = (dir) => join2(dir, "state");
var attemptFile = (dir) => join2(dir, "attempt");
function readText(path) {
  try {
    return readFileSync3(path, "utf8");
  } catch {
    return null;
  }
}
function readInstallation(dir) {
  const v = readVersioned(installationFile(dir), KNOWN_FORMAT);
  if (v.kind !== "ok")
    return null;
  const c = v.data;
  return typeof c.apiUrl === "string" && typeof c.installationId === "string" && typeof c.jkt === "string" ? c : null;
}
function isNewerInstallation(dir) {
  return readVersioned(installationFile(dir), KNOWN_FORMAT).kind === "newer";
}
function readKey(dir) {
  const raw = readText(keyFile(dir));
  if (raw === null)
    return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  return isP256PrivateJwk(j) ? { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d } : null;
}
function readState(dir) {
  const t = readText(stateFile(dir))?.trim() ?? null;
  return t !== null && isJoinState(t) ? t : null;
}
function fileStore(dir) {
  return {
    async read() {
      const installation = readInstallation(dir);
      if (!installation)
        return null;
      const privateJwk = readKey(dir);
      const joinState = readState(dir);
      if (!privateJwk || joinState === null)
        return null;
      return { installation, privateJwk, joinState };
    },
    async write(record) {
      if (!isJoinState(record.joinState))
        throw new Error("refusing to write a malformed join state");
      if (isNewerInstallation(dir))
        throw new Error("refusing to write over a newer installation (RFC-017 D8)");
      removeQuiet(installationFile(dir));
      writeAtomic(keyFile(dir), JSON.stringify({ kty: record.privateJwk.kty, crv: record.privateJwk.crv, x: record.privateJwk.x, y: record.privateJwk.y, d: record.privateJwk.d }) + `
`, { durable: true });
      writeAtomic(stateFile(dir), record.joinState + `
`, { durable: true });
      const inst = record.installation;
      const out = {
        format: KNOWN_FORMAT,
        apiUrl: inst.apiUrl,
        installationId: inst.installationId,
        ...inst.installationName !== undefined ? { installationName: inst.installationName } : {},
        jkt: inst.jkt,
        keyStorage: inst.keyStorage,
        ...inst.agent ? { agent: inst.agent } : {},
        ...inst.workspace ? { workspace: inst.workspace } : {}
      };
      writeAtomic(installationFile(dir), JSON.stringify(out, null, 2) + `
`, { durable: true });
    },
    async writeJoinState(joinState) {
      const next = joinStateSeq(joinState);
      if (!isJoinState(joinState) || next === null)
        throw new Error("refusing to write a malformed join state");
      const cur = readState(dir);
      const curSeq = cur === null ? null : joinStateSeq(cur);
      if (curSeq !== null && curSeq > next)
        return false;
      writeAtomic(stateFile(dir), joinState + `
`, { durable: true });
      return true;
    },
    async clear() {
      if (isNewerInstallation(dir))
        return;
      removeQuiet(installationFile(dir));
      removeQuiet(keyFile(dir));
      removeQuiet(stateFile(dir));
      removeQuiet(attemptFile(dir));
      sweepOrphanTemps(dir, 0);
      try {
        fsyncDir(dir);
      } catch {}
    },
    async isNewer() {
      return isNewerInstallation(dir);
    },
    async readAttempt() {
      const t = readText(attemptFile(dir))?.trim() ?? "";
      return ATTEMPT.test(t) ? t : null;
    },
    async createAttempt(candidate) {
      return createOrReadAttempt(dir, candidate);
    },
    async clearAttempt() {
      removeQuiet(attemptFile(dir));
    },
    withLock(fn, opts) {
      return withInstallationLock(dir, ({ signal }) => fn(signal), opts?.budgetMs !== undefined ? { holdMs: opts.budgetMs } : {});
    }
  };
}
var ATTEMPT = /^[A-Za-z0-9_-]{22,128}$/;
async function createOrReadAttempt(dir, candidate) {
  mkdirSync3(dir, { recursive: true, mode: 448 });
  const path = attemptFile(dir);
  for (let i = 0;; i++) {
    let fd = null;
    try {
      fd = __fsIo.openSync(path, "wx", 384);
    } catch (e) {
      if (e?.code !== "EEXIST")
        throw e;
    }
    if (fd !== null) {
      try {
        writeAllAndSync(fd, candidate + `
`);
      } finally {
        __fsIo.closeSync(fd);
      }
      fsyncDir(dir);
      return candidate;
    }
    let existing;
    try {
      existing = readFileSync3(path, "utf8").trim();
    } catch (e) {
      if (e?.code === "ENOENT")
        continue;
      throw e;
    }
    if (ATTEMPT.test(existing)) {
      try {
        const rfd = __fsIo.openSync(path, "r");
        try {
          __fsIo.fsyncSync(rfd);
        } finally {
          __fsIo.closeSync(rfd);
        }
      } catch (e) {
        if (e?.code === "ENOENT")
          continue;
        throw e;
      }
      fsyncDir(dir);
      return existing;
    }
    if (i >= 20) {
      removeQuiet(path);
      continue;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
var GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
function fileSeqStore(dir) {
  return {
    async load(grantId) {
      if (!GRANT_ID.test(grantId))
        return null;
      const n = Number((readText(join2(dir, grantId)) ?? "").trim());
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    },
    async save(grantId, seq) {
      if (!GRANT_ID.test(grantId) || !Number.isSafeInteger(seq) || seq < 0)
        return;
      writeAtomic(join2(dir, grantId), `${seq}
`);
    }
  };
}
function sweepOrphanTemps(dir, minAgeMs = 60000) {
  const OWN_TMP = /^(key\.json|state|installation\.json|attempt)\.\d+\.\d+\.[A-Za-z0-9_-]+\.tmp$/;
  let n = 0;
  let names;
  try {
    names = readdirSync2(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - minAgeMs;
  for (const name of names) {
    if (!OWN_TMP.test(name))
      continue;
    const p = join2(dir, name);
    try {
      if (minAgeMs > 0 && statSync2(p).mtimeMs > cutoff)
        continue;
      unlinkSync2(p);
      n++;
    } catch {}
  }
  return n;
}
// src/node/session-lock.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync2, renameSync as renameSync3, unlinkSync as unlinkSync3, statSync as statSync3 } from "node:fs";
import { join as join3 } from "node:path";

// src/node/proc-start.ts
import { execFile } from "node:child_process";
var __psExec = {
  run(pid, env) {
    return new Promise((resolve) => {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env }, (err, stdout) => {
        resolve(err ? "" : String(stdout).trim());
      });
    });
  }
};
function procStartOf(pid) {
  return __psExec.run(pid, { ...process.env, TZ: "UTC", LC_ALL: "C" });
}
function legacyProcStartOf(pid) {
  return __psExec.run(pid, process.env);
}
async function procStartMatches(pid, recorded) {
  if (!recorded)
    return false;
  const [norm, legacy] = await Promise.all([procStartOf(pid), legacyProcStartOf(pid)]);
  return recorded === norm || recorded === legacy;
}
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// src/node/session-lock.ts
var LOCK_RECORD_FORMAT = 0;
function sessionLock(opts) {
  const lockDir = join3(opts.dir, "locks");
  const lockFile = join3(lockDir, `${opts.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
  const retryMs = opts.retryMs ?? 30000;
  const staleMs = opts.staleMs ?? 5 * 60000;
  const startedAt = new Date().toISOString();
  let held = false;
  let lost = false;
  let renewTimer = null;
  const listeners = new Set;
  let myProcStartPromise = null;
  function myProcStart() {
    if (!myProcStartPromise)
      myProcStartPromise = procStartOf(process.pid);
    return myProcStartPromise;
  }
  function stopRenewal() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }
  function loseIt() {
    held = false;
    lost = true;
    stopRenewal();
    for (const cb of [...listeners])
      cb();
  }
  function readLockRecord() {
    try {
      return JSON.parse(readFileSync4(lockFile, "utf8"));
    } catch {
      return null;
    }
  }
  function readLockRecordForAcquire() {
    const rec = readLockRecord();
    if (rec !== null)
      return rec;
    sleepSync(20);
    return readLockRecord();
  }
  async function holderLiveness(rec) {
    if (!pidAlive(rec.pid))
      return "dead";
    if (!rec.procStart)
      return "unverifiable";
    if (!await procStartMatches(rec.pid, rec.procStart)) {
      await new Promise((r) => setTimeout(r, 20));
      if (!await procStartMatches(rec.pid, rec.procStart))
        return "dead";
    }
    try {
      if (Date.now() - statSync3(lockFile).mtimeMs > staleMs)
        return "dead";
    } catch {}
    return "live";
  }
  async function holderIsLive(rec) {
    const v = await holderLiveness(rec);
    if (v === "unverifiable") {
      opts.log?.(`einweave: session lock ${lockFile} names pid ${rec.pid} but its start time could not be verified (ps unavailable?) — treating it as live, never stealing it`);
    }
    return v !== "dead";
  }
  function buildRecord(procStart) {
    const id = opts.identity ?? {};
    return {
      format: LOCK_RECORD_FORMAT,
      pid: process.pid,
      procStart,
      sessionKey: opts.sessionKey,
      at: new Date().toISOString(),
      software: opts.software,
      version: opts.version,
      tty: id.tty ?? "",
      termProgram: id.termProgram ?? "",
      cwd: id.cwd ?? "",
      startedAt
    };
  }
  function writeLockExclusive(procStart) {
    try {
      writeFileSync2(lockFile, JSON.stringify(buildRecord(procStart)), { flag: "wx", mode: 384 });
      return true;
    } catch {
      return false;
    }
  }
  function writeLockTakeover(procStart) {
    try {
      const tmp = `${lockFile}.${process.pid}.tmp`;
      writeFileSync2(tmp, JSON.stringify(buildRecord(procStart)), { mode: 384 });
      renameSync3(tmp, lockFile);
    } catch {}
  }
  function armRenewal() {
    if (renewTimer)
      return;
    renewTimer = setInterval(() => {
      renewTick();
    }, retryMs);
    renewTimer.unref?.();
  }
  async function renewTick() {
    try {
      const current = readLockRecord();
      if (current === null)
        return;
      if (current.pid !== process.pid) {
        stopRenewal();
        held = false;
        if (await holderIsLive(current)) {
          loseIt();
          return;
        }
        await acquire();
        return;
      }
      const tmp = `${lockFile}.${process.pid}.tmp`;
      writeFileSync2(tmp, JSON.stringify({ ...current, at: new Date().toISOString() }), { mode: 384 });
      renameSync3(tmp, lockFile);
    } catch {}
  }
  const sameHolder = (a, b) => !!a && !!b && a.pid === b.pid && a.procStart === b.procStart && a.version === b.version;
  async function acquire(acquireOpts = {}, recheck = 2) {
    if (lost)
      return "lost";
    const procStart = await myProcStart();
    try {
      mkdirSync4(lockDir, { recursive: true, mode: 448 });
      let outcome = "acquire";
      if (!writeLockExclusive(procStart)) {
        const rec = readLockRecordForAcquire();
        if (rec && rec.pid === process.pid && rec.procStart === procStart) {
          held = true;
          armRenewal();
          return "acquire";
        }
        if (rec && await holderIsLive(rec)) {
          if (!sameHolder(readLockRecordForAcquire(), rec))
            return recheck > 0 ? acquire(acquireOpts, recheck - 1) : "standby";
          if (held) {
            loseIt();
            return "lost";
          }
          const decision = decideLock({ version: rec.version }, { version: opts.version }, acquireOpts);
          if (decision === "standby") {
            stopRenewal();
            held = false;
            return "standby";
          }
          outcome = "takeover";
          writeLockTakeover(procStart);
        } else {
          try {
            unlinkSync3(lockFile);
          } catch {}
          if (!writeLockExclusive(procStart))
            return "standby";
        }
      }
      const back = readLockRecord();
      if (back && back.pid !== process.pid)
        return "standby";
      held = true;
      armRenewal();
      return outcome;
    } catch {
      return "acquire";
    }
  }
  function release2() {
    stopRenewal();
    if (!held)
      return;
    held = false;
    try {
      const rec = readLockRecord();
      if (rec && rec.pid === process.pid)
        unlinkSync3(lockFile);
    } catch {}
  }
  return {
    acquire,
    release: release2,
    async holder() {
      return readLockRecord();
    },
    async isHeld() {
      if (!held)
        return false;
      const rec = readLockRecord();
      if (rec === null)
        return true;
      if (rec.pid === process.pid)
        return true;
      if (await holderIsLive(rec)) {
        loseIt();
        return false;
      }
      return true;
    },
    onLost(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    markLost() {
      if (lost)
        return;
      const wasHeld = held;
      lost = true;
      held = false;
      stopRenewal();
      if (wasHeld)
        for (const cb of [...listeners])
          cb();
    }
  };
}
// src/node/hostname.ts
import { hostname as osHostname } from "node:os";
function hostname() {
  return osHostname();
}
export {
  HOLD_BUDGET_MS,
  LOCK_DIR_NAME,
  LOCK_WAIT_MS,
  STALE_MS,
  fileSeqStore,
  fileStore,
  hostname,
  legacyProcStartOf,
  pidAlive,
  procStartMatches,
  procStartOf,
  readVersioned,
  sessionLock,
  sweepLockTombstones,
  sweepOrphanTemps,
  withInstallationLock
};
