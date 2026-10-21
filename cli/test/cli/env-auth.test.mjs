import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "../../bin/agnes.js");

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_ENV_FILE"]) delete env[key];
  return env;
}

function run(cwd, args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: "utf8" });
}

test("auth check exits non-zero when the key is missing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnes-cli-auth-"));
  try {
    const result = run(cwd, ["auth", "check", "--json"], cleanEnv({ AGNES_NO_DOTENV: "1" }));
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, configured: false, source: "missing" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("auth check loads the nearest .env.local from the CLI", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agnes-cli-auth-"));
  try {
    writeFileSync(join(cwd, ".env.local"), "AGNES_API_KEY=sk-fake-local-key\n");
    const result = run(cwd, ["auth", "check", "--json"], cleanEnv());
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, configured: true, source: "env" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
