#!/usr/bin/env bun
/**
 * The process the SessionEnd hook leaves behind when a window EXITS (plan
 * 2026-11-26-closed-window-holds, S3a): it ends that conversation's einweave session, so the
 * threads it held are released now instead of after 24 h idle.
 *
 * Why a detached process: Claude Code kills a SessionEnd hook, and every process it started,
 * about 1.4 s after the window closes (measured 2026-11-27, CC 2.1.332; the hook's own
 * `timeout` does not extend it). A hook that exits at once leaves a detached child running —
 * `/exit`, `claude -p`, a closed terminal tab alike. So the hook only spawns this and returns.
 *
 * `session-end.ts <conversation id> <Claude Code pid>`. With a pinned `EINWEAVE_SESSION_KEY` the plugin
 * never used the conversation id, so this ends nothing (the pinned session idles out after 24 h). Its stdio goes nowhere, so the outcome
 * is one line in `<state dir>/session-end.log` (capped), the only trace a person can look at.
 */
import { appendFileSync, statSync, renameSync } from "fs";
import { join } from "path";
import pkg from "../package.json" with { type: "json" };
import { createRuntime } from "../vendor/einweave-agent-sdk/index.js";
import { resolveStateDir } from "../state-dir";
import { resolveProfile } from "../auth/profile";
import { legacyEnvProblem } from "../legacy-env";
import { endConversation } from "../end-session";

// The server's SESSION_KEY_REGEX.
const SESSION_KEY = /^[a-zA-Z0-9_-]{1,64}$/;
// Past every budget the SDK's revoke has (its lock wait + hold): nothing is left to do then.
const HARD_STOP_MS = 60_000;
const LOG_MAX_BYTES = 64 * 1024;

const stateDir = resolveStateDir();

function record(key: string, outcome: string): void {
  const file = join(stateDir, "session-end.log");
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {}
  try {
    appendFileSync(file, `${new Date().toISOString()} ${key} ${outcome}\n`, { mode: 0o600 });
  } catch {}
}

async function main(key: string, pidArg: string): Promise<string> {
  const claudePid = /^[0-9]+$/.test(pidArg) ? Number(pidArg) : null;
  const legacy = legacyEnvProblem(process.env);
  if (legacy) return `kept: ${legacy}`;
  const profile = resolveProfile(stateDir, process.env.EINWEAVE_PROFILE);
  if ("error" in profile) return `kept: ${profile.error}`;
  return await endConversation(createRuntime(), stateDir, profile.dir, key, { claudePid }, pkg.version);
}

const [key = "", pidArg = ""] = process.argv.slice(2);
setTimeout(() => {
  record(key, "gave up: no answer in time (the session ends after 24 h idle)");
  process.exit(0);
}, HARD_STOP_MS);
if (!SESSION_KEY.test(key)) process.exit(0);
main(key, pidArg)
  .then((outcome) => record(key, outcome))
  .catch((err) => record(key, `failed: ${err instanceof Error ? err.message : String(err)} (the session ends after 24 h idle)`))
  .finally(() => process.exit(0));
