/**
 * Accounts configuration resolution and validation
 * (docs/multi-account-design.md §2).
 *
 * Precedence: explicit options > accounts file (AGNES_ACCOUNTS_FILE) > indexed
 * env (AGNES_ACCOUNT_<ID>_*) > legacy AGNES_API_KEY. Errors are
 * `INVALID_ACCOUNTS_CONFIG` with exit code 2.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgnesCliError } from "../errors.js";
import { displayConcurrency } from "./limits.js";
import {
  ACCOUNT_TYPES,
  ROUTING_STRATEGIES,
  type AccountConfig,
  type AccountsConfig,
  type AccountsSummary,
  type AccountType,
  type RedactedAccountSummary,
  type RoutingStrategy,
} from "./types.js";

export const DEFAULT_STATE_DIR = join(homedir(), ".agnes", "state");
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_WAIT_MS = 60_000;

const ENV_ID_PATTERN = /^[A-Z0-9]{1,32}$/;
const FILE_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
const ENV_ACCOUNT_VAR = /^AGNES_ACCOUNT_([A-Z0-9]{1,32})_([A-Z_]+)$/;
const KNOWN_ACCOUNT_SUFFIXES = new Set([
  "KEY",
  "TYPE",
  "POOL",
  "WEIGHT",
  "PRIORITY",
  "CONCURRENCY",
  "MODELS",
  "BASE_URL",
  "LABEL",
]);

export interface LoadAccountsConfigOverrides {
  /** Explicit account list (JS API). Takes precedence over everything else. */
  accounts?: AccountConfig[];
  /** Explicit legacy API key (JS API `apiKey` option). */
  apiKey?: string;
  keySource?: string;
  /** Explicit accounts file path (overrides AGNES_ACCOUNTS_FILE). */
  accountsFile?: string;
  strategy?: RoutingStrategy;
  rateLimit?: boolean;
  maxAttempts?: number;
  maxWaitMs?: number;
  stateDir?: string;
}

function invalidConfig(message: string, details?: unknown): AgnesCliError {
  return new AgnesCliError("INVALID_ACCOUNTS_CONFIG", message, details, 2);
}

/**
 * Resolve accounts from env / an accounts file / explicit options.
 *
 * `env` is explicit so tests never touch the real process environment.
 */
export function loadAccountsConfig(
  env: NodeJS.ProcessEnv = {},
  overrides: LoadAccountsConfigOverrides = {},
): AccountsConfig {
  const warnings: string[] = [];
  const indexed = scanIndexedEnv(env);
  const filePath = overrides.accountsFile ?? env.AGNES_ACCOUNTS_FILE;

  if (overrides.accounts && overrides.accounts.length > 0) {
    return finalizeConfig({
      accounts: normalizeExplicitAccounts(overrides.accounts),
      strategy: overrides.strategy,
      rateLimitEnabled: overrides.rateLimit ?? true,
      maxAttempts: overrides.maxAttempts,
      maxWaitMs: overrides.maxWaitMs,
      stateDir: resolveStateDir(env, overrides.stateDir),
      source: "options",
      warnings,
    }, env);
  }

  if (overrides.apiKey) {
    return finalizeConfig({
      accounts: [legacyAccount(overrides.apiKey, overrides.keySource ?? "options")],
      implicitLegacy: true,
      strategy: overrides.strategy ?? "primary",
      rateLimitEnabled: overrides.rateLimit ?? false,
      maxAttempts: overrides.maxAttempts,
      maxWaitMs: overrides.maxWaitMs,
      stateDir: resolveStateDir(env, overrides.stateDir),
      source: "options",
      warnings,
    }, env);
  }

  if (filePath) {
    const parsed = loadAccountsFile(filePath, env, warnings);
    if (indexedPresent(indexed)) {
      warnings.push(`AGNES_ACCOUNT_* env accounts are ignored because AGNES_ACCOUNTS_FILE is set.`);
    }
    if (env.AGNES_API_KEY) {
      warnings.push("AGNES_API_KEY is ignored because an accounts file is configured.");
    }
    return finalizeConfig({
      accounts: parsed.accounts,
      strategy: overrides.strategy ?? parsed.strategy,
      rateLimitEnabled: overrides.rateLimit ?? parsed.rateLimit,
      maxAttempts: overrides.maxAttempts ?? parsed.maxAttempts,
      maxWaitMs: overrides.maxWaitMs ?? parsed.maxWaitMs,
      stateDir: resolveStateDir(env, overrides.stateDir),
      source: "file",
      warnings,
    }, env);
  }

  if (indexedPresent(indexed)) {
    if (env.AGNES_API_KEY) {
      warnings.push("AGNES_API_KEY is ignored because AGNES_ACCOUNT_* accounts are configured.");
    }
    const accounts = buildEnvAccounts(env, indexed);
    return finalizeConfig({
      accounts,
      strategy: overrides.strategy,
      rateLimitEnabled: overrides.rateLimit ?? parseRateLimit(env.AGNES_RATE_LIMIT),
      maxAttempts: overrides.maxAttempts,
      maxWaitMs: overrides.maxWaitMs,
      stateDir: resolveStateDir(env, overrides.stateDir),
      source: "env",
      warnings,
    }, env);
  }

  if (env.AGNES_API_KEY) {
    return finalizeConfig({
      accounts: [legacyAccount(env.AGNES_API_KEY, "AGNES_API_KEY")],
      implicitLegacy: true,
      strategy: overrides.strategy ?? "primary",
      rateLimitEnabled: overrides.rateLimit ?? parseRateLimit(env.AGNES_RATE_LIMIT),
      maxAttempts: overrides.maxAttempts,
      maxWaitMs: overrides.maxWaitMs,
      stateDir: resolveStateDir(env, overrides.stateDir),
      source: "legacy",
      warnings,
    }, env);
  }

  return finalizeConfig({
    accounts: [],
    strategy: overrides.strategy,
    rateLimitEnabled: overrides.rateLimit ?? parseRateLimit(env.AGNES_RATE_LIMIT),
    maxAttempts: overrides.maxAttempts,
    maxWaitMs: overrides.maxWaitMs,
    stateDir: resolveStateDir(env, overrides.stateDir),
    source: "env",
    warnings,
  }, env);
}

interface FinalizeInput {
  accounts: AccountConfig[];
  implicitLegacy?: boolean;
  strategy?: RoutingStrategy;
  rateLimitEnabled?: boolean;
  maxAttempts?: number;
  maxWaitMs?: number;
  stateDir: string;
  source: AccountsConfig["source"];
  warnings: string[];
}

function finalizeConfig(input: FinalizeInput, env: NodeJS.ProcessEnv): AccountsConfig {
  const strategy =
    input.strategy ??
    parseStrategy(env.AGNES_ROUTING_STRATEGY) ??
    (input.source === "legacy" ? "primary" : "adaptive");
  const maxAttempts =
    input.maxAttempts ??
    parsePositiveInt(env.AGNES_ROUTING_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, "AGNES_ROUTING_MAX_ATTEMPTS");
  const maxWaitMs =
    input.maxWaitMs ?? parsePositiveInt(env.AGNES_ROUTING_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, "AGNES_ROUTING_MAX_WAIT_MS");
  const accounts = validateAccounts(input.accounts);
  const pools = collectPools(accounts);
  const warnings = [...input.warnings, ...poolWarnings(accounts, pools)];
  return {
    accounts,
    pools,
    strategy,
    maxAttempts,
    maxWaitMs,
    rateLimitEnabled: input.rateLimitEnabled ?? true,
    stateDir: input.stateDir,
    source: input.source,
    warnings,
    ...(input.implicitLegacy ? { implicitLegacy: true } : {}),
  };
}

function legacyAccount(key: string, keySource: string): AccountConfig {
  return {
    id: "default",
    key,
    keySource,
    type: "free",
    poolId: "default",
    weight: 1,
    priority: 0,
  };
}

function normalizeExplicitAccounts(accounts: AccountConfig[]): AccountConfig[] {
  return accounts.map((account) => {
    if (!account || typeof account !== "object") {
      throw invalidConfig("accounts must be objects with id/key/type/pool fields.");
    }
    if (typeof account.key !== "string" || !account.key) {
      throw invalidConfig(`Account ${account.id ?? "<unknown>"} is missing a key.`);
    }
    return {
      id: String(account.id ?? ""),
      key: account.key,
      keySource: account.keySource ?? "options",
      type: account.type ?? "free",
      poolId: account.poolId ?? account.id,
      weight: account.weight ?? 1,
      priority: account.priority ?? 0,
      concurrency: account.concurrency,
      models: account.models,
      baseUrl: account.baseUrl,
      label: account.label,
    };
  });
}

function validateAccounts(accounts: AccountConfig[]): AccountConfig[] {
  const seen = new Set<string>();
  for (const account of accounts) {
    if (!account.id || !(FILE_ID_PATTERN.test(account.id) || ENV_ID_PATTERN.test(account.id.toUpperCase()))) {
      throw invalidConfig(`Invalid account id "${account.id}". Expected [a-z0-9_-]{1,32}.`, { accountId: account.id });
    }
    if (seen.has(account.id)) {
      throw invalidConfig(`Duplicate account id "${account.id}".`, { accountId: account.id });
    }
    seen.add(account.id);
    if (!ACCOUNT_TYPES.includes(account.type)) {
      throw invalidConfig(`Account ${account.id} has invalid type "${account.type}". Allowed: ${ACCOUNT_TYPES.join(", ")}.`);
    }
    if (!Number.isInteger(account.weight) || account.weight <= 0) {
      throw invalidConfig(`Account ${account.id} weight must be a positive integer.`, { accountId: account.id });
    }
    if (!Number.isInteger(account.priority)) {
      throw invalidConfig(`Account ${account.id} priority must be an integer.`, { accountId: account.id });
    }
    if (account.concurrency !== undefined && (!Number.isInteger(account.concurrency) || account.concurrency <= 0)) {
      throw invalidConfig(`Account ${account.id} concurrency must be a positive integer.`, { accountId: account.id });
    }
    if (account.models !== undefined && (!Array.isArray(account.models) || account.models.some((model) => typeof model !== "string" || !model))) {
      throw invalidConfig(`Account ${account.id} models must be an array of model ids.`, { accountId: account.id });
    }
  }
  const poolTypes = new Map<string, AccountType>();
  for (const account of accounts) {
    const existing = poolTypes.get(account.poolId);
    if (existing && existing !== account.type) {
      throw invalidConfig(
        `Pool "${account.poolId}" mixes key types (${existing}, ${account.type}); a limit pool is shared by one key type only.`,
        { poolId: account.poolId },
      );
    }
    poolTypes.set(account.poolId, account.type);
  }
  return accounts;
}

function collectPools(accounts: AccountConfig[]): string[] {
  const pools: string[] = [];
  for (const account of accounts) {
    if (!pools.includes(account.poolId)) pools.push(account.poolId);
  }
  return pools;
}

function poolWarnings(accounts: AccountConfig[], pools: string[]): string[] {
  if (accounts.length < 2) return [];
  const implicit = accounts.filter((account) => account.poolId === account.id);
  if (implicit.length >= 2) {
    return [
      `${implicit.map((account) => account.id).join(" and ")} have no explicit pool; if they are keys of the same account, set pool= to group them so client-side pacing matches the API limit.`,
    ];
  }
  if (pools.length === 1) {
    return [
      `All accounts share pool "${pools[0]}"; requests are paced as one account. Give distinct accounts distinct pools to stack limits.`,
    ];
  }
  return [];
}

/* ------------------------------- env parsing ------------------------------ */

interface IndexedEnvAccounts {
  ids: string[];
  vars: Map<string, Map<string, string | undefined>>;
}

function indexedPresent(indexed: IndexedEnvAccounts): boolean {
  return indexed.ids.length > 0;
}

function scanIndexedEnv(env: NodeJS.ProcessEnv): IndexedEnvAccounts {
  const vars = new Map<string, Map<string, string | undefined>>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("AGNES_ACCOUNT_")) continue;
    const match = ENV_ACCOUNT_VAR.exec(name);
    if (!match) {
      // AGNES_ACCOUNT_MAIN_KEY matches; AGNES_ACCOUNTS_FILE etc. do not.
      if (/^AGNES_ACCOUNT_[A-Z0-9]{1,32}_[A-Z_]+$/.test(name)) {
        throw invalidConfig(`Unknown account env var ${name}. Allowed suffixes: ${[...KNOWN_ACCOUNT_SUFFIXES].join(", ")}.`);
      }
      continue;
    }
    const [, rawId, rawSuffix] = match;
    if (!KNOWN_ACCOUNT_SUFFIXES.has(rawSuffix)) {
      throw invalidConfig(`Unknown account env var ${name}. Allowed suffixes: ${[...KNOWN_ACCOUNT_SUFFIXES].join(", ")}.`);
    }
    if (!ENV_ID_PATTERN.test(rawId)) {
      throw invalidConfig(`Invalid account env id "${rawId}". Expected [A-Z0-9]{1,32}.`);
    }
    const id = rawId.toLowerCase();
    if (!vars.has(id)) vars.set(id, new Map());
    vars.get(id)!.set(rawSuffix, value);
  }

  const configured = [...vars.keys()];
  const order = parseAccountsOrder(env.AGNES_ACCOUNTS);
  if (order) {
    for (const id of order) {
      if (!vars.has(id)) {
        throw invalidConfig(`AGNES_ACCOUNTS lists unknown account "${id}". Configure AGNES_ACCOUNT_${id.toUpperCase()}_KEY.`);
      }
    }
    const remaining = configured.filter((id) => !order.includes(id)).sort();
    return { ids: [...order, ...remaining], vars };
  }
  return { ids: configured.sort(), vars };
}

function parseAccountsOrder(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0) return undefined;
  const seen = new Set<string>();
  for (const id of ids) {
    if (!ENV_ID_PATTERN.test(id.toUpperCase())) {
      throw invalidConfig(`AGNES_ACCOUNTS contains invalid id "${id}". Expected [A-Z0-9]{1,32}.`);
    }
    if (seen.has(id)) throw invalidConfig(`AGNES_ACCOUNTS lists duplicate id "${id}".`);
    seen.add(id);
  }
  return ids;
}

function buildEnvAccounts(env: NodeJS.ProcessEnv, indexed: IndexedEnvAccounts): AccountConfig[] {
  return indexed.ids.map((id) => {
    const values = indexed.vars.get(id) ?? new Map<string, string | undefined>();
    const upper = id.toUpperCase();
    const key = values.get("KEY");
    if (!key) {
      throw invalidConfig(`AGNES_ACCOUNT_${upper}_KEY is required for account "${id}".`);
    }
    const type = parseAccountType(values.get("TYPE"), id);
    return {
      id,
      key,
      keySource: `AGNES_ACCOUNT_${upper}_KEY`,
      type,
      poolId: values.get("POOL")?.trim() || id,
      weight: parsePositiveInt(values.get("WEIGHT"), 1, `AGNES_ACCOUNT_${upper}_WEIGHT`),
      priority: parseInteger(values.get("PRIORITY"), 0, `AGNES_ACCOUNT_${upper}_PRIORITY`),
      concurrency: values.get("CONCURRENCY")?.trim()
        ? parsePositiveInt(values.get("CONCURRENCY"), 1, `AGNES_ACCOUNT_${upper}_CONCURRENCY`)
        : undefined,
      models: values.get("MODELS")?.trim()
        ? values.get("MODELS")!.split(",").map((entry) => entry.trim()).filter(Boolean)
        : undefined,
      baseUrl: values.get("BASE_URL")?.trim() || undefined,
      label: values.get("LABEL")?.trim() || undefined,
    };
  });
}

function parseAccountType(raw: string | undefined, accountId: string): AccountType {
  if (!raw?.trim()) return "free";
  const value = raw.trim().toLowerCase();
  if (!(ACCOUNT_TYPES as readonly string[]).includes(value)) {
    throw invalidConfig(`Account ${accountId} has invalid type "${raw}". Allowed: ${ACCOUNT_TYPES.join(", ")}.`);
  }
  return value as AccountType;
}

export function parseStrategy(raw: string | undefined): RoutingStrategy | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (!(ROUTING_STRATEGIES as readonly string[]).includes(value)) {
    throw invalidConfig(`Invalid routing strategy "${raw}". Allowed: ${ROUTING_STRATEGIES.join(", ")}.`);
  }
  return value as RoutingStrategy;
}

function parseRateLimit(raw: string | undefined): boolean | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  throw invalidConfig(`Invalid AGNES_RATE_LIMIT "${raw}". Use on|off.`);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw invalidConfig(`${name} must be a positive integer (got "${raw}").`);
  }
  return parsed;
}

function parseInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw invalidConfig(`${name} must be an integer (got "${raw}").`);
  }
  return parsed;
}

function resolveStateDir(env: NodeJS.ProcessEnv, override: string | undefined): string {
  const raw = override ?? env.AGNES_STATE_DIR ?? DEFAULT_STATE_DIR;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/* ------------------------------ accounts file ----------------------------- */

const FILE_TOP_LEVEL_KEYS = new Set(["version", "strategy", "rateLimit", "maxAttempts", "maxWaitMs", "accounts"]);
const FILE_ACCOUNT_KEYS = new Set([
  "id",
  "key",
  "keyEnv",
  "type",
  "pool",
  "weight",
  "priority",
  "concurrency",
  "models",
  "baseUrl",
  "label",
]);

interface ParsedAccountsFile {
  accounts: AccountConfig[];
  strategy?: RoutingStrategy;
  rateLimit?: boolean;
  maxAttempts?: number;
  maxWaitMs?: number;
}

function loadAccountsFile(filePath: string, env: NodeJS.ProcessEnv, warnings: string[]): ParsedAccountsFile {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw invalidConfig(`Cannot read AGNES_ACCOUNTS_FILE at ${filePath}: ${error instanceof Error ? error.message : String(error)}.`, {
      path: filePath,
    });
  }
  checkFilePermissions(filePath, env, warnings);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw invalidConfig(`AGNES_ACCOUNTS_FILE at ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidConfig(`AGNES_ACCOUNTS_FILE at ${filePath} must contain a JSON object.`);
  }
  const record = document as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FILE_TOP_LEVEL_KEYS.has(key)) {
      throw invalidConfig(`Unknown accounts file field "${key}" at ${filePath}.`, { field: key });
    }
  }
  if (record.version !== 1) {
    throw invalidConfig(`Unsupported accounts file version ${String(record.version)} at ${filePath}; expected 1.`);
  }
  if (!Array.isArray(record.accounts) || record.accounts.length === 0) {
    throw invalidConfig(`Accounts file at ${filePath} must contain a non-empty "accounts" array.`);
  }
  const accounts = record.accounts.map((entry, index) => parseFileAccount(entry, index, filePath, env));
  return {
    accounts,
    strategy: record.strategy === undefined ? undefined : parseFileStrategy(record.strategy),
    rateLimit: record.rateLimit === undefined ? undefined : parseFileBoolean(record.rateLimit, "rateLimit"),
    maxAttempts:
      record.maxAttempts === undefined ? undefined : parseFilePositiveInt(record.maxAttempts, "maxAttempts"),
    maxWaitMs: record.maxWaitMs === undefined ? undefined : parseFilePositiveInt(record.maxWaitMs, "maxWaitMs"),
  };
}

function parseFileAccount(entry: unknown, index: number, filePath: string, env: NodeJS.ProcessEnv): AccountConfig {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw invalidConfig(`Account #${index} in ${filePath} must be a JSON object.`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FILE_ACCOUNT_KEYS.has(key)) {
      throw invalidConfig(`Unknown account field "${key}" in ${filePath} (account #${index}).`, { field: key });
    }
  }
  const rawId = record.id;
  if (typeof rawId !== "string" || !FILE_ID_PATTERN.test(rawId)) {
    throw invalidConfig(`Account #${index} in ${filePath} has invalid id ${JSON.stringify(rawId)}. Expected [a-z0-9_-]{1,32}.`);
  }
  let key = typeof record.key === "string" && record.key ? record.key : undefined;
  if (!key && typeof record.keyEnv === "string" && record.keyEnv) {
    key = env[record.keyEnv];
    if (!key) {
      throw invalidConfig(`Account "${rawId}" references keyEnv ${record.keyEnv}, which is not set.`);
    }
  }
  if (!key) {
    throw invalidConfig(`Account "${rawId}" in ${filePath} requires "key" or "keyEnv".`);
  }
  let type: AccountType = "free";
  if (record.type !== undefined) type = parseAccountType(typeof record.type === "string" ? record.type : String(record.type), rawId);
  const weight = record.weight === undefined ? 1 : parseFilePositiveInt(record.weight, `account "${rawId}" weight`);
  const priority = record.priority === undefined ? 0 : parseFileInteger(record.priority, `account "${rawId}" priority`);
  let concurrency: number | undefined;
  if (record.concurrency !== undefined) {
    concurrency = parseFilePositiveInt(record.concurrency, `account "${rawId}" concurrency`);
  }
  let models: string[] | undefined;
  if (record.models !== undefined) {
    if (!Array.isArray(record.models) || record.models.some((model) => typeof model !== "string" || !model)) {
      throw invalidConfig(`Account "${rawId}" models must be an array of model ids.`);
    }
    models = record.models as string[];
  }
  const baseUrl = typeof record.baseUrl === "string" && record.baseUrl ? record.baseUrl : undefined;
  const label = typeof record.label === "string" && record.label ? record.label : undefined;
  return {
    id: rawId,
    key,
    keySource: "accounts-file",
    type,
    poolId: typeof record.pool === "string" && record.pool ? record.pool : rawId,
    weight,
    priority,
    concurrency,
    models,
    baseUrl,
    label,
  };
}

function checkFilePermissions(filePath: string, env: NodeJS.ProcessEnv, warnings: string[]): void {
  if (env.AGNES_ACCOUNTS_ALLOW_INSECURE === "1") return;
  try {
    const stats = statSync(filePath);
    if ((stats.mode & 0o077) !== 0) {
      const message = `Accounts file ${filePath} is readable by group/other; run chmod 600 ${filePath} or set AGNES_ACCOUNTS_ALLOW_INSECURE=1 to silence this warning.`;
      warnings.push(message);
      // Design §2.3: insecure accounts-file mode is warned on stderr as well.
      process.stderr.write(`warning: ${message}\n`);
    }
  } catch {
    // unreadable stat is reported by readFileSync above
  }
}

function parseFileStrategy(raw: unknown): RoutingStrategy {
  if (typeof raw !== "string") throw invalidConfig("Accounts file strategy must be a string.");
  const strategy = parseStrategy(raw);
  if (!strategy) throw invalidConfig("Accounts file strategy must not be empty.");
  return strategy;
}

function parseFileBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw invalidConfig(`Accounts file ${field} must be a boolean.`);
  return raw;
}

function parseFilePositiveInt(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw invalidConfig(`Accounts file ${field} must be a positive integer.`);
  }
  return raw;
}

function parseFileInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalidConfig(`Accounts file ${field} must be an integer.`);
  }
  return raw;
}

/* -------------------------------- summaries ------------------------------- */

function redactKey(account: AccountConfig): string {
  return account.key ? `present (len=${account.key.length})` : "missing";
}

export function redactedAccount(account: AccountConfig): RedactedAccountSummary {
  return {
    id: account.id,
    type: account.type,
    poolId: account.poolId,
    weight: account.weight,
    priority: account.priority,
    concurrency: displayConcurrency(account),
    ...(account.models ? { models: [...account.models] } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(account.label ? { label: account.label } : {}),
    key: redactKey(account),
    source: account.keySource,
    healthy: true,
    inflight: 0,
  };
}

/** Redacted, JSON-safe description: key material is reduced to `present (len=N)`. */
export function accountsSummary(config: AccountsConfig): AccountsSummary {
  return {
    ok: true,
    strategy: config.strategy,
    rateLimit: config.rateLimitEnabled,
    source: config.source,
    stateDir: config.stateDir,
    maxAttempts: config.maxAttempts,
    maxWaitMs: config.maxWaitMs,
    pools: [...config.pools],
    accounts: config.accounts.map(redactedAccount),
    warnings: [...config.warnings],
  };
}

/** Resolve a single account by id (case-insensitive for user convenience). */
export function findAccount(config: AccountsConfig, id: string): AccountConfig | undefined {
  const normalized = id.toLowerCase();
  return config.accounts.find((account) => account.id === normalized || account.id === id);
}
