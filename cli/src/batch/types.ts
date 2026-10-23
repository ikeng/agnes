/**
 * Batch production types (design contract: docs/multi-account-design.md §6).
 *
 * The batch runner is deliberately decoupled from the concrete client/router
 * implementation: `registerBatchCommands` receives a `getClient` callback and
 * the runner only relies on the structural surface below. The real client
 * satisfies it; tests can pass an in-memory fake client.
 */

export type ConsistencyMode = "record" | "strict";
export type BatchJobKind = "image" | "video" | "text";
export type BatchJobStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type BatchOnly = "failed" | "pending" | "all";
export type BatchTtl = "1h" | "12h" | "24h" | "72h";

/** Provenance for a job's effective model (manifest.jobs[].modelSource). */
export type EffectiveModelSource = "job" | "defaults" | "kind-default";
export type BatchWorkload = "text" | "image" | "video" | "status";
export type BatchRoutingStrategy =
  | "adaptive"
  | "round-robin"
  | "weighted"
  | "least-inflight"
  | "primary";

export const BATCH_IMAGE_MODES = ["text2img", "img2img", "compose"] as const;
export const BATCH_VIDEO_MODES = ["text2video", "img2video", "multivideo", "keyframes"] as const;
export const BATCH_TEXT_MODES = ["chat"] as const;
export const BATCH_TTLS: readonly BatchTtl[] = ["1h", "12h", "24h", "72h"];

/** Route options structurally compatible with cli/src/accounts/types.ts RouteOptions. */
export interface BatchRouteOptions {
  accountId?: string;
  poolId?: string;
  affinityKey?: string;
  strategy?: BatchRoutingStrategy;
  workload?: BatchWorkload;
  model?: string;
  /** Effective image size tier, used by the router's image rate-limit bucket. */
  size?: string;
}

/** Minimal account reference returned by the router for strict pinning. */
export interface BatchAccountRef {
  id: string;
  poolId?: string;
  type?: string;
  weight?: number;
  priority?: number;
}

export interface BatchRouterSummaryLike {
  strategy?: BatchRoutingStrategy;
  rateLimitEnabled?: boolean;
  accounts?: BatchAccountRef[];
  warnings?: string[];
}

/**
 * Structural router surface used by the batch runner. The core client exposes
 * `client.router` (an AccountRouter); this module also tolerates a `routing`
 * alias so wiring stays cheap.
 */
export interface BatchRouterLike {
  select(options: {
    workload: BatchWorkload;
    model?: string;
    excludeAccountIds?: string[];
  }): BatchAccountRef | undefined;
  summary?(): BatchRouterSummaryLike;
}

/** Result shape returned by client methods (routing fields added by core). */
export interface BatchClientResult {
  ok?: boolean;
  accountId?: string;
  poolId?: string;
  routing?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BatchClientLike {
  text: { complete(options: Record<string, unknown>): Promise<BatchClientResult> };
  image: { generate(options: Record<string, unknown>): Promise<BatchClientResult> };
  video: {
    generate(options: Record<string, unknown>): Promise<BatchClientResult>;
    poll(id: string, options?: Record<string, unknown>): Promise<BatchClientResult>;
  };
  router?: BatchRouterLike;
  routing?: BatchRouterLike;
}

/** A job after defaults merge and normalization (manifest/resolution unit). */
export interface EffectiveJob {
  index: number;
  id: string;
  kind: BatchJobKind;
  mode: string;
  prompt: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  size?: string;
  ratio?: string;
  seconds?: number;
  aspectRatio?: string;
  seed?: number;
  n?: number;
  ttl?: BatchTtl;
  image?: string;
  images?: string[];
  affinity: string;
  metadata?: Record<string, unknown>;
}

/** Normalized input document persisted to `<out>/input.json`. */
export interface NormalizedBatchInput {
  schema: "agnes-batch-input/1";
  version: 1;
  batchId: string;
  consistency: ConsistencyMode;
  strategy?: BatchRoutingStrategy;
  defaults: Record<string, unknown>;
  /** Original per-kind defaults section (provenance/reproducibility; optional). */
  defaultsByKind?: Partial<Record<BatchJobKind, Record<string, unknown>>>;
  jobs: EffectiveJob[];
}

export interface BatchManifestInput {
  path: string;
  sha256: string;
}

export interface BatchManifestConfig {
  consistency: ConsistencyMode;
  strategy?: BatchRoutingStrategy;
  concurrency: number;
  defaults: Record<string, unknown>;
  /** Optional per-kind defaults overrides from the input file. */
  defaultsByKind?: Partial<Record<BatchJobKind, Record<string, unknown>>>;
  defaultsDigest: string;
  maxAttempts: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface BatchJobError {
  code: string;
  message: string;
  ambiguous?: boolean;
  retryable?: boolean;
  httpStatus?: number;
  accountId?: string;
  details?: Record<string, unknown>;
}

export interface ManifestJobRecord {
  index: number;
  id: string;
  kind: BatchJobKind;
  mode: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  inputHash: string;
  status: BatchJobStatus;
  accountId?: string;
  poolId?: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown> | null;
  error?: BatchJobError | null;
  recoveredFrom?: "running";
  reason?: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  skipped: number;
  mixedAccounts: boolean;
  accountsUsed: string[];
  elapsedMs?: number;
}

export interface BatchManifest {
  schema: "agnes-batch/1";
  version: 1;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  input: BatchManifestInput;
  config: BatchManifestConfig;
  pinnedAccountId?: string;
  jobs: ManifestJobRecord[];
  summary: BatchSummary;
}

export type BatchEventType =
  | "batch_started"
  | "batch_resumed"
  | "batch_finished"
  | "job_started"
  | "job_succeeded"
  | "job_failed"
  | "job_retry"
  | "job_recovered";

export interface BatchEvent {
  ts: string;
  type: BatchEventType;
  batchId: string;
  jobId?: string;
  index?: number;
  status?: BatchJobStatus;
  accountId?: string;
  attempts?: number;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface BatchRunOptions {
  /** Raw input path (JSON object or JSONL). */
  inputPath: string;
  /** Output directory; created when needed. */
  outDir: string;
  concurrency?: number;
  consistency?: ConsistencyMode;
  strategy?: BatchRoutingStrategy;
  account?: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  resume?: boolean;
  force?: boolean;
  failFast?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Lower-priority defaults (from --model/--size/--ratio/--seconds/--ttl). */
  defaults?: Record<string, unknown>;
  /** Internal/testing knobs. */
  retryBackoffMs?: number;
}

export interface BatchRetryOptions {
  outDir: string;
  only?: BatchOnly;
  concurrency?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  failFast?: boolean;
  json?: boolean;
  /** Internal/testing knobs. */
  retryBackoffMs?: number;
}

export interface BatchStatusOptions {
  outDir: string;
  json?: boolean;
}

export interface BatchDeps {
  client: BatchClientLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  stderr?: (line: string) => void;
  /** Test/wiring hook overriding router-based account selection. */
  selectAccount?: (options: {
    workload: BatchWorkload;
    model?: string;
  }) => Promise<BatchAccountRef | undefined> | BatchAccountRef | undefined;
}

export interface BatchRunOutcome {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  manifest?: BatchManifest;
  /** Human/JSO-safe plan for --dry-run. */
  plan?: {
    ok: true;
    batchId: string;
    jobs: Array<{
      index: number;
      id: string;
      kind: BatchJobKind;
      mode: string;
      inputHash: string;
      affinity: string;
      accountId?: string;
      model?: string;
    }>;
    routePlan: { consistency: ConsistencyMode; strategy?: string; pinnedAccountId?: string };
  };
}

/** Public alias used by the `registerBatchCommands` wiring contract. */
export type AgnesClientLike = BatchClientLike;
