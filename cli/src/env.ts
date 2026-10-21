import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LoadLocalEnvOptions {
  /** Directory to start the upward search from. Defaults to the current working directory. */
  startDir?: string;
  /** How many parent directories to search for `.env.local`. Defaults to 4. */
  maxParents?: number;
}

/**
 * Loads the nearest `.env.local` into `process.env` (existing variables win).
 *
 * The CLI entry point calls this so `agnes ...` works from inside this repo
 * without exporting the key in every shell. Set `AGNES_NO_DOTENV=1` to disable
 * it, or `AGNES_ENV_FILE=/path/to/file` to use an explicit file.
 *
 * This module is intentionally CLI-only; the JS API stays env/file-free.
 */
export function loadLocalEnv(options: LoadLocalEnvOptions = {}): string | undefined {
  if (process.env.AGNES_NO_DOTENV === "1") return undefined;

  const candidates = buildCandidatePaths(options);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      applyEnvFile(readFileSync(file, "utf8"));
    } catch {
      // An unreadable/invalid env file must not break CLI help or auth checks.
    }
    return file;
  }
  return undefined;
}

function buildCandidatePaths(options: LoadLocalEnvOptions): string[] {
  if (process.env.AGNES_ENV_FILE) {
    return [resolve(process.env.AGNES_ENV_FILE)];
  }

  const candidates: string[] = [];
  let dir = resolve(options.startDir ?? process.cwd());
  const maxParents = options.maxParents ?? 4;
  for (let depth = 0; depth <= maxParents; depth += 1) {
    candidates.push(resolve(dir, ".env.local"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function applyEnvFile(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // dotenv-style: never override variables that are already defined.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
