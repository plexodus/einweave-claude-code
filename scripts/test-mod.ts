/**
 * `bun run test:mod` — the einweave mod's kit tests (`mod/*.test.tsx`, `claude plugin test`).
 *
 * WHY NOT `claude plugin test .`: the kit loads the plugin from the directory it is given and runs
 * EVERY `*.test.ts(x)` under it, so at the repo root it also tries the plugin's bun tests
 * (`test/`, which import `bun:test`) and fails each with "the file did not load". It cannot be
 * pointed at `mod/` either: it needs the `hooks/hooks.json` that names the module.
 *
 * So the kit gets a copy holding only what the mod is: the manifest, hooks.json, mod/ and types/.
 * A copy, not symlinks: the kit refuses a module whose real path leaves the plugin (path-traversal).
 *
 * Needs the `claude` CLI, so CI (which has none) does not run it: run it before pushing a mod change.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "einweave-mod-"));
try {
  for (const part of [".claude-plugin", "hooks/hooks.json", "mod", "types"]) cpSync(join(root, part), join(dir, part), { recursive: true });
  const run = Bun.spawnSync(["claude", "plugin", "test", dir], { stdout: "inherit", stderr: "inherit" });
  process.exitCode = run.exitCode ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
