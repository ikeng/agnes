/**
 * Core data model for multi-account routing (docs/multi-account-design.md §3).
 *
 * Account `key` values live only in memory / the operator's 600-mode env file:
 * they are never serialized by `accountsSummary`, the router summary, errors,
 * manifests or results. Tests must use fake keys only.
 */

export type AccountType = "free" | "enterprise" | "tokenplan";

export const ACCOUNT_TYPES: readonly AccountType[] = ["free", "enterprise", "tokenplan"];

export type RoutingStrategy = "adaptive" | "round-robin" | "weighted" | "least-inflight" | "primary";

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = [
  "adaptive",
  "round-robin",
  "weighted",
  "least-inflight",
  "primary",
];

export type WorkloadClass = "text" | "image" | "video" | "status";

export interface AccountConfig {
  id: string;
  /** Secret. Never export/log/serialize this field. */
  key: string;
  /** Where the key came from, e.g. `AGNES_API_KEY`, `AGNES_ACCOUNT_MAIN_KEY`, `accounts-file`, `options`. */
  keySource: string;
  type: AccountType;
  poolId: string;
  /** Positive integer; only meaningful for the `weighted` strategy. */
  weight: number;
  /** Lower is preferred by the `primary` strategy. */
  priority: number;
  /** Optional override of the per-workload concurrency class maximum. */
  concurrency?: number;
  /** Optional allowlist of models this account may serve. */
  models?: readonly string[];
  /** Optional per-account gateway base URL. */
  baseUrl?: string;
  /** Optional human label (never a secret). */
  label?: string;
}

export interface AccountsConfig {
  accounts: AccountConfig[];
  pools: string[];
  strategy: RoutingStrategy;
  maxAttempts: number;
  maxWaitMs: number;
  rateLimitEnabled: boolean;
  stateDir: string;
  source: "legacy" | "env" | "file" | "options";
  warnings: string[];
  /**
   * Internal: the config is a single implicit legacy `AGNES_API_KEY` account.
   * Only such a config keeps the raw (unclassified, file-free) JS-API path.
   */
  implicitLegacy?: boolean;
}

export interface RouteOptions {
  /** Force one account; disables failover. */
  accountId?: string;
  /** Force one pool (batch strict / manifest pin). */
  poolId?: string;
  /** Sticky key: `session:<name>`, `video:<videoId>`, `task:<taskId>`, `batch:<batchId>:<jobId>`. */
  affinityKey?: string;
  strategy?: RoutingStrategy;
  workload?: WorkloadClass;
  model?: string;
  /** Effective image size (tier or WIDTHxHEIGHT); selects the image RPM bucket. */
  size?: string;
}

/** Routing provenance attached to every routed result (no key material). */
export interface RoutingInfo {
  strategy: RoutingStrategy;
  attempts: number;
  waitedMs: number;
  fallback: boolean;
  /** Index signature keeps this JSON-safe record structurally expandable for consumers. */
  [key: string]: unknown;
}

export interface RouteResult<T> {
  value: T;
  accountId: string;
  poolId: string;
  attempts: number;
  waitedMs: number;
  fallback: boolean;
}

export interface AffinityEntry {
  accountId: string;
  poolId: string;
  model?: string;
  kind?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RouterSummary {
  strategy: RoutingStrategy;
  rateLimitEnabled: boolean;
  accounts: Array<{
    id: string;
    type: AccountType;
    poolId: string;
    weight: number;
    priority: number;
    concurrency: number;
    models?: string[];
    healthy: boolean;
    coolingUntil?: number;
    inflight: number;
  }>;
  pools: Array<{ id: string; coolingUntil?: number; inflight: number }>;
  warnings: string[];
}

/** Redacted, JSON-safe account description used by `accounts list` and `auth check`. */
export interface RedactedAccountSummary {
  id: string;
  type: AccountType;
  poolId: string;
  weight: number;
  priority: number;
  concurrency: number;
  models?: string[];
  baseUrl?: string;
  label?: string;
  key: string;
  source: string;
  healthy: boolean;
  coolingUntil?: number;
  inflight: number;
}

export interface AccountsSummary {
  ok: true;
  strategy: RoutingStrategy;
  rateLimit: boolean;
  source: AccountsConfig["source"];
  stateDir: string;
  maxAttempts: number;
  maxWaitMs: number;
  pools: string[];
  accounts: RedactedAccountSummary[];
  warnings: string[];
}
