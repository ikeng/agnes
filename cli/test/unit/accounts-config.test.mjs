import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accountsSummary,
  loadAccountsConfig,
} from "../../dist/accounts/config.js";
import { AccountRouter } from "../../dist/accounts/router.js";
import { resolveConfig } from "../../dist/config.js";
import { createAgnesClient } from "../../dist/index.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agnes-accounts-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function accountsFile(t, document, mode = 0o600) {
  const dir = tempDir(t);
  const file = join(dir, "accounts.json");
  writeFileSync(file, JSON.stringify(document), { mode });
  chmodSync(file, mode);
  return file;
}

function assertInvalidConfig(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, "INVALID_ACCOUNTS_CONFIG");
    assert.equal(error.exitCode, 2);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/* -------------------------------- AC2: legacy -------------------------------- */

test("AGNES_API_KEY still resolves one implicit legacy account", () => {
  const config = loadAccountsConfig({ AGNES_API_KEY: "sk-test-legacy" });
  assert.equal(config.source, "legacy");
  assert.deepEqual(config.accounts, [
    {
      id: "default",
      key: "sk-test-legacy",
      keySource: "AGNES_API_KEY",
      type: "free",
      poolId: "default",
      weight: 1,
      priority: 0,
    },
  ]);
  assert.deepEqual(config.pools, ["default"]);
  assert.equal(config.strategy, "primary");
  assert.equal(config.rateLimitEnabled, true);
});

test("no credentials resolves an empty env config", () => {
  const config = loadAccountsConfig({});
  assert.deepEqual(config.accounts, []);
  assert.equal(config.source, "env");
  assert.equal(config.strategy, "adaptive");
});

/* ------------------------------ AC2: indexed env ----------------------------- */

function indexedEnv(extra = {}) {
  return {
    AGNES_ACCOUNTS: "MAIN,backup",
    AGNES_ACCOUNT_MAIN_KEY: "sk-test-main",
    AGNES_ACCOUNT_MAIN_TYPE: "free",
    AGNES_ACCOUNT_MAIN_POOL: "acct-main",
    AGNES_ACCOUNT_MAIN_WEIGHT: "1",
    AGNES_ACCOUNT_MAIN_PRIORITY: "0",
    AGNES_ACCOUNT_MAIN_MODELS: "agnes-image-2.5-flash,agnes-video-2.5",
    AGNES_ACCOUNT_MAIN_BASE_URL: "http://127.0.0.1:9/v1",
    AGNES_ACCOUNT_MAIN_LABEL: "Main free account",
    AGNES_ACCOUNT_BACKUP_KEY: "sk-test-backup",
    AGNES_ACCOUNT_BACKUP_TYPE: "tokenplan",
    AGNES_ACCOUNT_BACKUP_POOL: "acct-backup",
    AGNES_ACCOUNT_BACKUP_WEIGHT: "2",
    AGNES_ACCOUNT_BACKUP_PRIORITY: "-1",
    AGNES_ACCOUNT_BACKUP_CONCURRENCY: "3",
    ...extra,
  };
}

test("indexed AGNES_ACCOUNT_* env resolves ordered accounts with pools", () => {
  const config = loadAccountsConfig(indexedEnv());
  assert.equal(config.source, "env");
  assert.deepEqual(config.accounts.map((account) => account.id), ["main", "backup"]);
  assert.deepEqual(config.pools, ["acct-main", "acct-backup"]);
  assert.equal(config.strategy, "adaptive");

  const [main, backup] = config.accounts;
  assert.equal(main.keySource, "AGNES_ACCOUNT_MAIN_KEY");
  assert.equal(main.type, "free");
  assert.equal(main.poolId, "acct-main");
  assert.deepEqual(main.models, ["agnes-image-2.5-flash", "agnes-video-2.5"]);
  assert.equal(main.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(main.label, "Main free account");
  assert.equal(backup.type, "tokenplan");
  assert.equal(backup.poolId, "acct-backup");
  assert.equal(backup.weight, 2);
  assert.equal(backup.priority, -1);
  assert.equal(backup.concurrency, 3);
});

test("AGNES_ACCOUNTS is optional; default order is sorted ids", () => {
  const config = loadAccountsConfig({
    AGNES_ACCOUNT_ZETA_KEY: "sk-test-z",
    AGNES_ACCOUNT_ALPHA_KEY: "sk-test-a",
  });
  assert.deepEqual(config.accounts.map((account) => account.id), ["alpha", "zeta"]);
  assert.deepEqual(config.pools, ["alpha", "zeta"]);
  assert.ok(config.warnings.some((warning) => /no explicit pool/.test(warning)));
});

test("legacy AGNES_API_KEY is ignored with a warning when indexed accounts exist", () => {
  const config = loadAccountsConfig(indexedEnv({ AGNES_API_KEY: "sk-test-legacy" }));
  assert.equal(config.accounts.length, 2);
  assert.ok(config.warnings.some((warning) => /AGNES_API_KEY is ignored/.test(warning)));

  const resolved = resolveConfig({ env: indexedEnv({ AGNES_API_KEY: "sk-test-legacy" }) });
  assert.equal(resolved.accountsConfig.accounts.length, 2);
  assert.equal(resolved.apiKey, "sk-test-main", "apiKey stays populated with the first account key");
});

test("AGNES_ROUTING_* and AGNES_RATE_LIMIT env are parsed", () => {
  const config = loadAccountsConfig(indexedEnv({
    AGNES_ROUTING_STRATEGY: "weighted",
    AGNES_ROUTING_MAX_ATTEMPTS: "5",
    AGNES_ROUTING_MAX_WAIT_MS: "1234",
    AGNES_RATE_LIMIT: "off",
    AGNES_STATE_DIR: "/tmp/agnes-test-state",
  }));
  assert.equal(config.strategy, "weighted");
  assert.equal(config.maxAttempts, 5);
  assert.equal(config.maxWaitMs, 1234);
  assert.equal(config.rateLimitEnabled, false);
  assert.equal(config.stateDir, "/tmp/agnes-test-state");
});

test("invalid indexed env blocks are INVALID_ACCOUNTS_CONFIG exit 2", () => {
  assertInvalidConfig(() => loadAccountsConfig({ AGNES_ACCOUNT_MAIN_BOGUS: "x" }), /Unknown account env var/);
  assertInvalidConfig(() => loadAccountsConfig({ AGNES_ACCOUNT_MAIN_TYPE: "free" }), /AGNES_ACCOUNT_MAIN_KEY is required/);
  assertInvalidConfig(() => loadAccountsConfig({ AGNES_ACCOUNTS: "ghost", AGNES_ACCOUNT_MAIN_KEY: "k" }), /unknown account "ghost"/);
  assertInvalidConfig(() => loadAccountsConfig({ AGNES_ACCOUNTS: "MAIN,MAIN", AGNES_ACCOUNT_MAIN_KEY: "k" }), /duplicate/);
  assertInvalidConfig(() => loadAccountsConfig(indexedEnv({ AGNES_ACCOUNT_MAIN_WEIGHT: "0" })), /WEIGHT/);
  assertInvalidConfig(() => loadAccountsConfig(indexedEnv({ AGNES_ACCOUNT_MAIN_TYPE: "platinum" })), /invalid type/);
  assertInvalidConfig(() => loadAccountsConfig(indexedEnv({ AGNES_ROUTING_STRATEGY: "bogus" })), /Invalid routing strategy/);
  assertInvalidConfig(() => loadAccountsConfig(indexedEnv({ AGNES_RATE_LIMIT: "maybe" })), /AGNES_RATE_LIMIT/);
  assertInvalidConfig(() => loadAccountsConfig(indexedEnv({ AGNES_ROUTING_MAX_ATTEMPTS: "0" })), /MAX_ATTEMPTS/);
});

test("pools may not mix key types", () => {
  assertInvalidConfig(() => loadAccountsConfig({
    AGNES_ACCOUNT_MAIN_KEY: "sk-a",
    AGNES_ACCOUNT_MAIN_TYPE: "free",
    AGNES_ACCOUNT_MAIN_POOL: "shared",
    AGNES_ACCOUNT_BACKUP_KEY: "sk-b",
    AGNES_ACCOUNT_BACKUP_TYPE: "tokenplan",
    AGNES_ACCOUNT_BACKUP_POOL: "shared",
  }), /mixes key types/);
});

/* ------------------------------ AC2: accounts file --------------------------- */

const validFile = {
  version: 1,
  strategy: "least-inflight",
  rateLimit: false,
  maxAttempts: 4,
  maxWaitMs: 9000,
  accounts: [
    { id: "main", key: "sk-test-file-main", type: "free", pool: "acct-main", label: "file main" },
    { id: "backup", keyEnv: "FILE_BACKUP_KEY", type: "tokenplan", pool: "acct-backup", models: ["agnes-video-2.5"] },
  ],
};

test("accounts file resolves accounts, settings and keyEnv", (t) => {
  const file = accountsFile(t, validFile);
  const config = loadAccountsConfig({ AGNES_ACCOUNTS_FILE: file, FILE_BACKUP_KEY: "sk-test-file-backup" });
  assert.equal(config.source, "file");
  assert.equal(config.strategy, "least-inflight");
  assert.equal(config.rateLimitEnabled, false);
  assert.equal(config.maxAttempts, 4);
  assert.equal(config.maxWaitMs, 9000);
  assert.deepEqual(config.accounts.map((account) => account.id), ["main", "backup"]);
  assert.equal(config.accounts[1].key, "sk-test-file-backup");
  assert.equal(config.accounts[1].keySource, "accounts-file");
});

test("accounts file wins over indexed env and legacy env (with warnings)", (t) => {
  const file = accountsFile(t, validFile);
  const config = loadAccountsConfig(
    { ...indexedEnv({ AGNES_API_KEY: "sk-test-legacy" }), AGNES_ACCOUNTS_FILE: file, FILE_BACKUP_KEY: "sk-b" },
  );
  assert.equal(config.source, "file");
  assert.equal(config.accounts.length, 2);
  assert.ok(config.warnings.some((warning) => /env accounts are ignored/.test(warning)));
  assert.ok(config.warnings.some((warning) => /AGNES_API_KEY is ignored/.test(warning)));
});

test("accounts file schema is strict (hard errors)", (t) => {
  assertInvalidConfig(
    () => loadAccountsConfig({ AGNES_ACCOUNTS_FILE: accountsFile(t, { ...validFile, surprise: true }) }),
    /Unknown accounts file field/,
  );
  assertInvalidConfig(
    () => loadAccountsConfig({
      AGNES_ACCOUNTS_FILE: accountsFile(t, {
        ...validFile,
        accounts: [{ id: "main", key: "k", extra: 1 }],
      }),
    }),
    /Unknown account field/,
  );
  assertInvalidConfig(
    () => loadAccountsConfig({ AGNES_ACCOUNTS_FILE: accountsFile(t, { ...validFile, version: 2 }) }),
    /Unsupported accounts file version/,
  );
  assertInvalidConfig(
    () => loadAccountsConfig({ AGNES_ACCOUNTS_FILE: accountsFile(t, { version: 1, accounts: [{ id: "main" }] }) }),
    /requires "key" or "keyEnv"/,
  );
  assertInvalidConfig(
    () => loadAccountsConfig({ AGNES_ACCOUNTS_FILE: accountsFile(t, { version: 1, accounts: [{ id: "BAD ID", key: "k" }] }) }),
    /invalid id/,
  );
  assertInvalidConfig(
    () => loadAccountsConfig({ AGNES_ACCOUNTS_FILE: join(tempDir(t), "missing.json") }),
    /Cannot read AGNES_ACCOUNTS_FILE/,
  );
});

test("insecure accounts file mode warns unless explicitly allowed", (t) => {
  const file = accountsFile(t, validFile, 0o644);
  const stderr = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  let permissive;
  try {
    permissive = loadAccountsConfig({ AGNES_ACCOUNTS_FILE: file, FILE_BACKUP_KEY: "sk-b" });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(permissive.warnings.some((warning) => /chmod 600/.test(warning)));
  assert.ok(stderr.some((line) => /chmod 600/.test(line)), "insecure file warning must also go to stderr");

  const allowed = loadAccountsConfig({
    AGNES_ACCOUNTS_FILE: file,
    FILE_BACKUP_KEY: "sk-b",
    AGNES_ACCOUNTS_ALLOW_INSECURE: "1",
  });
  assert.ok(!allowed.warnings.some((warning) => /chmod 600/.test(warning)));
});

/* ------------------------------- AC2: redaction ------------------------------ */

test("accountsSummary never contains key material", () => {
  const config = loadAccountsConfig(indexedEnv());
  const summary = accountsSummary(config);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("sk-test-main"));
  assert.ok(!serialized.includes("sk-test-backup"));
  assert.ok(!/sk-[A-Za-z0-9]/.test(serialized));
  assert.equal(summary.accounts[0].key, "present (len=12)");
  assert.equal(summary.source, "env");
  assert.equal(summary.strategy, "adaptive");
});

/* ------------------------------ AC2: resolveConfig --------------------------- */

test("resolveConfig builds one stateful router and reuses it for the same config", () => {
  const config = { env: indexedEnv() };
  const first = resolveConfig(config);
  const second = resolveConfig(config);
  assert.ok(first.router instanceof AccountRouter);
  assert.equal(first.router, second.router, "same config object keeps the same router");
  assert.equal(first.accountsConfig, first.router.config);
  assert.equal(first.apiKey, "sk-test-main");
});

test("createAgnesClient({apiKey}) keeps raw passthrough behavior (JS API file-free)", () => {
  const client = createAgnesClient({ apiKey: "sk-test-raw", fetchImpl: async () => Response.json({}) });
  assert.equal(client.router.config.source, "options");
  assert.equal(client.router.config.rateLimitEnabled, false);
  assert.equal(client.router.isPassthrough, true);
  assert.equal(client.router.config.accounts.length, 1);
  // Match the public API surface test: router/config are non-enumerable.
  assert.deepEqual(Object.keys(client).sort(), ["auth", "image", "media", "text", "video"]);
  assert.equal(client.routing, client.router);
});

test("explicit options accounts take precedence over env", () => {
  const resolved = resolveConfig({
    env: indexedEnv(),
    accounts: [
      {
        id: "solo",
        key: "sk-test-option",
        keySource: "options",
        type: "tokenplan",
        poolId: "acct-solo",
        weight: 1,
        priority: 0,
      },
    ],
    rateLimit: true,
  });
  assert.equal(resolved.accountsConfig.source, "options");
  assert.deepEqual(resolved.accountsConfig.accounts.map((account) => account.id), ["solo"]);
  assert.equal(resolved.accountsConfig.rateLimitEnabled, true);
  assert.equal(resolved.apiKey, "sk-test-option");
});
