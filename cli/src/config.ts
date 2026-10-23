import { AgnesCliError } from "./errors.js";
import { AffinityJournal } from "./accounts/affinity.js";
import { loadAccountsConfig } from "./accounts/config.js";
import { AccountRouter } from "./accounts/router.js";
import type { AccountsConfig, RouteOptions, RoutingInfo } from "./accounts/types.js";

export type Ttl = "1h" | "12h" | "24h" | "72h";
export type TemporaryMediaProviderName = "litterbox" | "tmpfiles" | "uguu" | "x0";

export type FetchLike = typeof fetch;

/** Comma-separated provider order, e.g. `uguu,x0,litterbox,tmpfiles`. */
export function parseMediaProviderOrder(value: string | undefined): TemporaryMediaProviderName[] | undefined {
  if (!value?.trim()) return undefined;
  const allowed: readonly TemporaryMediaProviderName[] = ["litterbox", "tmpfiles", "uguu", "x0"];
  const names = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(allowed as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new AgnesCliError(
      "INVALID_ENV",
      `AGNES_MEDIA_PROVIDER_ORDER contains unknown provider(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
  return names as TemporaryMediaProviderName[];
}

export interface AgnesClientConfig {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  defaultMediaTtl?: Ttl;
  temporaryMediaProviderOrder?: readonly TemporaryMediaProviderName[];
  mediaProvider?: MediaUrlProvider;
  env?: NodeJS.ProcessEnv;
  /** Explicit account list (JS API). Overrides env/config-file accounts. */
  accounts?: import("./accounts/types.js").AccountConfig[];
  /** Routing strategy override for this client. */
  strategy?: import("./accounts/types.js").RoutingStrategy;
  /** Client-side pacing override (default: on for CLI/env config, off for a raw `apiKey` client). */
  rateLimit?: boolean;
  maxAttempts?: number;
  maxWaitMs?: number;
  /** State directory override (affinity journal + router state). */
  stateDir?: string;
  /** Explicit affinity-journal directory (JS API opt-in; keeps the plain client file-free). */
  affinityStateDir?: string;
  /** Explicit accounts JSON file path (same as AGNES_ACCOUNTS_FILE). */
  accountsFile?: string;
  /** Reuse an existing router (internal: resolved configs are passed back through createAgnesClient). */
  router?: AccountRouter;
}

export interface MediaUrlProvider {
  upload(localPath: string, options?: { ttl?: Ttl }): Promise<string>;
}

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  fetchImpl: FetchLike;
  defaultMediaTtl: Ttl;
  temporaryMediaProviderOrder?: readonly TemporaryMediaProviderName[];
  mediaProvider?: MediaUrlProvider;
  env: NodeJS.ProcessEnv;
  accountsConfig: AccountsConfig;
  router: AccountRouter;
}

export const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const DEFAULT_MEDIA_TTL: Ttl = "1h";
export const DEFAULT_VIDEO_DIMENSIONS = {
  width: 1152,
  height: 768,
};
export const DEFAULT_VIDEO_TEMPORAL = {
  numFrames: 121,
  frameRate: 24,
};

const resolvedConfigCache = new WeakMap<object, ResolvedConfig>();

/** True when the value already went through `resolveConfig` (reuse its stateful router). */
export function isResolvedConfig(value: unknown): value is ResolvedConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "accountsConfig" in value &&
    "router" in value &&
    (value as ResolvedConfig).router instanceof AccountRouter
  );
}

/** Accept either a raw client config or an already-resolved one. */
export function resolveClientConfig(config: AgnesClientConfig | ResolvedConfig = {}): ResolvedConfig {
  if (isResolvedConfig(config)) return config;
  return resolveConfig(config);
}

export function resolveConfig(config: AgnesClientConfig = {}): ResolvedConfig {
  const cached = resolvedConfigCache.get(config);
  if (cached) return cached;
  if (!config.fetchImpl && typeof fetch !== "function") {
    throw new AgnesCliError("FETCH_UNAVAILABLE", "Global fetch is unavailable in this Node runtime.");
  }
  const env = config.env ?? process.env;
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? env.AGNES_BASE_URL ?? DEFAULT_BASE_URL;
  const accountsConfig = loadAccountsConfig(env, {
    ...(config.accounts ? { accounts: config.accounts } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey, keySource: "options" } : {}),
    ...(config.accountsFile ? { accountsFile: config.accountsFile } : {}),
    ...(config.strategy ? { strategy: config.strategy } : {}),
    ...(config.rateLimit !== undefined ? { rateLimit: config.rateLimit } : {}),
    ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    ...(config.maxWaitMs !== undefined ? { maxWaitMs: config.maxWaitMs } : {}),
    ...(config.stateDir ? { stateDir: config.stateDir } : {}),
  });
  const journal = buildAffinityJournal(config, accountsConfig, env);
  const router = new AccountRouter(
    accountsConfig,
    { fetchImpl, env },
    {
      ...(journal ? { journal } : {}),
      fallbackBaseUrl: baseUrl,
      pollIntervalMs: parsePollIntervalMs(env.AGNES_POLL_INTERVAL_MS),
    },
  );
  const resolved: ResolvedConfig = {
    apiKey: accountsConfig.accounts[0]?.key,
    // AGNES_BASE_URL lets callers switch to the .cn / alternate gateway without code changes.
    baseUrl,
    fetchImpl,
    defaultMediaTtl: config.defaultMediaTtl ?? DEFAULT_MEDIA_TTL,
    temporaryMediaProviderOrder:
      config.temporaryMediaProviderOrder ?? parseMediaProviderOrder(env.AGNES_MEDIA_PROVIDER_ORDER),
    mediaProvider: config.mediaProvider,
    env,
    accountsConfig,
    router,
  };
  resolvedConfigCache.set(config, resolved);
  return resolved;
}

/**
 * Affinity persistence is enabled for env/file/legacy CLI configs (so video
 * create→poll survives across processes) and for JS API clients only when the
 * caller explicitly opts in with `stateDir`/`affinityStateDir`.
 */
function buildAffinityJournal(
  config: AgnesClientConfig,
  accountsConfig: AccountsConfig,
  env: NodeJS.ProcessEnv,
): AffinityJournal | undefined {
  const explicitDir = config.affinityStateDir ?? config.stateDir;
  if (explicitDir) return AffinityJournal.forStateDir(explicitDir);
  if (accountsConfig.source === "options") return undefined;
  if (accountsConfig.accounts.length === 0) return undefined;
  const stateDir = config.stateDir ?? env.AGNES_STATE_DIR;
  return AffinityJournal.forStateDir(stateDir ?? accountsConfig.stateDir);
}

function parsePollIntervalMs(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

export interface AuthCheckResult {
  ok: boolean;
  configured: boolean;
  source: "env" | "file" | "options" | "missing";
  accounts: number;
  pools: string[];
  strategy: import("./accounts/types.js").RoutingStrategy;
}

export interface PublicUrlResult {
  ok: true;
  url: string;
  source: "passthrough" | "litterbox" | "temporary" | "provider";
}

export type AgnesStatus = "queued" | "in_progress" | "completed" | "failed" | "canceled" | "timed_out";

export interface NormalizedVideoTask {
  [key: string]: unknown;
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  raw: unknown;
  accountId?: string;
  poolId?: string;
  routing?: RoutingInfo;
}

export interface NormalizedVideoResult {
  [key: string]: unknown;
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  videoUrl: string;
  seconds?: number;
  size?: string;
  raw: unknown;
  accountId?: string;
  poolId?: string;
  routing?: RoutingInfo;
}

export interface NormalizedVideoStatus {
  [key: string]: unknown;
  ok: true;
  taskId: string;
  videoId?: string;
  status: AgnesStatus;
  rawStatus?: string;
  model: string;
  videoUrl?: string;
  seconds?: number;
  size?: string;
  error?: unknown;
  raw: unknown;
  accountId?: string;
  poolId?: string;
  routing?: RoutingInfo;
}

export interface ImageGenerationResult {
  [key: string]: unknown;
  ok: true;
  model: string;
  url: string;
  raw: unknown;
  accountId?: string;
  poolId?: string;
  routing?: RoutingInfo;
}

export type { AccountConfig, AccountsConfig, RouteOptions, RoutingInfo } from "./accounts/types.js";
