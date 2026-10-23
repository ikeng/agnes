/**
 * Batch runner (design contract: docs/multi-account-design.md §6).
 *
 * Responsibilities:
 *  - deterministic, bounded-concurrency scheduling with per-job isolation;
 *  - record (router-distributed) and strict (single pinned account) consistency;
 *  - create→poll affinity for video jobs;
 *  - resumable manifests (skip succeeded without new creates) and `retry`;
 *  - job-level retry with exponential backoff + jitter, never retrying
 *    ambiguous POST creates;
 *  - atomic artifacts with no key material.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgnesCliError, isAgnesCliError } from "../errors.js";
import {
  buildEffectiveJobs,
  buildNormalizedInput,
  digestOf,
  jobInputHash,
  parseBatchInputFile,
  parseNormalizedInput,
} from "./input.js";
import {
  batchLayout,
  BatchArtifactWriter,
  computeSummary,
  ensureArtifactDirs,
  generateBatchId,
  isoNow,
  prepareOutputDir,
  requireManifest,
  writeNormalizedInput,
  type BatchLayout,
} from "./manifest.js";
import type {
  BatchAccountRef,
  BatchRouteOptions,
  BatchRoutingStrategy,
  BatchClientLike,
  BatchClientResult,
  BatchDeps,
  BatchJobError,
  BatchManifest,
  BatchOnly,
  BatchRetryOptions,
  BatchRunOptions,
  BatchRunOutcome,
  BatchStatusOptions,
  BatchWorkload,
  ConsistencyMode,
  EffectiveJob,
  ManifestJobRecord,
} from "./types.js";

export interface BatchStatusJobView {
  index: number;
  id: string;
  kind: string;
  mode: string;
  model?: string;
  modelSource?: string;
  status: string;
  accountId?: string;
  poolId?: string;
  attempts: number;
  resultUrl?: string;
  error?: { code: string; message: string; ambiguous?: boolean } | null;
  startedAt?: string;
  finishedAt?: string;
}

export interface BatchStatusReport {
  ok: true;
  batchId: string;
  outDir: string;
  summary: BatchManifest["summary"];
  config: BatchManifest["config"];
  pinnedAccountId?: string;
  jobs: BatchStatusJobView[];
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const MAX_CONCURRENCY = 64;
const MAX_MAX_ATTEMPTS = 10;

interface NormalizedDeps {
  client: BatchClientLike;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  stderr: (line: string) => void;
  selectAccount?: BatchDeps["selectAccount"];
}

function normalizeDeps(deps: BatchDeps): NormalizedDeps {
  return {
    client: deps.client,
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
    random: deps.random ?? Math.random,
    stderr: deps.stderr ?? ((line) => console.error(line)),
    ...(deps.selectAccount ? { selectAccount: deps.selectAccount } : {}),
  };
}

interface VideoHandoff {
  pollId: string;
  accountId?: string;
  poolId?: string;
  model?: string;
  create: BatchClientResult;
}

class AttemptFailure extends Error {
  constructor(
    readonly step: "create" | "poll",
    readonly cause: unknown,
    readonly handoff?: VideoHandoff,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function runBatch(options: BatchRunOptions, deps: BatchDeps): Promise<BatchRunOutcome> {
  const d = normalizeDeps(deps);
  const runtime = resolveRuntimeOptions(options, d);
  const parsed = parseBatchInputFile(options.inputPath);
  const outDir = resolve(options.outDir);

  const existingManifest = options.resume ? requireManifest(outDir) : undefined;
  if (options.resume && !existingManifest) {
    throw new AgnesCliError(
      "BATCH_MANIFEST_MISSING",
      `--resume requires an existing batch in ${outDir} (manifest.json not found).`,
      { outDir },
      2,
    );
  }

  const batchId = existingManifest
    ? existingManifest.batchId
    : (parsed.batchId ?? generateBatchId(d.now(), d.random));
  if (existingManifest && parsed.batchId !== undefined && parsed.batchId !== existingManifest.batchId) {
    throw new AgnesCliError(
      "BATCH_BATCH_ID_MISMATCH",
      `Resume batchId mismatch: manifest has "${existingManifest.batchId}" but input file declares "${parsed.batchId}".`,
      { manifestBatchId: existingManifest.batchId, inputBatchId: parsed.batchId },
      2,
    );
  }

  const fallbackDefaults = options.defaults ?? {};
  const effectiveJobs = buildEffectiveJobs(parsed, { batchId, fallbackDefaults });
  const mergedDefaults: Record<string, unknown> = { ...fallbackDefaults, ...parsed.defaults };
  const defaultsByKind = parsed.defaultsByKind ?? {};
  const defaultsDigestPayload =
    Object.keys(defaultsByKind).length > 0 ? { defaults: mergedDefaults, defaultsByKind } : mergedDefaults;
  const defaultsDigest = digestOf(defaultsDigestPayload);

  let consistency: ConsistencyMode =
    options.account !== undefined
      ? "strict"
      : (options.consistency ?? parsed.consistency ?? "record");
  let strategy: BatchRoutingStrategy | undefined =
    options.strategy ?? readRouterSummary(d.client)?.strategy;
  if (existingManifest) {
    consistency = existingManifest.config.consistency;
    if (options.consistency !== undefined && options.consistency !== consistency) {
      throw new AgnesCliError(
        "BATCH_CONFIG_CHANGED",
        `Cannot resume with a different consistency mode: manifest=${consistency}, requested=${options.consistency}.`,
        { manifestConsistency: consistency, requestedConsistency: options.consistency },
        2,
      );
    }
    if (options.account !== undefined && existingManifest.config.consistency !== "strict") {
      throw new AgnesCliError(
        "BATCH_CONFIG_CHANGED",
        "Cannot resume with --account: the existing batch used record consistency. Resume it without --account, or start a new strict batch with --force.",
        { manifestConsistency: existingManifest.config.consistency },
        2,
      );
    }
    if (
      options.account !== undefined &&
      existingManifest.pinnedAccountId !== undefined &&
      options.account !== existingManifest.pinnedAccountId
    ) {
      throw new AgnesCliError(
        "BATCH_ACCOUNT_MISMATCH",
        `Cannot resume with a different pinned account: manifest=${existingManifest.pinnedAccountId}, requested=${options.account}.`,
        { pinnedAccountId: existingManifest.pinnedAccountId, requestedAccountId: options.account },
        2,
      );
    }
    if (existingManifest.config.defaultsDigest !== defaultsDigest) {
      throw new AgnesCliError(
        "BATCH_DEFAULTS_CHANGED",
        "Cannot resume: batch defaults changed since the first run (restore the original input/defaults or start a new batch with --force).",
        {
          manifestDefaultsDigest: existingManifest.config.defaultsDigest,
          requestedDefaultsDigest: defaultsDigest,
        },
        2,
      );
    }
    const manifestStrategy = existingManifest.config.strategy;
    if (manifestStrategy !== undefined && strategy !== undefined && manifestStrategy !== strategy) {
      throw new AgnesCliError(
        "BATCH_CONFIG_CHANGED",
        `Cannot resume with a different routing strategy: manifest=${manifestStrategy}, requested=${strategy}.`,
        { manifestStrategy, requestedStrategy: strategy },
        2,
      );
    }
    strategy = manifestStrategy;
  }

  const pinned = await resolvePinnedAccount({
    consistency,
    account: options.account,
    jobs: effectiveJobs,
    deps: d,
    resumeManifest: existingManifest,
  });

  if (options.dryRun) {
    return buildDryRun(effectiveJobs, batchId, consistency, strategy, pinned);
  }

  const layout = prepareOutputDir(outDir, { resume: options.resume, force: options.force });
  if (!options.resume) resetArtifacts(layout);

  const records = existingManifest
    ? resumeJobRecords(existingManifest, effectiveJobs, d)
    : effectiveJobs.map((job) =>
        newJobRecord(job, jobInputHash(job)),
      );

  const createdAt = existingManifest?.createdAt ?? isoNow(d.now);
  const manifest: BatchManifest = existingManifest ?? {
    schema: "agnes-batch/1",
    version: 1,
    batchId,
    createdAt,
    updatedAt: isoNow(d.now),
    input: { path: parsed.sourcePath, sha256: parsed.rawSha256 },
    config: {
      consistency,
      ...(strategy !== undefined ? { strategy } : {}),
      concurrency: runtime.concurrency,
      defaults: mergedDefaults,
      ...(Object.keys(defaultsByKind).length > 0 ? { defaultsByKind } : {}),
      defaultsDigest,
      maxAttempts: runtime.maxAttempts,
      pollIntervalMs: runtime.pollIntervalMs,
      pollTimeoutMs: runtime.pollTimeoutMs,
    },
    ...(pinned?.accountId !== undefined ? { pinnedAccountId: pinned.accountId } : {}),
    jobs: records,
    summary: computeSummary(records),
  };
  manifest.updatedAt = isoNow(d.now);
  manifest.jobs = records;
  manifest.summary = computeSummary(records);
  normalizeResumeMetadata(manifest, existingManifest, d);
  ensureArtifactDirs(layout);

  writeNormalizedInput(
    layout,
    buildNormalizedInput(batchId, consistency, strategy, mergedDefaults, effectiveJobs, parsed.defaultsByKind),
  );

  const store = new BatchArtifactWriter(layout);
  await store.persistManifest(manifest);
  await store.appendEvent({
    ts: isoNow(d.now),
    type: existingManifest ? "batch_resumed" : "batch_started",
    batchId,
    total: manifest.jobs.length,
    ...(existingManifest ? { recovered: countRecovered(manifest) } : {}),
  });
  logProgress(
    d,
    existingManifest
      ? `resuming ${batchId}: ${manifest.jobs.filter((job) => job.status === "pending").length} job(s) to run`
      : `starting ${batchId}: ${manifest.jobs.length} job(s), consistency=${consistency}, concurrency=${runtime.concurrency}`,
  );

  const outcome = await executeManifestJobs({
    deps: d,
    layout,
    store,
    manifest,
    jobs: effectiveJobs,
    pinned,
    consistency,
    strategy,
    options: {
      concurrency: options.concurrency ?? runtime.concurrency,
      maxAttempts: runtime.maxAttempts,
      pollIntervalMs: runtime.pollIntervalMs,
      pollTimeoutMs: runtime.pollTimeoutMs,
      failFast: options.failFast === true,
      retryBackoffMs: options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
      consistency,
      strategy,
    },
  });
  return outcome;
}

export async function retryBatch(options: BatchRetryOptions, deps: BatchDeps): Promise<BatchRunOutcome> {
  const d = normalizeDeps(deps);
  const layout = batchLayout(options.outDir);
  const manifest = requireManifest(layout.outDir);
  const only = normalizeOnly(options.only);
  const stored = readStoredInput(layout);

  const jobs = stored.jobs;
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const record of manifest.jobs) {
    const job = jobsById.get(record.id);
    if (!job) continue;
    const hash = jobInputHash(job);
    if (record.inputHash !== hash) {
      throw new AgnesCliError(
        "BATCH_INPUT_CHANGED",
        `Stored batch input for job "${record.id}" no longer matches the manifest (input hash changed). Start a new batch with --force instead of retrying.`,
        { jobId: record.id, manifestInputHash: record.inputHash, currentInputHash: hash },
        2,
      );
    }
  }

  const targetStatuses = new Set<string>(
    only === "failed" ? ["failed"] : only === "pending" ? ["pending", "running"] : ["failed", "pending", "running"],
  );
  const targets = manifest.jobs.filter((record) => {
    if (only === "all") return record.status !== "succeeded" && record.status !== "skipped";
    return targetStatuses.has(record.status);
  });
  for (const record of targets) {
    record.status = "pending";
    record.error = null;
    record.result = null;
    record.finishedAt = undefined;
  }

  const runtime = resolveRuntimeOptions(
    {
      concurrency: options.concurrency ?? manifest.config.concurrency,
      maxAttempts: options.maxAttempts ?? manifest.config.maxAttempts,
      pollIntervalMs: options.pollIntervalMs ?? manifest.config.pollIntervalMs,
      pollTimeoutMs: options.pollTimeoutMs ?? manifest.config.pollTimeoutMs,
    },
    d,
  );
  const consistency = manifest.config.consistency;
  const pinned =
    manifest.pinnedAccountId !== undefined
      ? { accountId: manifest.pinnedAccountId, poolId: undefined as string | undefined }
      : undefined;
  const store = new BatchArtifactWriter(layout);
  manifest.updatedAt = isoNow(d.now);
  manifest.summary = computeSummary(manifest.jobs);
  await store.persistManifest(manifest);
  await store.appendEvent({
    ts: isoNow(d.now),
    type: "batch_resumed",
    batchId: manifest.batchId,
    retryOnly: only,
    total: manifest.jobs.length,
  });
  logProgress(d, `retrying ${manifest.batchId} (--only ${only}): ${targets.length} job(s)`);

  const outcome = await executeManifestJobs({
    deps: d,
    layout,
    store,
    manifest,
    jobs,
    pinned,
    consistency,
    strategy: manifest.config.strategy,
    options: {
      concurrency: runtime.concurrency,
      maxAttempts: runtime.maxAttempts,
      pollIntervalMs: runtime.pollIntervalMs,
      pollTimeoutMs: runtime.pollTimeoutMs,
      failFast: options.failFast === true,
      retryBackoffMs: options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
      consistency,
      strategy: manifest.config.strategy,
      onlyRecords: new Set(targets.map((record) => record.id)),
    },
  });
  return outcome;
}

export async function batchStatus(options: BatchStatusOptions): Promise<BatchStatusReport> {
  const layout = batchLayout(options.outDir);
  const manifest = requireManifest(layout.outDir);
  return {
    ok: true,
    batchId: manifest.batchId,
    outDir: layout.outDir,
    summary: manifest.summary,
    config: manifest.config,
    ...(manifest.pinnedAccountId !== undefined ? { pinnedAccountId: manifest.pinnedAccountId } : {}),
    jobs: manifest.jobs.map((job) => ({
      index: job.index,
      id: job.id,
      kind: job.kind,
      mode: job.mode,
      ...(job.model !== undefined ? { model: job.model } : {}),
      ...(job.modelSource !== undefined ? { modelSource: job.modelSource } : {}),
      status: job.status,
      ...(job.accountId !== undefined ? { accountId: job.accountId } : {}),
      ...(job.poolId !== undefined ? { poolId: job.poolId } : {}),
      attempts: job.attempts,
      ...(extractResultUrl(job.result) !== undefined ? { resultUrl: extractResultUrl(job.result) } : {}),
      ...(job.error ? { error: { code: job.error.code, message: job.error.message, ...(job.error.ambiguous ? { ambiguous: true } : {}) } } : {}),
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Runtime option validation
// ---------------------------------------------------------------------------

interface RuntimeOptions {
  concurrency: number;
  maxAttempts: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

function resolveRuntimeOptions(
  options: Pick<
    BatchRunOptions,
    "concurrency" | "maxAttempts" | "pollIntervalMs" | "pollTimeoutMs"
  >,
  deps: NormalizedDeps,
): RuntimeOptions {
  const envInt = (name: string): number | undefined => {
    const raw = deps.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pollIntervalMs =
    options.pollIntervalMs ?? envInt("AGNES_POLL_INTERVAL_MS") ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs =
    options.pollTimeoutMs ?? envInt("AGNES_POLL_TIMEOUT_MS") ?? DEFAULT_POLL_TIMEOUT_MS;
  const issues: string[] = [];
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    issues.push(`--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_MAX_ATTEMPTS) {
    issues.push(`--max-attempts must be an integer between 1 and ${MAX_MAX_ATTEMPTS}`);
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    issues.push("--poll-interval must be a non-negative integer (milliseconds)");
  }
  if (!Number.isInteger(pollTimeoutMs) || pollTimeoutMs < 1) {
    issues.push("--poll-timeout must be a positive integer (milliseconds)");
  }
  if (issues.length > 0) {
    throw new AgnesCliError("INVALID_ARGUMENTS", issues.join("\n"), { issues }, 2);
  }
  return { concurrency, maxAttempts, pollIntervalMs, pollTimeoutMs };
}

function normalizeOnly(only: string | undefined): BatchOnly {
  const value = only ?? "failed";
  if (value !== "failed" && value !== "pending" && value !== "all") {
    throw new AgnesCliError(
      "INVALID_ARGUMENTS",
      `--only must be one of failed | pending | all (got ${value})`,
      undefined,
      2,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Consistency pinning
// ---------------------------------------------------------------------------

interface PinnedAccount {
  accountId: string;
  poolId?: string;
}

function readRouterSummary(client: BatchClientLike) {
  const router = client.router ?? client.routing;
  return router?.summary?.();
}

function eligibleAccountList(client: BatchClientLike): BatchAccountRef[] {
  return readRouterSummary(client)?.accounts ?? [];
}

async function resolvePinnedAccount(input: {
  consistency: ConsistencyMode;
  account: string | undefined;
  jobs: EffectiveJob[];
  deps: NormalizedDeps;
  resumeManifest?: BatchManifest;
}): Promise<PinnedAccount | undefined> {
  if (input.consistency !== "strict" && input.account === undefined) return undefined;
  if (input.account !== undefined) {
    const configured = eligibleAccountList(input.deps.client);
    const match = configured.find((account) => account.id === input.account);
    if (configured.length > 0) {
      if (!match) {
        throw new AgnesCliError(
          "INVALID_ARGUMENTS",
          `--account "${input.account}" is not in the configured account list (${configured.map((account) => account.id).join(", ")}).`,
          { accountId: input.account },
          2,
        );
      }
      return { accountId: match.id, ...(match.poolId !== undefined ? { poolId: match.poolId } : {}) };
    }
    const envAccounts = await loadEnvAccountsForSelection(input.deps);
    if (envAccounts.length > 0) {
      const envMatch = envAccounts.find((account) => account.id === input.account);
      if (!envMatch) {
        throw new AgnesCliError(
          "INVALID_ARGUMENTS",
          `--account "${input.account}" is not in the configured account list (${envAccounts.map((account) => account.id).join(", ")}).`,
          { accountId: input.account },
          2,
        );
      }
      return { accountId: envMatch.id, ...(envMatch.poolId !== undefined ? { poolId: envMatch.poolId } : {}) };
    }
    return { accountId: input.account };
  }

  // strict consistency chooses one account at batch start.
  if (input.resumeManifest?.pinnedAccountId !== undefined) {
    const configured = eligibleAccountList(input.deps.client).find(
      (account) => account.id === input.resumeManifest?.pinnedAccountId,
    );
    return {
      accountId: input.resumeManifest.pinnedAccountId,
      ...(configured?.poolId !== undefined ? { poolId: configured.poolId } : {}),
    };
  }
  const workload = pickStrictWorkload(input.jobs);
  const viaHook = await input.deps.selectAccount?.({ workload });
  if (viaHook) return { accountId: viaHook.id, ...(viaHook.poolId !== undefined ? { poolId: viaHook.poolId } : {}) };
  const router = input.deps.client.router ?? input.deps.client.routing;
  if (router?.select) {
    const selected = router.select({ workload });
    if (selected) {
      return { accountId: selected.id, ...(selected.poolId !== undefined ? { poolId: selected.poolId } : {}) };
    }
  }
  const envAccounts = await loadEnvAccountsForSelection(input.deps);
  if (envAccounts.length > 0) {
    const sorted = [...envAccounts].sort(
      (left, right) =>
        (left.priority ?? 0) - (right.priority ?? 0) ||
        (right.weight ?? 1) - (left.weight ?? 1) ||
        left.id.localeCompare(right.id),
    );
    return { accountId: sorted[0].id, ...(sorted[0].poolId !== undefined ? { poolId: sorted[0].poolId } : {}) };
  }
  throw new AgnesCliError(
    "BATCH_STRICT_UNAVAILABLE",
    "strict consistency requires at least one configured account; configure AGNES_API_KEY or AGNES_ACCOUNT_<ID>_KEY, or pass --account.",
    { consistency: "strict" },
    2,
  );
}

function pickStrictWorkload(jobs: EffectiveJob[]): BatchWorkload {
  if (jobs.some((job) => job.kind === "image")) return "image";
  if (jobs.some((job) => job.kind === "video")) return "video";
  return "text";
}

interface EnvAccountRef extends BatchAccountRef {
  priority?: number;
  weight?: number;
}

/**
 * Best-effort account list from the core env config, used only when the client
 * does not expose a router (e.g. very early wiring). The specifier is dynamic
 * so this module stays buildable before cli/src/accounts/ exists.
 */
async function loadEnvAccountsForSelection(deps: NormalizedDeps): Promise<EnvAccountRef[]> {
  const specifier: string = "../accounts/config.js";
  try {
    const module = (await import(specifier)) as {
      loadAccountsConfig?: (env: NodeJS.ProcessEnv) => {
        accounts?: Array<{
          id: string;
          poolId?: string;
          type?: string;
          weight?: number;
          priority?: number;
        }>;
      };
    };
    if (typeof module.loadAccountsConfig !== "function") return [];
    const config = module.loadAccountsConfig(deps.env);
    return (config.accounts ?? []).map((account) => ({
      id: account.id,
      ...(account.poolId !== undefined ? { poolId: account.poolId } : {}),
      ...(account.type !== undefined ? { type: account.type } : {}),
      ...(account.weight !== undefined ? { weight: account.weight } : {}),
      ...(account.priority !== undefined ? { priority: account.priority } : {}),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Manifest / resume bookkeeping
// ---------------------------------------------------------------------------

function newJobRecord(job: EffectiveJob, inputHash: string): ManifestJobRecord {
  return {
    index: job.index,
    id: job.id,
    kind: job.kind,
    mode: job.mode,
    ...(job.model !== undefined ? { model: job.model } : {}),
    ...(job.modelSource !== undefined ? { modelSource: job.modelSource } : {}),
    inputHash,
    status: "pending",
    attempts: 0,
    result: null,
    error: null,
  };
}

function resumeJobRecords(
  manifest: BatchManifest,
  jobs: EffectiveJob[],
  deps: NormalizedDeps,
): ManifestJobRecord[] {
  const existingById = new Map(manifest.jobs.map((record) => [record.id, record]));
  const records: ManifestJobRecord[] = [];
  for (const job of jobs) {
    const hash = jobInputHash(job);
    const existing = existingById.get(job.id);
    if (!existing) {
      records.push(newJobRecord(job, hash));
      continue;
    }
    if (existing.status === "succeeded" || existing.status === "skipped") {
      if (existing.inputHash !== hash) {
        throw new AgnesCliError(
          "BATCH_INPUT_CHANGED",
          `Cannot resume: input for job "${job.id}" changed since it succeeded (input hash differs). Restore the original job definition or start a new batch with --force.`,
          { jobId: job.id, manifestInputHash: existing.inputHash, currentInputHash: hash },
          2,
        );
      }
      records.push({ ...existing, index: job.index, kind: job.kind, mode: job.mode });
      continue;
    }
    const recoveredFromRunning = existing.status === "running";
    if (recoveredFromRunning) {
      // A create may have been accepted before the previous process died.
      deps.stderr(
        `warning: job "${job.id}" was running when the previous batch process stopped; recovering it as pending. A create request may have been accepted (and billed) before the interruption: verify in the Agnes console to avoid duplicate work.`,
      );
    }
    records.push({
      ...newJobRecord(job, hash),
      attempts: existing.attempts,
      ...(recoveredFromRunning ? { recoveredFrom: "running" as const } : {}),
      startedAt: undefined,
      finishedAt: undefined,
      result: null,
      error: null,
      status: "pending",
    });
  }
  const currentIds = new Set(jobs.map((job) => job.id));
  for (const record of manifest.jobs) {
    if (currentIds.has(record.id)) continue;
    records.push({
      ...record,
      status: "skipped",
      reason: "removed_from_input",
      finishedAt: isoNow(deps.now),
    });
  }
  return records;
}

function normalizeResumeMetadata(
  manifest: BatchManifest,
  existing: BatchManifest | undefined,
  deps: NormalizedDeps,
): void {
  manifest.updatedAt = isoNow(deps.now);
  if (existing) {
    // Preserve config pins from the original run.
    manifest.config = existing.config;
    manifest.createdAt = existing.createdAt;
    manifest.input = existing.input;
    if (existing.pinnedAccountId !== undefined) manifest.pinnedAccountId = existing.pinnedAccountId;
  }
}

function countRecovered(manifest: BatchManifest): number {
  return manifest.jobs.filter((job) => job.recoveredFrom === "running").length;
}

function resetArtifacts(layout: BatchLayout): void {
  for (const path of [layout.manifestPath, layout.inputPath, layout.eventsPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  if (existsSync(layout.resultsDir)) {
    for (const entry of readdirSync(layout.resultsDir)) {
      if (entry.endsWith(".json")) rmSync(join(layout.resultsDir, entry), { force: true });
    }
  }
}

function readStoredInput(layout: BatchLayout): { jobs: EffectiveJob[] } {
  if (!existsSync(layout.inputPath)) {
    throw new AgnesCliError(
      "BATCH_INPUT_MISSING",
      `Stored batch input not found: ${layout.inputPath}. Retry requires the normalized input saved by the first run.`,
      { path: layout.inputPath },
      2,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(layout.inputPath, "utf8"));
  } catch (error) {
    throw new AgnesCliError(
      "BATCH_INPUT_INVALID",
      `Stored batch input is not valid JSON: ${layout.inputPath}`,
      { path: layout.inputPath, cause: error instanceof Error ? error.message : String(error) },
      2,
    );
  }
  const stored = parseNormalizedInput(parsed);
  return { jobs: stored.jobs };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

interface ExecuteJobsOptions {
  concurrency: number;
  maxAttempts: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  failFast: boolean;
  retryBackoffMs: number;
  consistency: ConsistencyMode;
  strategy?: string;
  onlyRecords?: Set<string>;
}

interface ExecuteContext {
  deps: NormalizedDeps;
  layout: BatchLayout;
  store: BatchArtifactWriter;
  manifest: BatchManifest;
  jobsById: Map<string, EffectiveJob>;
  pinned?: PinnedAccount;
  options: ExecuteJobsOptions;
  batchId: string;
  stopped: boolean;
}

async function executeManifestJobs(input: {
  deps: NormalizedDeps;
  layout: BatchLayout;
  store: BatchArtifactWriter;
  manifest: BatchManifest;
  jobs: EffectiveJob[];
  pinned?: PinnedAccount;
  consistency: ConsistencyMode;
  strategy?: string;
  options: ExecuteJobsOptions;
}): Promise<BatchRunOutcome> {
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  const runnable = input.manifest.jobs.filter(
    (record) =>
      record.status === "pending" &&
      (input.options.onlyRecords === undefined || input.options.onlyRecords.has(record.id)),
  );
  const ctx: ExecuteContext = {
    deps: input.deps,
    layout: input.layout,
    store: input.store,
    manifest: input.manifest,
    jobsById,
    ...(input.pinned ? { pinned: input.pinned } : {}),
    options: input.options,
    batchId: input.manifest.batchId,
    stopped: false,
  };
  const startedAt = Date.now();

  const workerCount = Math.min(Math.max(1, input.options.concurrency), Math.max(1, runnable.length));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!ctx.stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= runnable.length) return;
      const record = runnable[index];
      const job = jobsById.get(record.id);
      if (!job) {
        record.status = "failed";
        record.error = {
          code: "BATCH_INPUT_INVALID",
          message: `No job definition found for manifest job "${record.id}".`,
        };
        record.finishedAt = isoNow(ctx.deps.now);
        await ctx.store.persistManifest(ctx.manifest);
        return;
      }
      await executeJob(ctx, record, job);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const summary = computeSummary(input.manifest.jobs, Date.now() - startedAt);
  input.manifest.summary = summary;
  input.manifest.updatedAt = isoNow(ctx.deps.now);
  await ctx.store.persistManifest(input.manifest);
  await ctx.store.appendEvent({
    ts: isoNow(ctx.deps.now),
    type: "batch_finished",
    batchId: input.manifest.batchId,
    summary,
  });
  const ok = summary.failed === 0 && summary.pending === 0;
  logProgress(
    input.deps,
    `finished ${input.manifest.batchId}: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed, ${summary.pending} pending` +
      (summary.mixedAccounts ? ` (mixed accounts: ${summary.accountsUsed.join(", ")})` : ""),
  );
  return {
    ok,
    exitCode: ok ? 0 : 1,
    manifest: input.manifest,
  };
}

async function executeJob(ctx: ExecuteContext, record: ManifestJobRecord, job: EffectiveJob): Promise<void> {
  const label = `[${record.index + 1}/${ctx.manifest.jobs.length}] ${job.id}`;
  let handoff: VideoHandoff | undefined;
  record.status = "running";
  record.startedAt = record.startedAt ?? isoNow(ctx.deps.now);
  record.finishedAt = undefined;
  record.error = null;
  record.model = job.model;
  record.modelSource = job.modelSource;
  record.attempts += 1;
  await ctx.store.persistManifest(ctx.manifest);
  await ctx.store.appendEvent({
    ts: isoNow(ctx.deps.now),
    type: "job_started",
    batchId: ctx.batchId,
    jobId: job.id,
    index: record.index,
    attempts: record.attempts,
  });
  logProgress(ctx.deps, `${label} started (${job.kind} ${job.mode})`);
  const startedAt = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await executeAttempt(ctx, job, handoff);
      record.status = "succeeded";
      record.result = result.result;
      if (result.accountId !== undefined) record.accountId = result.accountId;
      if (result.poolId !== undefined) record.poolId = result.poolId;
      record.finishedAt = isoNow(ctx.deps.now);
      record.error = null;
      await ctx.store.writeJobResult(record, ctx.batchId);
      await ctx.store.persistManifest(ctx.manifest);
      await ctx.store.appendEvent({
        ts: isoNow(ctx.deps.now),
        type: "job_succeeded",
        batchId: ctx.batchId,
        jobId: job.id,
        index: record.index,
        status: "succeeded",
        ...(record.accountId !== undefined ? { accountId: record.accountId } : {}),
        attempts: record.attempts,
      });
      logProgress(
        ctx.deps,
        `${label} succeeded (${record.accountId !== undefined ? `account=${record.accountId}, ` : ""}${Date.now() - startedAt}ms)`,
      );
      return;
    } catch (error) {
      const failure = classifyJobFailure(error, job.id);
      const strictFatal =
        ctx.options.consistency === "strict" && isStrictFatalFailure(failure.error);
      if (strictFatal) {
        failure.retryable = false;
        const pinnedAccount = ctx.pinned?.accountId ?? "unknown";
        failure.error = {
          ...failure.error,
          message: `strict consistency cannot be satisfied on pinned account "${pinnedAccount}": ${failure.error.message}`,
          details: { ...(failure.error.details ?? {}), strictConsistency: true, pinnedAccountId: pinnedAccount },
        };
      }
      if (failure.retryable && record.attempts < ctx.options.maxAttempts) {
        const delay = backoffDelay(record.attempts, ctx.options.retryBackoffMs, ctx.deps.random());
        logProgress(
          ctx.deps,
          `${label} retry ${record.attempts}/${ctx.options.maxAttempts} after ${failure.error.code} (delay ${delay}ms)`,
        );
        await ctx.store.appendEvent({
          ts: isoNow(ctx.deps.now),
          type: "job_retry",
          batchId: ctx.batchId,
          jobId: job.id,
          index: record.index,
          code: failure.error.code,
          attempts: record.attempts,
          delayMs: delay,
        });
        if (failure.handoff) handoff = failure.handoff;
        record.attempts += 1;
        await ctx.store.persistManifest(ctx.manifest);
        await ctx.deps.sleep(delay);
        continue;
      }
      record.status = "failed";
      record.error = failure.error;
      record.finishedAt = isoNow(ctx.deps.now);
      await ctx.store.persistManifest(ctx.manifest);
      await ctx.store.appendEvent({
        ts: isoNow(ctx.deps.now),
        type: "job_failed",
        batchId: ctx.batchId,
        jobId: job.id,
        index: record.index,
        status: "failed",
        code: failure.error.code,
        message: failure.error.message,
        ...(failure.error.ambiguous ? { ambiguous: true } : {}),
        attempts: record.attempts,
      });
      logProgress(ctx.deps, `${label} failed: ${failure.error.code}${failure.error.ambiguous ? " (AMBIGUOUS - not retried)" : ""}`);
      if (ctx.options.failFast || strictFatal) ctx.stopped = true;
      return;
    }
  }
}

interface AttemptSuccess {
  result: Record<string, unknown>;
  accountId?: string;
  poolId?: string;
}

async function executeAttempt(
  ctx: ExecuteContext,
  job: EffectiveJob,
  handoff: VideoHandoff | undefined,
): Promise<AttemptSuccess> {
  if (job.kind === "text") {
    const response = await step("create", () =>
      ctx.deps.client.text.complete({
        prompt: job.prompt,
        ...(job.model !== undefined ? { model: job.model } : {}),
        route: buildRoute(ctx, job, "text"),
      }),
    );
    return extractSuccess(response, ctx, job);
  }
  if (job.kind === "image") {
    const response = await step("create", () =>
      ctx.deps.client.image.generate({
        mode: job.mode,
        prompt: job.prompt,
        ...(job.model !== undefined ? { model: job.model } : {}),
        ...(job.size !== undefined ? { size: job.size } : {}),
        ...(job.ratio !== undefined ? { ratio: job.ratio } : {}),
        ...(job.seed !== undefined ? { seed: job.seed } : {}),
        ...(job.image !== undefined ? { image: job.image } : {}),
        ...(job.images !== undefined ? { images: job.images } : {}),
        ...(job.ttl !== undefined ? { ttl: job.ttl } : {}),
        route: buildRoute(ctx, job, "image"),
      }),
    );
    return extractSuccess(response, ctx, job);
  }

  // video: create once, then poll on the same account (affinity).
  let activeHandoff = handoff;
  if (!activeHandoff) {
    const created = await step("create", () =>
      ctx.deps.client.video.generate({
        mode: job.mode,
        prompt: job.prompt,
        ...(job.model !== undefined ? { model: job.model } : {}),
        ...(job.seconds !== undefined ? { seconds: job.seconds } : {}),
        ...(job.size !== undefined ? { size: job.size } : {}),
        ...(job.aspectRatio !== undefined ? { aspectRatio: job.aspectRatio } : {}),
        ...(job.n !== undefined ? { n: job.n } : {}),
        ...(job.seed !== undefined ? { seed: job.seed } : {}),
        ...(job.image !== undefined ? { image: job.image } : {}),
        ...(job.images !== undefined ? { images: job.images } : {}),
        ...(job.ttl !== undefined ? { ttl: job.ttl } : {}),
        route: buildRoute(ctx, job, "video"),
      }),
    );
    const pollId =
      typeof created.videoId === "string"
        ? created.videoId
        : typeof created.taskId === "string"
          ? created.taskId
          : undefined;
    if (!pollId) {
      throw new AttemptFailure(
        "create",
        new AgnesCliError("INVALID_RESPONSE", "Agnes video create response did not include a videoId/taskId.", {
          raw: undefined,
        }),
      );
    }
    const createAccountId =
      typeof created.accountId === "string" ? created.accountId : ctx.pinned?.accountId;
    const createPoolId = typeof created.poolId === "string" ? created.poolId : ctx.pinned?.poolId;
    activeHandoff = {
      pollId,
      ...(createAccountId !== undefined ? { accountId: createAccountId } : {}),
      ...(createPoolId !== undefined ? { poolId: createPoolId } : {}),
      ...(typeof created.model === "string" ? { model: created.model } : {}),
      create: created,
    };
  }
  const pollRoute = buildRoute(ctx, job, "status");
  if (activeHandoff.accountId !== undefined) pollRoute.accountId = activeHandoff.accountId;
  if (activeHandoff.accountId === undefined && ctx.pinned !== undefined) {
    pollRoute.accountId = ctx.pinned.accountId;
  }
  const modelName = activeHandoff.model ?? job.model;
  const polled = await step(
    "poll",
    () =>
      ctx.deps.client.video.poll(activeHandoff.pollId, {
        ...(modelName !== undefined ? { modelName } : {}),
        intervalSeconds: Math.max(0, ctx.options.pollIntervalMs) / 1000,
        timeoutSeconds: Math.max(1, ctx.options.pollTimeoutMs) / 1000,
        route: pollRoute,
      }),
    activeHandoff,
  );
  const result = sanitizeResult(polled);
  result.create = sanitizeResult(activeHandoff.create);
  const accountId =
    (typeof result.accountId === "string" ? result.accountId : undefined) ??
    activeHandoff.accountId ??
    ctx.pinned?.accountId;
  return {
    result,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(activeHandoff.poolId !== undefined ? { poolId: activeHandoff.poolId } : {}),
  };
}

async function step<T>(
  stepName: "create" | "poll",
  fn: () => Promise<T>,
  handoff?: VideoHandoff,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new AttemptFailure(stepName, error, handoff);
  }
}

function buildRoute(ctx: ExecuteContext, job: EffectiveJob, phase: "create" | "status" | BatchWorkload): BatchRouteOptions {
  const workload: BatchWorkload =
    phase === "create" ? job.kind : phase === "status" ? "status" : phase;
  const route: BatchRouteOptions = {
    affinityKey: job.affinity,
    workload,
    ...(job.model !== undefined ? { model: job.model } : {}),
    ...(ctx.options.strategy !== undefined ? { strategy: ctx.options.strategy as BatchRouteOptions["strategy"] } : {}),
  };
  if (job.kind === "image" && job.size !== undefined) {
    route.size = job.size;
  }
  if (ctx.pinned !== undefined) {
    route.accountId = ctx.pinned.accountId;
    if (ctx.pinned.poolId !== undefined) route.poolId = ctx.pinned.poolId;
  }
  return route;
}

function extractSuccess(
  response: BatchClientResult,
  ctx: ExecuteContext,
  job: EffectiveJob,
): AttemptSuccess {
  if (!response || typeof response !== "object") {
    throw new AgnesCliError("INVALID_RESPONSE", "Agnes client returned a non-object result.", undefined);
  }
  if (response.ok === false) {
    throw new AgnesCliError("REQUEST_FAILED", "Agnes client reported a failed request.", undefined);
  }
  const accountId =
    typeof response.accountId === "string" ? response.accountId : ctx.pinned?.accountId;
  const poolId = typeof response.poolId === "string" ? response.poolId : ctx.pinned?.poolId;
  if (job.kind === "image" && typeof response.url !== "string") {
    throw new AgnesCliError("INVALID_RESPONSE", "Agnes image result did not include a URL.", undefined);
  }
  if (job.kind === "text" && typeof response.text !== "string") {
    throw new AgnesCliError("INVALID_RESPONSE", "Agnes text result did not include text.", undefined);
  }
  return {
    result: sanitizeResult(response),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(poolId !== undefined ? { poolId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Failure classification / retry policy
// ---------------------------------------------------------------------------

interface ClassifiedFailure {
  error: BatchJobError;
  retryable: boolean;
  handoff?: VideoHandoff;
}

function classifyJobFailure(failure: unknown, jobId?: string): ClassifiedFailure {
  if (!(failure instanceof AttemptFailure)) {
    const zodIssues = extractZodIssues(failure);
    if (zodIssues) {
      return invalidJobFailure(jobId, formatZodIssues(zodIssues), zodIssues);
    }
    return {
      error: {
        code: "UNEXPECTED_ERROR",
        message: failure instanceof Error ? failure.message : String(failure),
      },
      retryable: false,
    };
  }
  const error = failure.cause;
  const zodIssues = extractZodIssues(error);
  if (zodIssues) {
    return invalidJobFailure(jobId, formatZodIssues(zodIssues), zodIssues);
  }
  const detailed = isAgnesCliError(error);
  const code = detailed ? error.code : "UNEXPECTED_ERROR";
  const message = detailed ? error.message : error instanceof Error ? error.message : String(error);
  const details = detailed && error.details && typeof error.details === "object"
    ? (error.details as Record<string, unknown>)
    : {};
  const httpStatus = typeof details.httpStatus === "number" ? details.httpStatus : undefined;
  const sanitizedDetails = sanitizeResult(details);

  // Local request-validation failures (bad model/size/param for the job kind)
  // are user errors scoped to one job: never retry them, never call them
  // UNEXPECTED_ERROR.
  if (
    detailed &&
    code !== "INVALID_RESPONSE" &&
    code !== "INVALID_JOB" &&
    code.startsWith("INVALID_")
  ) {
    return {
      error: {
        code: "INVALID_JOB",
        message: `job "${jobId ?? "(unknown)"}": ${message}`,
        retryable: false,
        details: { ...sanitizedDetails, originalCode: code },
      },
      retryable: false,
    };
  }

  const base: BatchJobError = {
    code,
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(Object.keys(sanitizedDetails).length > 0 ? { details: sanitizedDetails } : {}),
  };

  // POST create failures that may have been accepted server-side must never be
  // retried: a retry could duplicate (and double-bill) the task.
  if (
    failure.step === "create" &&
    (code === "AMBIGUOUS_CREATE" ||
      code === "NETWORK_ERROR" ||
      (code === "AGNES_REQUEST_FAILED" && (httpStatus === undefined || httpStatus >= 500)))
  ) {
    return {
      error: {
        ...base,
        code: "AMBIGUOUS_CREATE",
        message: `${message} The create request may have been accepted (and billed) by Agnes before the failure. It was NOT retried automatically; verify the task in the Agnes console before retrying this job.`,
        ambiguous: true,
        retryable: false,
      },
      retryable: false,
    };
  }

  const retryableCodes = new Set([
    "RATE_LIMITED",
    "SERVICE_BUSY",
    "POLL_TIMEOUT",
    "NETWORK_ERROR",
  ]);
  let retryable = retryableCodes.has(code);
  if (code === "AGNES_REQUEST_FAILED" && httpStatus !== undefined) {
    retryable = httpStatus === 429 || httpStatus >= 500;
  }
  if (failure.step === "poll" && code === "RATE_LIMITED") retryable = true;
  if (failure.step === "create" && code === "NETWORK_ERROR") retryable = false;
  return {
    error: { ...base, retryable },
    retryable,
    ...(failure.handoff !== undefined ? { handoff: failure.handoff } : {}),
  };
}

interface ZodIssueLike {
  path?: Array<string | number>;
  message: string;
}

function extractZodIssues(error: unknown): ZodIssueLike[] | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { name?: string; constructor?: { name?: string }; issues?: unknown };
  const isZod =
    candidate.name === "ZodError" || candidate.constructor?.name === "ZodError";
  if (!isZod || !Array.isArray(candidate.issues)) return undefined;
  return candidate.issues
    .filter((issue): issue is ZodIssueLike => Boolean(issue) && typeof issue === "object" && typeof (issue as ZodIssueLike).message === "string")
    .map((issue) => ({
      ...(Array.isArray(issue.path) ? { path: issue.path.filter((part) => typeof part === "string" || typeof part === "number") as Array<string | number> } : {}),
      message: issue.message,
    }));
}

function formatZodIssues(issues: ZodIssueLike[]): string {
  const rendered = issues.slice(0, 5).map((issue) => {
    const path = issue.path && issue.path.length > 0 ? issue.path.map(String).join(".") : "options";
    return `${path}: ${issue.message}`;
  });
  const suffix = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  const text = rendered.join("; ") + suffix;
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function invalidJobFailure(
  jobId: string | undefined,
  detail: string,
  issues: ZodIssueLike[],
): ClassifiedFailure {
  return {
    error: {
      code: "INVALID_JOB",
      message: `job "${jobId ?? "(unknown)"}": invalid request options: ${detail}`,
      retryable: false,
      details: {
        issues: issues.slice(0, 10).map((issue) => ({
          ...(issue.path ? { path: issue.path.map(String) } : {}),
          message: issue.message,
        })),
      },
    },
    retryable: false,
  };
}

const STRICT_FATAL_CODES = new Set([
  "ACCOUNT_AUTH_FAILED",
  "AUTH_FAILED",
  "AUTH_MISSING",
  "QUOTA_EXHAUSTED",
  "MODEL_NOT_ALLOWED",
]);

/** 401/402/403 in strict mode: the pinned account can never satisfy the batch. */
function isStrictFatalFailure(error: BatchJobError): boolean {
  if (STRICT_FATAL_CODES.has(error.code)) return true;
  return error.httpStatus === 401 || error.httpStatus === 402 || error.httpStatus === 403;
}

function backoffDelay(attempt: number, baseMs: number, random: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 30_000);
  const jitter = Math.min(250, exponential * 0.25) * Math.max(0, Math.min(1, random));
  return Math.round(exponential + jitter);
}

// ---------------------------------------------------------------------------
// Artifact sanitization (no secrets, no transport bodies)
// ---------------------------------------------------------------------------

function sanitizeResult(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    const record = sanitized as Record<string, unknown>;
    if (record.raw !== undefined) delete record.raw;
    return record;
  }
  return {};
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:api[_-]?key|key|authorization|token|secret|password)$/i.test(key)) continue;
      if (key === "raw" && depth === 0) continue;
      result[key] = sanitizeValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function redactSecretsInString(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function extractResultUrl(result: Record<string, unknown> | null | undefined): string | undefined {
  if (!result) return undefined;
  for (const key of ["videoUrl", "url"]) {
    const value = result[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

function buildDryRun(
  jobs: EffectiveJob[],
  batchId: string,
  consistency: ConsistencyMode,
  strategy: string | undefined,
  pinned: PinnedAccount | undefined,
): BatchRunOutcome {
  return {
    ok: true,
    exitCode: 0,
    plan: {
      ok: true,
      batchId,
      jobs: jobs.map((job) => ({
        index: job.index,
        id: job.id,
        kind: job.kind,
        mode: job.mode,
        inputHash: jobInputHash(job),
        affinity: job.affinity,
        ...(pinned !== undefined ? { accountId: pinned.accountId } : {}),
        ...(job.model !== undefined ? { model: job.model } : {}),
      })),
      routePlan: {
        consistency,
        ...(strategy !== undefined ? { strategy } : {}),
        ...(pinned !== undefined ? { pinnedAccountId: pinned.accountId } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logProgress(deps: NormalizedDeps, line: string): void {
  deps.stderr(`[batch] ${line}`);
}
