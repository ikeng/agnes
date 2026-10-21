import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AgnesCliError } from "../errors.js";

export interface SaveKeyOptions {
  shell?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SaveKeyResult {
  ok: true;
  rcFile: string;
  variable: "AGNES_API_KEY";
}

export function resolveRcFile(shellName: string | undefined, homeDir: string): string {
  if (shellName === "zsh") return join(homeDir, ".zshrc");
  if (shellName === "bash") return join(homeDir, ".bashrc");
  return join(homeDir, ".profile");
}

export async function saveKeyToShell(key: string, options: SaveKeyOptions = {}): Promise<SaveKeyResult> {
  if (!key || !key.trim()) {
    throw new AgnesCliError("INVALID_KEY", "Agnes API key is required.");
  }
  const env = options.env ?? process.env;
  const shellName = options.shell ?? (env.SHELL ? env.SHELL.split("/").pop() : undefined);
  const homeDir = options.homeDir ?? env.HOME;
  if (!homeDir) {
    throw new AgnesCliError("HOME_MISSING", "HOME is not available, so the shell rc file cannot be resolved.");
  }
  const rcFile = resolveRcFile(shellName, homeDir);
  let existing = "";
  try {
    existing = await fs.readFile(rcFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const filtered = existing
    .split("\n")
    .filter((line) => !line.startsWith("export AGNES_API_KEY="))
    .join("\n")
    .replace(/\n*$/, "\n");
  const escaped = shellEscape(key);
  const next = `${filtered}\nexport AGNES_API_KEY=${escaped}\n`;
  await fs.writeFile(rcFile, next, "utf8");
  process.env.AGNES_API_KEY = key;
  return { ok: true, rcFile, variable: "AGNES_API_KEY" };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
